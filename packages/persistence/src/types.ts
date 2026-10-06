export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_FORMAT = "lilac-project";

export const PERSISTENCE_LIMITS = {
  maxObjectBytes: 64 * 1024 * 1024,
  maxJournalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  maxReplayEntries: 1_000_000,
  maxManifestBytes: 64 * 1024,
} as const;

/** Fixed names inside `<root>/.lilac`. No path is ever derived from input. */
export const PROJECT_FILES = {
  directory: ".lilac",
  manifest: "project.json",
  snapshot: "snapshot.json",
  journal: "journal.log",
  lock: "lock",
  objects: "objects",
} as const;

export interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  schemaVersion: number;
  projectId: string;
  documentId: string;
  createdAt: string;
}

export interface SnapshotRef {
  revision: number;
  documentObject: string;
  journalSeq: number;
  chainDigest: string;
}

export interface JournalEntry {
  seq: number;
  revision: number;
  transaction: Record<string, unknown>;
}

export interface LockOverride {
  previous: LockRecord | null;
  reason: string;
}

export interface LockRecord {
  owner: string;
  pid: number;
  at: string;
  /** Present when this lock replaced a stale one; persisted so the override survives restarts. */
  override?: LockOverride;
}

export interface RecoveryReport {
  tornTailBytes: number;
  replayedEntries: number;
  migratedFrom: number | null;
  lockOverride: LockOverride | null;
}
