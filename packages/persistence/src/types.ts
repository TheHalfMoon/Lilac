import { LEGACY_JOURNAL_GENESIS } from "./legacy.ts";

export const PROJECT_SCHEMA_VERSION = 3;
export const PROJECT_FORMAT = "ninerr-project";
/** The genesis domain a project created by this release chains its journal from. */
export const JOURNAL_GENESIS = "ninerr-journal-genesis";
/**
 * Genesis domains a manifest may record. A migrated project keeps the domain its journal was
 * chained from, so every recorded digest still verifies; history is never re-chained.
 */
export const JOURNAL_GENESIS_DOMAINS = Object.freeze([JOURNAL_GENESIS, LEGACY_JOURNAL_GENESIS] as const);
export type JournalGenesisDomain = (typeof JOURNAL_GENESIS_DOMAINS)[number];

export const PERSISTENCE_LIMITS = {
  maxObjectBytes: 64 * 1024 * 1024,
  maxJournalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  maxReplayEntries: 1_000_000,
  maxManifestBytes: 64 * 1024,
  /** A checkpoint starts a new journal segment once the journal is larger than this (#258). */
  journalSegmentBytes: 1024 * 1024,
  /** An archived segment is stored in pieces of at most this size. */
  archivePieceBytes: 32 * 1024 * 1024,
} as const;

/** Fixed names inside `<root>/.ninerr`. No path is ever derived from input. */
export const PROJECT_FILES = {
  directory: ".ninerr",
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
  journalGenesis: JournalGenesisDomain;
}

export interface SnapshotRef {
  revision: number;
  documentObject: string;
  journalSeq: number;
  chainDigest: string;
}

/**
 * The first line of a journal segment that continues an earlier one (project schema 3, #258):
 * its entries follow entry `baseSeq`, whose chain digest is `anchor`, and the earlier segment's
 * bytes are the objects in `archive`, in order.
 */
export interface JournalSegment {
  baseSeq: number;
  anchor: string;
  archive: string[];
}

/**
 * A change the journal holds, as the history panel lists it: who made it, what for, with
 * what tool and when. Read from the journal at open (#231).
 */
export interface JournalSummary {
  revision: number;
  transactionId: string;
  actor: string;
  actorKind: "user" | "agent";
  intent: string | null;
  tool: string | null;
  at: string | null;
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
  /** Random per acquisition, so two acquisitions with the same owner, pid, and time differ. */
  nonce: string;
  /** Present when this lock replaced a stale one; persisted so the override survives restarts. */
  override?: LockOverride;
}

export interface RecoveryReport {
  tornTailBytes: number;
  /** Temporary files left by interrupted atomic writes, removed on open. */
  staleTemporaryFiles: number;
  replayedEntries: number;
  migratedFrom: number | null;
  lockOverride: LockOverride | null;
}

/** What migrating a legacy project produced. The legacy directory is left exactly as it was. */
export interface LegacyMigrationReport {
  projectDir: string;
  legacyDir: string;
  migratedFrom: number;
  objectsCopied: number;
  tornTailBytes: number;
}
