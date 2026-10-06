import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneDocument, normalizeDocument, validateDocument } from "@lilac/document-model";
import { applyTransaction } from "@lilac/history";
import { canonicalJson } from "./canonical.ts";
import { PersistenceCorruptionError, PersistenceLockError, PersistenceValidationError } from "./errors.ts";
import {
  appendDurable,
  assertNotSymlink,
  atomicWrite,
  createExclusive,
  fileIdentity,
  fsyncDirectory,
  type FileIdentity,
  projectDirectory,
  readBounded,
  removeFile,
} from "./fsio.ts";
import { encodeJournalLine, genesisDigest, parseJournal } from "./journal.ts";
import { PROJECT_MIGRATIONS, migrateManifest, type ManifestMigration } from "./migrations.ts";
import { getObject, putObject } from "./objects.ts";
import {
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

function readJsonFile(path: string, label: string, maxBytes: number = PERSISTENCE_LIMITS.maxManifestBytes): Record<string, unknown> {
  const bytes = readBounded(path, maxBytes, label);
  if (bytes === null) throw new PersistenceCorruptionError(`${label} is missing`);
  return parseJsonFile(bytes, label);
}

function readManifest(record: Record<string, unknown>): ProjectManifest {
  if (record.format !== PROJECT_FORMAT) throw new PersistenceCorruptionError("manifest is not a Lilac project manifest");
  for (const key of Object.keys(record)) {
    if (!["format", "schemaVersion", "projectId", "documentId", "createdAt"].includes(key)) {
      throw new PersistenceCorruptionError(`manifest contains unsupported field ${JSON.stringify(key).slice(0, 80)}`);
    }
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

function loadDocument(projectDir: string, digest: string): LilacDocument {
  const record = parseJsonFile(getObject(projectDir, digest), `document object ${digest}`);
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

export interface CreateProjectOptions {
  projectId: string;
  document: unknown;
  createdAt: string;
}

/**
 * Create `<root>/.lilac` atomically: it is assembled in a temporary sibling directory and
 * renamed into place, so a crash never leaves a half-initialized project. Anything already
 * named `.lilac` (directory, file, or link) is refused.
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
  if (assertNotSymlink(projectDir, "project directory")) throw new PersistenceValidationError("a Lilac project already exists at this root");
  const staging = join(dirname(projectDir), `${PROJECT_FILES.directory}.tmp-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const files = paths(staging);
    const documentObject = putObject(staging, Buffer.from(canonicalJson(document), "utf8"));
    createExclusive(files.journal, "");
    atomicWrite(files.snapshot, canonicalJson({ revision: document.revision, documentObject, journalSeq: 0, chainDigest: genesisDigest(options.projectId) }), "snapshot reference");
    const manifest: ProjectManifest = {
      format: PROJECT_FORMAT,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId: options.projectId,
      documentId: document.id,
      createdAt: options.createdAt,
    };
    atomicWrite(files.manifest, canonicalJson(manifest), "manifest");
    try {
      renameSync(staging, projectDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST" || code === "ENOTEMPTY") throw new PersistenceValidationError("a Lilac project already exists at this root");
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
    const record = readJsonFile(path, "lock", MAX_LOCK_BYTES);
    if (typeof record.owner !== "string" || typeof record.pid !== "number" || typeof record.at !== "string" || typeof record.nonce !== "string") return null;
    return { owner: record.owner.slice(0, 128), pid: record.pid, at: record.at.slice(0, 64), nonce: record.nonce.slice(0, 64) };
  } catch {
    return null;
  }
}

/** Lenient read for the override audit trail: older lock records may lack a nonce. */
function readPreviousHolder(path: string): LockRecord | null {
  try {
    const record = readJsonFile(path, "lock", MAX_LOCK_BYTES);
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

function releaseLock(lockPath: string, record: LockRecord): void {
  if (sameHolder(readLock(lockPath), record)) removeFile(lockPath);
}

/** Open a project for writing: lock, verify, recover a torn journal tail, and replay. */
export function openProject(root: string, options: OpenProjectOptions): ProjectStore {
  const projectDir = projectDirectory(root);
  assertId(options?.owner, "owner");
  assertTimestamp(options.at, "at");
  if (!assertNotSymlink(projectDir, "project directory")) throw new PersistenceValidationError("no Lilac project exists at this root");
  const files = paths(projectDir);
  const lockRecord: LockRecord = { owner: options.owner, pid: process.pid, at: options.at, nonce: randomUUID() };
  const lockOverride = acquireLock(files.lock, lockRecord, options.breakStaleLock);
  try {
    const rawManifest = readJsonFile(files.manifest, "manifest");
    const { manifest: migrated, migratedFrom } = migrateManifest(rawManifest, options.migrations ?? PROJECT_MIGRATIONS);
    const manifest = readManifest(migrated);
    if (migratedFrom !== null) atomicWrite(files.manifest, canonicalJson(manifest), "manifest");

    const snapshot = readSnapshot(readJsonFile(files.snapshot, "snapshot reference"));
    let document = loadDocument(projectDir, snapshot.documentObject);
    if (document.revision !== snapshot.revision || document.id !== manifest.documentId) {
      throw new PersistenceCorruptionError("snapshot document does not match the snapshot reference or manifest");
    }

    const journalBytes = readBounded(files.journal, PERSISTENCE_LIMITS.maxJournalBytes, "journal");
    if (journalBytes === null) throw new PersistenceCorruptionError("journal is missing");
    const genesis = genesisDigest(manifest.projectId);
    const parsed = parseJournal(journalBytes, genesis);
    if (parsed.tornTailBytes > 0) atomicWrite(files.journal, journalBytes.subarray(0, parsed.validBytes), "journal");
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
    const last = parsed.entries.at(-1);
    return new ProjectStore(STORE_TOKEN, projectDir, manifest, document, {
      seq: last?.entry.seq ?? 0,
      digest: last?.digest ?? genesis,
      journalBytes: parsed.validBytes,
      journalIdentity: fileIdentity(files.journal, "journal"),
      lock: lockRecord,
      recovery: { tornTailBytes: parsed.tornTailBytes, replayedEntries: replayed, migratedFrom, lockOverride },
    });
  } catch (error) {
    releaseLock(files.lock, lockRecord);
    throw error;
  }
}

interface StoreState {
  seq: number;
  digest: string;
  journalBytes: number;
  journalIdentity: FileIdentity;
  lock: LockRecord;
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
  #journalIdentity: FileIdentity;
  #lock: LockRecord;
  #closed = false;
  #poisoned = false;

  constructor(token: symbol, projectDir: string, manifest: ProjectManifest, document: LilacDocument, state: StoreState) {
    if (token !== STORE_TOKEN) throw new PersistenceValidationError("ProjectStore is created by openProject");
    this.projectDir = projectDir;
    this.manifest = Object.freeze({ ...manifest });
    this.recovery = Object.freeze(state.recovery);
    this.#document = document;
    this.#seq = state.seq;
    this.#digest = state.digest;
    this.#journalBytes = state.journalBytes;
    this.#journalIdentity = state.journalIdentity;
    this.#lock = state.lock;
  }

  #assertOpen(): void {
    if (this.#closed) throw new PersistenceValidationError("project store is closed");
  }

  /** Writes need an open, unpoisoned store that still holds the lock on a non-link project directory. */
  #assertWritable(): void {
    this.#assertOpen();
    if (this.#poisoned) throw new PersistenceValidationError("project store must be reopened after a failed journal write");
    assertNotSymlink(this.projectDir, "project directory");
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
      validated = applyTransaction(this.#document, transaction);
    } catch (error) {
      if ((error as Error)?.name === "DataCloneError") throw new PersistenceValidationError("transaction contains values that cannot be cloned");
      throw error;
    }
    const stored = persisted(validated.transaction) as Record<string, unknown>;
    const next = applyTransaction(this.#document, stored).document as LilacDocument;
    const entry = { seq: this.#seq + 1, revision: next.revision, transaction: stored };
    const { line, digest } = encodeJournalLine(entry, this.#digest);
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.#journalBytes + bytes > PERSISTENCE_LIMITS.maxJournalBytes) {
      throw new PersistenceValidationError(`journal reached its ${PERSISTENCE_LIMITS.maxJournalBytes}-byte limit; journal rotation is not available in this release`);
    }
    try {
      this.#journalIdentity = appendDurable(join(this.projectDir, PROJECT_FILES.journal), line, "journal", { size: this.#journalBytes, identity: this.#journalIdentity });
    } catch (error) {
      // The file may now hold a partial line; only a reopen can reconcile it safely.
      this.#poisoned = true;
      throw error;
    }
    this.#document = next;
    this.#seq = entry.seq;
    this.#digest = digest;
    this.#journalBytes += bytes;
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
    releaseLock(join(this.projectDir, PROJECT_FILES.lock), this.#lock);
  }
}
