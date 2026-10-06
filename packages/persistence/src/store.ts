import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
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
  ensureDirectory,
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

function readJsonFile(path: string, label: string, maxBytes = PERSISTENCE_LIMITS.maxManifestBytes): Record<string, unknown> {
  const bytes = readBounded(path, maxBytes, label);
  if (bytes === null) throw new PersistenceCorruptionError(`${label} is missing`);
  return parseJsonFile(bytes, label);
}

function readManifest(record: Record<string, unknown>): ProjectManifest {
  if (record.format !== PROJECT_FORMAT) throw new PersistenceCorruptionError("manifest is not a Lilac project manifest");
  for (const key of Object.keys(record)) {
    if (!["format", "schemaVersion", "projectId", "documentId", "createdAt"].includes(key)) {
      throw new PersistenceCorruptionError(`manifest contains unsupported field ${key}`);
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
    throw new PersistenceCorruptionError(`document object ${digest} is not a valid document: ${(error as Error).message}`);
  }
}

export interface CreateProjectOptions {
  projectId: string;
  document: unknown;
  createdAt: string;
}

/**
 * Create `<root>/.lilac` atomically: it is assembled in a temporary sibling directory and
 * renamed into place, so a crash never leaves a half-initialized project.
 */
export function createProject(root: string, options: CreateProjectOptions): { projectDir: string } {
  const projectDir = projectDirectory(root);
  assertId(options?.projectId, "projectId");
  assertTimestamp(options.createdAt, "createdAt");
  let document: LilacDocument;
  try {
    validateDocument(options.document);
    document = normalizeDocument(cloneDocument(options.document)) as LilacDocument;
  } catch (error) {
    throw new PersistenceValidationError(`document is invalid: ${(error as Error).message}`);
  }
  assertId(document.id, "document.id");
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
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") throw new PersistenceValidationError("a Lilac project already exists at this root");
      throw error;
    }
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

function acquireLock(lockPath: string, record: LockRecord, override: OpenProjectOptions["breakStaleLock"]): RecoveryReport["lockOverride"] {
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
  let previous: LockRecord | null = null;
  try {
    previous = readJsonFile(lockPath, "lock", 4096) as unknown as LockRecord;
  } catch {
    previous = null;
  }
  removeFile(lockPath);
  try {
    createExclusive(lockPath, canonicalJson(record));
  } catch {
    throw new PersistenceLockError("project lock was re-acquired by another writer during override");
  }
  return { previous, reason: override.reason };
}

/** Open a project for writing: verify, recover a torn journal tail, replay, and lock. */
export function openProject(root: string, options: OpenProjectOptions): ProjectStore {
  const projectDir = projectDirectory(root);
  assertId(options?.owner, "owner");
  assertTimestamp(options.at, "at");
  ensureExists(projectDir);
  const files = paths(projectDir);
  const lockRecord: LockRecord = { owner: options.owner, pid: process.pid, at: options.at };
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
        throw new PersistenceCorruptionError(`journal entry ${entry.seq} does not apply: ${(error as Error).message}`);
      }
      if (next.revision !== entry.revision) throw new PersistenceCorruptionError(`journal entry ${entry.seq} revision mismatch`);
      document = next;
      replayed += 1;
    }
    const last = parsed.entries.at(-1);
    return new ProjectStore(projectDir, manifest, document, {
      seq: last?.entry.seq ?? 0,
      digest: last?.digest ?? genesis,
      journalBytes: parsed.validBytes,
      lock: lockRecord,
      recovery: { tornTailBytes: parsed.tornTailBytes, replayedEntries: replayed, migratedFrom, lockOverride },
    });
  } catch (error) {
    releaseLock(files.lock, lockRecord);
    throw error;
  }
}

function ensureExists(projectDir: string): void {
  if (!assertNotSymlink(projectDir, "project directory")) {
    throw new PersistenceValidationError("no Lilac project exists at this root");
  }
}

function releaseLock(lockPath: string, record: LockRecord): void {
  try {
    const current = readJsonFile(lockPath, "lock", 4096);
    if (current.owner === record.owner && current.pid === record.pid && current.at === record.at) removeFile(lockPath);
  } catch {
    // A missing or foreign lock is left untouched.
  }
}

interface StoreState {
  seq: number;
  digest: string;
  journalBytes: number;
  lock: LockRecord;
  recovery: RecoveryReport;
}

export class ProjectStore {
  readonly projectDir: string;
  readonly manifest: Readonly<ProjectManifest>;
  readonly recovery: Readonly<RecoveryReport>;
  #document: LilacDocument;
  #seq: number;
  #digest: string;
  #journalBytes: number;
  #lock: LockRecord;
  #closed = false;

  constructor(projectDir: string, manifest: ProjectManifest, document: LilacDocument, state: StoreState) {
    this.projectDir = projectDir;
    this.manifest = Object.freeze({ ...manifest });
    this.recovery = Object.freeze(state.recovery);
    this.#document = document;
    this.#seq = state.seq;
    this.#digest = state.digest;
    this.#journalBytes = state.journalBytes;
    this.#lock = state.lock;
  }

  #assertOpen(): void {
    if (this.#closed) throw new PersistenceValidationError("project store is closed");
  }

  /** A copy of the current document; the store's state changes only through commit. */
  get document(): LilacDocument {
    this.#assertOpen();
    return cloneDocument(this.#document) as LilacDocument;
  }

  get revision(): number {
    return this.#document.revision;
  }

  get journalSeq(): number {
    return this.#seq;
  }

  /**
   * Apply a history transaction (validation and stale-revision rejection happen first),
   * durably append it to the journal, then update memory. Nothing is written on failure.
   */
  commit(transaction: unknown): { revision: number; seq: number; transactionId: string } {
    this.#assertOpen();
    const result = applyTransaction(this.#document, transaction);
    const next = result.document as LilacDocument;
    const entry = { seq: this.#seq + 1, revision: next.revision, transaction: result.transaction as Record<string, unknown> };
    const { line, digest } = encodeJournalLine(entry, this.#digest);
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.#journalBytes + bytes > PERSISTENCE_LIMITS.maxJournalBytes) {
      throw new PersistenceValidationError("journal is full; checkpoint and rotate before committing more");
    }
    appendDurable(join(this.projectDir, PROJECT_FILES.journal), line, "journal");
    this.#document = next;
    this.#seq = entry.seq;
    this.#digest = digest;
    this.#journalBytes += bytes;
    return { revision: next.revision, seq: entry.seq, transactionId: String(result.transaction.id) };
  }

  /** Persist the current document and move the snapshot reference to the journal head. */
  checkpoint(): SnapshotRef {
    this.#assertOpen();
    const documentObject = putObject(this.projectDir, Buffer.from(canonicalJson(this.#document), "utf8"));
    const snapshot: SnapshotRef = { revision: this.#document.revision, documentObject, journalSeq: this.#seq, chainDigest: this.#digest };
    atomicWrite(join(this.projectDir, PROJECT_FILES.snapshot), canonicalJson(snapshot), "snapshot reference");
    return snapshot;
  }

  putObject(bytes: Buffer): string {
    this.#assertOpen();
    if (!Buffer.isBuffer(bytes)) throw new PersistenceValidationError("object content must be a Buffer");
    ensureDirectory(join(this.projectDir, PROJECT_FILES.objects), "object store");
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
