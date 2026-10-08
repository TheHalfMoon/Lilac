// Public surface: the store API, errors, types, and constants. Raw filesystem and journal
// writers stay internal so callers cannot bypass the lock, the hash chain, or history.
export {
  PersistenceCorruptionError,
  PersistenceError,
  PersistenceLockError,
  PersistenceValidationError,
  PersistenceVersionError,
} from "./errors.ts";
export {
  JOURNAL_GENESIS,
  JOURNAL_GENESIS_DOMAINS,
  PERSISTENCE_LIMITS,
  PROJECT_FILES,
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  type JournalEntry,
  type JournalGenesisDomain,
  type LockOverride,
  type LockRecord,
  type ProjectManifest,
  type RecoveryReport,
  type SnapshotRef,
} from "./types.ts";
export { PROJECT_MIGRATIONS, type ManifestMigration } from "./migrations.ts";
// Pure encoders (no I/O), exported so hosts and tests can verify or construct journal lines.
export { encodeJournalLine, genesisDigest } from "./journal.ts";
export { createProject, openProject, type CreateProjectOptions, type OpenProjectOptions, type ProjectStore } from "./store.ts";
export { LEGACY_JOURNAL_GENESIS, LEGACY_PROJECT_DIRECTORY, LEGACY_PROJECT_FORMAT } from "./legacy.ts";
export { PERSISTENCE_PROVENANCE } from "./provenance.ts";
