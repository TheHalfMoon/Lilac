import { createHash, randomUUID, type Hash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOCUMENT_FIELDS, DOCUMENT_SCHEMA_VERSION, NODE_FIELDS, cloneDocument, normalizeDocument, validateDocument } from "@lilac/document-model";
import { applyTransaction, createTransaction } from "@lilac/history";
import { canonicalJson } from "./canonical.ts";
import { PersistenceCorruptionError, PersistenceLockError, PersistenceValidationError, PersistenceVersionError } from "./errors.ts";
import {
  appendDurable,
  assertNotSymlink,
  atomicWrite,
  createExclusive,
  directoryIdentity,
  type DirectoryIdentity,
  fileIdentity,
  type FileIdentity,
  fsyncDirectory,
  isSameDirectory,
  projectDirectory,
  readBounded,
  removeFile,
  isFilesystemError,
  removeStaleFiles,
  removeStaleTemporaries,
} from "./fsio.ts";
import { assertJournalFormat, encodeJournalLine, genesisDigest, parseJournal, type ParsedJournal } from "./journal.ts";
import { LEGACY_PROJECT_DIRECTORY } from "./legacy.ts";
import { PROJECT_MIGRATIONS, migrateManifest, withBuiltInMigrations, type ManifestMigration } from "./migrations.ts";
import { getObject, putObject } from "./objects.ts";
import {
  JOURNAL_GENESIS,
  JOURNAL_GENESIS_DOMAINS,
  PERSISTENCE_LIMITS,
  PROJECT_FILES,
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  type LockOverride,
  type LockRecord,
  type ProjectManifest,
  type RecoveryReport,
  type SnapshotRef,
} from "./types.ts";

// Documents are JSON graphs produced by @lilac/document-model; typed loosely here because
// that package is plain JavaScript.
type LilacDocument = { id: string; revision: number } & Record<string, unknown>;

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_LOCK_BYTES = 8192;
const STORE_TOKEN = Symbol("ProjectStore");

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new PersistenceValidationError(`${label} must be a stable identifier`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new PersistenceValidationError(`${label} must be an ISO-8601 timestamp`);
  }
}

function paths(projectDir: string) {
  return {
    manifest: join(projectDir, PROJECT_FILES.manifest),
    snapshot: join(projectDir, PROJECT_FILES.snapshot),
    journal: join(projectDir, PROJECT_FILES.journal),
    lock: join(projectDir, PROJECT_FILES.lock),
  };
}

function parseJsonFile(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new PersistenceCorruptionError(`${label} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PersistenceCorruptionError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function readJsonFile(path: string, label: string, maxBytes: number = PERSISTENCE_LIMITS.maxManifestBytes, options: { singleLink?: boolean } = {}): Record<string, unknown> {
  const bytes = readBounded(path, maxBytes, label, options);
  if (bytes === null) throw new PersistenceCorruptionError(`${label} is missing`);
  return parseJsonFile(bytes, label);
}

function readManifest(record: Record<string, unknown>): ProjectManifest {
  if (record.format !== PROJECT_FORMAT) throw new PersistenceCorruptionError("manifest is not a Ninerr project manifest");
  for (const key of Object.keys(record)) {
    if (!["format", "schemaVersion", "projectId", "documentId", "createdAt", "journalGenesis"].includes(key)) {
      throw new PersistenceCorruptionError(`manifest contains unsupported field ${JSON.stringify(key).slice(0, 80)}`);
    }
  }
  if (!(JOURNAL_GENESIS_DOMAINS as readonly unknown[]).includes(record.journalGenesis)) {
    throw new PersistenceCorruptionError("manifest.journalGenesis is not a known journal genesis domain");
  }
  try {
    assertId(record.projectId, "manifest.projectId");
    assertId(record.documentId, "manifest.documentId");
    assertTimestamp(record.createdAt, "manifest.createdAt");
  } catch (error) {
    throw new PersistenceCorruptionError((error as Error).message);
  }
  return record as unknown as ProjectManifest;
}

function readSnapshot(record: Record<string, unknown>): SnapshotRef {
  const { revision, documentObject, journalSeq, chainDigest } = record;
  if (
    !Number.isSafeInteger(revision) || (revision as number) < 0
    || typeof documentObject !== "string" || !DIGEST.test(documentObject)
    || !Number.isSafeInteger(journalSeq) || (journalSeq as number) < 0
    || typeof chainDigest !== "string" || !DIGEST.test(chainDigest)
    || Object.keys(record).length !== 4
  ) {
    throw new PersistenceCorruptionError("snapshot reference is malformed");
  }
  return { revision: revision as number, documentObject, journalSeq: journalSeq as number, chainDigest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DOCUMENT_FIELD_SET: ReadonlySet<string> = new Set(DOCUMENT_FIELDS);
const NODE_FIELD_SET: ReadonlySet<string> = new Set(NODE_FIELDS);

function documentVersionProblem(record: unknown): string | null {
  if (!isRecord(record)) return null; // validation reports the shape
  const version = record.schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 0) return "has a schemaVersion that is not a non-negative integer";
  if (version !== DOCUMENT_SCHEMA_VERSION) {
    return (version as number) > DOCUMENT_SCHEMA_VERSION
      ? `is document schema ${version}, newer than supported schema ${DOCUMENT_SCHEMA_VERSION}`
      : `is document schema ${version}; no migration from document schema ${version}`;
  }
  const extra = (value: Record<string, unknown>, allowed: ReadonlySet<string>) => Object.keys(value).find((key) => !allowed.has(key));
  const field = extra(record, DOCUMENT_FIELD_SET);
  if (field !== undefined) return `has field ${JSON.stringify(field).slice(0, 80)}, which document schema 1 does not have`;
  if (!isRecord(record.nodes)) return null;
  for (const node of Object.values(record.nodes)) {
    const nodeField = isRecord(node) ? extra(node, NODE_FIELD_SET) : undefined;
    if (nodeField !== undefined) return `has node field ${JSON.stringify(nodeField).slice(0, 80)}, which document schema 1 does not have`;
  }
  return null;
}

function loadDocument(projectDir: string, digest: string): LilacDocument {
  const record = parseJsonFile(getObject(projectDir, digest), `document object ${digest}`);
  // The object's bytes already match its content hash, so a document this release does not
  // read (another schema version, or fields schema 1 lacks) is a version mismatch, as for the
  // manifest, not corruption.
  const problem = documentVersionProblem(record);
  if (problem !== null) throw new PersistenceVersionError(`document object ${digest} ${problem}`);
  try {
    validateDocument(record);
    return normalizeDocument(record) as LilacDocument;
  } catch (error) {
    throw new PersistenceCorruptionError(`document object ${digest} is not a valid document: ${(error as Error).message.slice(0, 200)}`);
  }
}

/** Round-trip a value through canonical JSON, so in-memory state equals what replay will produce. */
function persisted<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/**
 * Exact equality of two plain JSON-shaped values: the same keys in the same order, and
 * Object.is on every leaf.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return Object.is(left, right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * `value` with every plain object's keys in canonicalJson's order (as JSON.parse of the
 * journal form gives them). Anything else is left as it is, for validation to judge.
 */
function withSortedKeys(value: unknown, depth = 0): unknown {
  if (typeof value !== "object" || value === null || depth > 256) return value;
  if (Array.isArray(value)) return value.map((entry) => withSortedKeys(entry, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(out, key, { value: withSortedKeys((value as Record<string, unknown>)[key], depth + 1), writable: true, enumerable: true, configurable: true });
  }
  return out;
}

/** Where a root's legacy project directory would be: next to its `.ninerr`. */
function legacyDirectoryOf(projectDir: string): string {
  return join(dirname(projectDir), LEGACY_PROJECT_DIRECTORY);
}

export interface CreateProjectOptions {
  projectId: string;
  document: unknown;
  createdAt: string;
}

/**
 * Create `<root>/.ninerr` atomically: it is assembled in a temporary sibling directory and
 * renamed into place, so a crash never leaves a half-initialized project. Anything already
 * named `.ninerr` (directory, file, or link) is refused, and so is a root that holds a
 * legacy project, which must be migrated rather than shadowed.
 */
export function createProject(root: string, options: CreateProjectOptions): { projectDir: string } {
  const projectDir = projectDirectory(root);
  assertId(options?.projectId, "projectId");
  assertTimestamp(options.createdAt, "createdAt");
  let document: LilacDocument;
  try {
    validateDocument(options.document);
    document = normalizeDocument(persisted(cloneDocument(options.document))) as LilacDocument;
  } catch (error) {
    throw new PersistenceValidationError(`document is invalid: ${(error as Error).message.slice(0, 200)}`);
  }
  assertId(document.id, "document.id");
  if (assertNotSymlink(projectDir, "project directory")) throw new PersistenceValidationError("a Ninerr project already exists at this root");
  if (assertNotSymlink(legacyDirectoryOf(projectDir), "legacy project directory")) throw new PersistenceValidationError("a legacy project exists at this root; migrate it instead");
  const staging = join(dirname(projectDir), `${PROJECT_FILES.directory}.tmp-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const files = paths(staging);
    const documentObject = putObject(staging, Buffer.from(canonicalJson(document), "utf8"));
    createExclusive(files.journal, "");
    atomicWrite(files.snapshot, canonicalJson({ revision: document.revision, documentObject, journalSeq: 0, chainDigest: genesisDigest(options.projectId, JOURNAL_GENESIS) }), "snapshot reference");
    const manifest: ProjectManifest = {
      format: PROJECT_FORMAT,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId: options.projectId,
      documentId: document.id,
      createdAt: options.createdAt,
      journalGenesis: JOURNAL_GENESIS,
    };
    atomicWrite(files.manifest, canonicalJson(manifest), "manifest");
    try {
      renameSync(staging, projectDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST" || code === "ENOTEMPTY") throw new PersistenceValidationError("a Ninerr project already exists at this root");
      throw error;
    }
    fsyncDirectory(dirname(projectDir));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { projectDir };
}

export interface OpenProjectOptions {
  owner: string;
  at: string;
  breakStaleLock?: { reason: string };
  migrations?: Readonly<Record<number, ManifestMigration>>;
}

function readLock(path: string): LockRecord | null {
  try {
    const record = readJsonFile(path, "lock", MAX_LOCK_BYTES, { singleLink: true });
    if (typeof record.owner !== "string" || typeof record.pid !== "number" || typeof record.at !== "string" || typeof record.nonce !== "string") return null;
    return { owner: record.owner.slice(0, 128), pid: record.pid, at: record.at.slice(0, 64), nonce: record.nonce.slice(0, 64) };
  } catch {
    return null;
  }
}

/** Lenient read for the override audit trail: older lock records may lack a nonce. */
function readPreviousHolder(path: string): LockRecord | null {
  try {
    const record = readJsonFile(path, "lock", MAX_LOCK_BYTES, { singleLink: true });
    if (typeof record.owner !== "string" || typeof record.pid !== "number" || typeof record.at !== "string") return null;
    const nonce = typeof record.nonce === "string" ? record.nonce.slice(0, 64) : "";
    return { owner: record.owner.slice(0, 128), pid: record.pid, at: record.at.slice(0, 64), nonce };
  } catch {
    return null;
  }
}

function sameHolder(left: LockRecord | null, right: LockRecord): boolean {
  return left !== null && left.owner === right.owner && left.pid === right.pid && left.at === right.at && left.nonce === right.nonce;
}

/**
 * Take the writer lock. A stale lock is broken by renaming it to a unique name first: only
 * one contender can win that rename, so two overriding processes cannot both end up holding
 * the lock. The override is persisted in the new lock record.
 */
function acquireLock(lockPath: string, record: LockRecord, override: OpenProjectOptions["breakStaleLock"]): LockOverride | null {
  try {
    createExclusive(lockPath, canonicalJson(record));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  if (!override) throw new PersistenceLockError("project is locked by another writer");
  if (typeof override.reason !== "string" || override.reason.trim() === "" || override.reason.length > 500) {
    throw new PersistenceValidationError("breakStaleLock.reason must be a non-empty string of at most 500 characters");
  }
  let lockStat;
  try {
    lockStat = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new PersistenceLockError("project lock changed hands during override");
    throw error;
  }
  if (!lockStat.isFile()) throw new PersistenceLockError("project lock path is not a regular file; resolve it manually");
  const broken = `${lockPath}.broken-${randomUUID()}`;
  try {
    renameSync(lockPath, broken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new PersistenceLockError("project lock changed hands during override");
    throw error;
  }
  const previous = readPreviousHolder(broken);
  try {
    removeFile(broken);
  } catch {
    // A leftover renamed lock is inert; the new lock below is what counts.
  }
  const lockOverride: LockOverride = { previous, reason: override.reason };
  try {
    createExclusive(lockPath, canonicalJson({ ...record, override: lockOverride }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new PersistenceLockError("project lock was taken by another writer during override");
    throw error;
  }
  return lockOverride;
}

// For cleanup paths (failed open, close), which must not throw: an identity check that
// cannot complete counts as "moved", leaving the lock for breakStaleLock.
function stillPinned(projectDir: string, directory: DirectoryIdentity): boolean {
  try {
    return isSameDirectory(projectDir, directory);
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string, record: LockRecord): void {
  if (sameHolder(readLock(lockPath), record)) removeFile(lockPath);
}

// The object store's two-hex fan-out directories (real directories only, never links).
function objectFanOutDirectories(projectDir: string): string[] {
  const root = join(projectDir, PROJECT_FILES.objects);
  // Best effort, like the cleanup it feeds: anything but a readable real directory is left
  // for the object store's own typed checks. Only filesystem errors are absorbed.
  try {
    if (!lstatSync(root).isDirectory()) return [];
    return readdirSync(root).filter((name) => {
      if (!/^[0-9a-f]{2}$/u.test(name)) return false;
      try { return lstatSync(join(root, name)).isDirectory(); } catch (error) { if (isFilesystemError(error)) return false; throw error; }
    }).map((name) => join(root, name));
  } catch (error) {
    if (isFilesystemError(error)) return [];
    throw error;
  }
}

const LEFTOVER_LOCK = new RegExp(`^${PROJECT_FILES.lock.replace(".", "\\.")}\\.broken-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, "u");

interface VerifiedProject {
  manifest: ProjectManifest;
  migratedFrom: number | null;
  document: LilacDocument;
  journalBytes: Buffer;
  parsed: ParsedJournal;
  genesis: string;
  snapshot: SnapshotRef;
  replayed: number;
}

/**
 * Read and verify a project directory without writing anything: manifest (migrated in
 * memory), snapshot, its document object, the whole journal chain from the manifest's
 * genesis domain, and replay of every entry after the snapshot.
 */
function readVerifiedProject(projectDir: string, migrations: Readonly<Record<number, ManifestMigration>>): VerifiedProject {
  const files = paths(projectDir);
  const rawManifest = readJsonFile(files.manifest, "manifest");
  const { manifest: migrated, migratedFrom } = migrateManifest(rawManifest, migrations);
  const manifest = readManifest(migrated);

  const snapshot = readSnapshot(readJsonFile(files.snapshot, "snapshot reference"));
  let document = loadDocument(projectDir, snapshot.documentObject);
  if (document.revision !== snapshot.revision || document.id !== manifest.documentId) {
    throw new PersistenceCorruptionError("snapshot document does not match the snapshot reference or manifest");
  }

  const journalBytes = readBounded(files.journal, PERSISTENCE_LIMITS.maxJournalBytes, "journal");
  if (journalBytes === null) throw new PersistenceCorruptionError("journal is missing");
  const genesis = genesisDigest(manifest.projectId, manifest.journalGenesis);
  const parsed = parseJournal(journalBytes, genesis);
  // Every entry must be journal format 1, including those the snapshot already covers.
  for (const { entry } of parsed.entries) assertJournalFormat(entry.transaction, `journal entry ${entry.seq}`, true);
  if (snapshot.journalSeq > parsed.entries.length) {
    throw new PersistenceCorruptionError("snapshot reference points past the end of the journal");
  }
  const anchor = snapshot.journalSeq === 0 ? genesis : parsed.entries[snapshot.journalSeq - 1].digest;
  if (anchor !== snapshot.chainDigest) throw new PersistenceCorruptionError("snapshot reference does not match the journal chain");

  let replayed = 0;
  for (const { entry } of parsed.entries.slice(snapshot.journalSeq)) {
    let next: LilacDocument;
    try {
      next = applyTransaction(document, entry.transaction).document as LilacDocument;
    } catch (error) {
      throw new PersistenceCorruptionError(`journal entry ${entry.seq} does not apply: ${(error as Error).message.slice(0, 200)}`);
    }
    if (next.revision !== entry.revision) throw new PersistenceCorruptionError(`journal entry ${entry.seq} revision mismatch`);
    document = next;
    replayed += 1;
  }
  return { manifest, migratedFrom, document, journalBytes, parsed, genesis, snapshot, replayed };
}

/** Open a project for writing: lock, verify, recover a torn journal tail, and replay. */
export function openProject(root: string, options: OpenProjectOptions): ProjectStore {
  const projectDir = projectDirectory(root);
  assertId(options?.owner, "owner");
  assertTimestamp(options.at, "at");
  if (!assertNotSymlink(projectDir, "project directory")) {
    if (assertNotSymlink(legacyDirectoryOf(projectDir), "legacy project directory")) {
      throw new PersistenceVersionError("this root holds a legacy project from before Ninerr; it must be migrated before it can be opened");
    }
    throw new PersistenceValidationError("no Ninerr project exists at this root");
  }
  // Pin the project directory before anything is read or written, and re-check it before
  // every write during open and once more before the store is handed out, so no write lands
  // in a swapped directory. Residual: a swap out and back between two reads can feed this
  // open from another copy; writes still go to the pinned directory (Node has no openat).
  const directory = directoryIdentity(projectDir, "project directory");
  if (directory.path !== projectDir) throw new PersistenceValidationError("project directory must not be reached through a symbolic link");
  const unchanged = (): void => {
    if (!isSameDirectory(projectDir, directory)) throw new PersistenceValidationError("project directory changed while the project was being opened");
  };
  const files = paths(projectDir);
  const lockRecord: LockRecord = { owner: options.owner, pid: process.pid, at: options.at, nonce: randomUUID() };
  const lockOverride = acquireLock(files.lock, lockRecord, options.breakStaleLock);
  try {
    unchanged();
    // An interrupted atomic write leaves an unreferenced temporary next to its target; the
    // target itself still holds the last durable content. Clear them under the lock.
    const staleTemporaryFiles = removeStaleTemporaries(projectDir, (target) => [PROJECT_FILES.manifest, PROJECT_FILES.snapshot, PROJECT_FILES.journal].includes(target))
      + objectFanOutDirectories(projectDir).reduce((total, directory) => total + removeStaleTemporaries(directory, (target) => /^[0-9a-f]{62}$/u.test(target)), 0)
      // A lock override renames the stale lock aside before reading it; a crash in between
      // leaves that renamed copy behind. The previous holder is already in the override record.
      + removeStaleFiles(projectDir, (name) => LEFTOVER_LOCK.test(name));
    const { manifest, migratedFrom, document, journalBytes, parsed, genesis, replayed } = readVerifiedProject(projectDir, withBuiltInMigrations(options.migrations));
    // Repairs are written only once every check has passed, so an open refused as newer or
    // corrupt leaves the project's files as it found them.
    if (migratedFrom !== null) {
      unchanged();
      atomicWrite(files.manifest, canonicalJson(manifest), "manifest");
    }
    if (parsed.tornTailBytes > 0) {
      unchanged();
      atomicWrite(files.journal, journalBytes.subarray(0, parsed.validBytes), "journal");
    }
    const last = parsed.entries.at(-1);
    unchanged();
    return new ProjectStore(STORE_TOKEN, projectDir, manifest, document, {
      seq: last?.entry.seq ?? 0,
      digest: last?.digest ?? genesis,
      journalBytes: parsed.validBytes,
      // Content pin: SHA-256 of exactly the bytes validated above (after any torn-tail truncation).
      // commit() extends it with each line it appends, and appendDurable compares the file to it
      // before the next write, so any later change to those bytes refuses that commit.
      journalContent: createHash("sha256").update(journalBytes.subarray(0, parsed.validBytes)),
      journalIdentity: fileIdentity(files.journal, "journal"),
      lock: lockRecord,
      directory,
      recovery: { tornTailBytes: parsed.tornTailBytes, staleTemporaryFiles, replayedEntries: replayed, migratedFrom, lockOverride },
    });
  } catch (error) {
    // After a swap, the lock path points elsewhere; only release a lock in the pinned
    // directory. Cleanup never replaces the original error.
    if (stillPinned(projectDir, directory)) releaseLock(files.lock, lockRecord);
    throw error;
  }
}

interface StoreState {
  seq: number;
  digest: string;
  journalBytes: number;
  journalContent: Hash;
  journalIdentity: FileIdentity;
  lock: LockRecord;
  directory: DirectoryIdentity;
  recovery: RecoveryReport;
}

/** An open, locked project. Obtain one only through `openProject`. */
export class ProjectStore {
  readonly projectDir: string;
  readonly manifest: Readonly<ProjectManifest>;
  readonly recovery: Readonly<RecoveryReport>;
  #document: LilacDocument;
  #seq: number;
  #digest: string;
  #journalBytes: number;
  #journalContent: Hash;
  #journalIdentity: FileIdentity;
  #lock: LockRecord;
  #closed = false;
  #poisoned = false;
  #directory: DirectoryIdentity;

  constructor(token: symbol, projectDir: string, manifest: ProjectManifest, document: LilacDocument, state: StoreState) {
    if (token !== STORE_TOKEN) throw new PersistenceValidationError("ProjectStore is created by openProject");
    this.projectDir = projectDir;
    this.manifest = Object.freeze({ ...manifest });
    this.recovery = Object.freeze(state.recovery);
    this.#document = document;
    this.#seq = state.seq;
    this.#digest = state.digest;
    this.#journalBytes = state.journalBytes;
    this.#journalContent = state.journalContent;
    this.#journalIdentity = state.journalIdentity;
    this.#lock = state.lock;
    this.#directory = state.directory;
  }

  #assertOpen(): void {
    if (this.#closed) throw new PersistenceValidationError("project store is closed");
  }

  /** Writes need an open, unpoisoned store that still holds the lock on a non-link project directory. */
  #assertWritable(): void {
    this.#assertOpen();
    if (this.#poisoned) throw new PersistenceValidationError("project store must be reopened after a failed journal write");
    // The project directory must still be the one opened: a renamed root with a symlink
    // in its place, or a swapped .ninerr, would otherwise receive this store's writes.
    // A swap between this check and the write remains possible (Node has no openat).
    if (!isSameDirectory(this.projectDir, this.#directory)) {
      throw new PersistenceValidationError("project directory changed since the store was opened");
    }
    if (!sameHolder(readLock(join(this.projectDir, PROJECT_FILES.lock)), this.#lock)) {
      throw new PersistenceLockError("this writer no longer holds the project lock");
    }
  }

  /** A copy of the current document; the store's state changes only through commit. */
  get document(): LilacDocument {
    this.#assertOpen();
    return cloneDocument(this.#document) as LilacDocument;
  }

  get revision(): number {
    this.#assertOpen();
    return this.#document.revision;
  }

  get journalSeq(): number {
    this.#assertOpen();
    return this.#seq;
  }

  /**
   * Apply a history transaction (validation and stale-revision rejection happen first),
   * durably append it to the journal, then update memory. The in-memory document is built
   * from the decoded journal form, so it always equals what replay produces. Nothing is
   * written on validation failure; any journal write failure poisons the store.
   */
  commit(transaction: unknown): { revision: number; seq: number; transactionId: string } {
    this.#assertWritable();
    let validated;
    try {
      // In the journal form's key order, so the document applied here has the same key
      // order as the one replay builds (style order is meaningful: a later shorthand wins).
      validated = applyTransaction(this.#document, withSortedKeys(transaction));
    } catch (error) {
      if ((error as Error)?.name === "DataCloneError") throw new PersistenceValidationError("transaction contains values that cannot be cloned");
      throw error;
    }
    const stored = persisted(validated.transaction) as Record<string, unknown>;
    assertJournalFormat(stored, "transaction", false);
    // The document is built from the journal form, so it equals what replay produces. When
    // the journal form, read back, is exactly the validated transaction, in the same key
    // order (the usual case; not when JSON changed a value, such as -0 to 0), applying it
    // again would give the same document, so the first result is used; otherwise it is
    // applied again.
    const sameForm = sameValue(createTransaction(stored), validated.transaction);
    const next = (sameForm ? validated.document : applyTransaction(this.#document, stored).document) as LilacDocument;
    const entry = { seq: this.#seq + 1, revision: next.revision, transaction: stored };
    const { line, digest } = encodeJournalLine(entry, this.#digest);
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.#journalBytes + bytes > PERSISTENCE_LIMITS.maxJournalBytes) {
      throw new PersistenceValidationError(`journal reached its ${PERSISTENCE_LIMITS.maxJournalBytes}-byte limit; journal rotation is not available in this release`);
    }
    try {
      appendDurable(join(this.projectDir, PROJECT_FILES.journal), line, "journal", {
        size: this.#journalBytes,
        identity: this.#journalIdentity,
        sha256: this.#journalContent.copy().digest("hex"),
      });
    } catch (error) {
      // The file may now hold a partial line; only a reopen can reconcile it safely.
      this.#poisoned = true;
      throw error;
    }
    this.#document = next;
    this.#seq = entry.seq;
    this.#digest = digest;
    this.#journalBytes += bytes;
    this.#journalContent.update(line, "utf8");
    return { revision: next.revision, seq: entry.seq, transactionId: String(stored.id) };
  }

  /** Persist the current document and move the snapshot reference to the journal head. */
  checkpoint(): SnapshotRef {
    this.#assertWritable();
    const documentObject = putObject(this.projectDir, Buffer.from(canonicalJson(this.#document), "utf8"));
    const snapshot: SnapshotRef = { revision: this.#document.revision, documentObject, journalSeq: this.#seq, chainDigest: this.#digest };
    atomicWrite(join(this.projectDir, PROJECT_FILES.snapshot), canonicalJson(snapshot), "snapshot reference");
    return snapshot;
  }

  putObject(bytes: Buffer): string {
    this.#assertWritable();
    if (!Buffer.isBuffer(bytes)) throw new PersistenceValidationError("object content must be a Buffer");
    return putObject(this.projectDir, bytes);
  }

  getObject(digest: string): Buffer {
    this.#assertOpen();
    return getObject(this.projectDir, digest);
  }

  /** Release the writer lock (only if it is still ours). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // After the project directory moved or was swapped, the lock path points elsewhere;
    // the lock is then left for breakStaleLock rather than removing a file outside.
    if (stillPinned(this.projectDir, this.#directory)) releaseLock(join(this.projectDir, PROJECT_FILES.lock), this.#lock);
  }
}
