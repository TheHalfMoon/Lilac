import { PersistenceCorruptionError, PersistenceValidationError, PersistenceVersionError } from "./errors.ts";
import { LEGACY_JOURNAL_GENESIS, LEGACY_PROJECT_FORMAT } from "./legacy.ts";
import { PROJECT_FORMAT, PROJECT_SCHEMA_VERSION } from "./types.ts";

/** Upgrade a manifest record from version `n` to `n + 1`. */
export type ManifestMigration = (manifest: Record<string, unknown>) => Record<string, unknown>;

/**
 * Built-in manifest migrations keyed by source version. Hosts that read pre-release projects
 * may pass steps for earlier versions; a built-in step always wins for its own version.
 *
 * 1 -> 2: the product became Ninerr. The manifest takes the Ninerr format and records the
 * genesis domain its journal was chained from, so the existing chain keeps verifying.
 */
export const PROJECT_MIGRATIONS: Readonly<Record<number, ManifestMigration>> = Object.freeze({
  1: (manifest: Record<string, unknown>) => {
    if (manifest.format !== LEGACY_PROJECT_FORMAT) throw new PersistenceCorruptionError("a schema-1 manifest must have the legacy project format");
    // Schema 1 never had this field; one that claims it is damage, and is never overwritten.
    if (Object.hasOwn(manifest, "journalGenesis")) throw new PersistenceCorruptionError("a schema-1 manifest must not record a journal genesis");
    return { ...manifest, format: PROJECT_FORMAT, journalGenesis: LEGACY_JOURNAL_GENESIS };
  },
});

/**
 * Host-supplied steps for versions without a built-in step, plus every built-in step. A host
 * step for a version a built-in step owns is refused rather than silently ignored.
 */
export function withBuiltInMigrations(extra: Readonly<Record<number, ManifestMigration>> | undefined): Readonly<Record<number, ManifestMigration>> {
  for (const version of Object.keys(extra ?? {})) {
    if (Object.hasOwn(PROJECT_MIGRATIONS, version)) throw new PersistenceValidationError(`migration from project schema ${version} is built in and cannot be replaced`);
  }
  return Object.freeze({ ...extra, ...PROJECT_MIGRATIONS });
}

export function migrateManifest(
  manifest: Record<string, unknown>,
  migrations: Readonly<Record<number, ManifestMigration>>,
): { manifest: Record<string, unknown>; migratedFrom: number | null } {
  const start = manifest.schemaVersion;
  if (!Number.isSafeInteger(start) || (start as number) < 0) {
    throw new PersistenceVersionError("project schemaVersion is not a non-negative integer");
  }
  if ((start as number) > PROJECT_SCHEMA_VERSION) {
    throw new PersistenceVersionError(`project schema ${start} is newer than supported schema ${PROJECT_SCHEMA_VERSION}`);
  }
  let current = manifest;
  for (let version = start as number; version < PROJECT_SCHEMA_VERSION; version += 1) {
    const step = Object.hasOwn(migrations, version) ? migrations[version] : undefined;
    if (!step) throw new PersistenceVersionError(`no migration from project schema ${version}`);
    current = { ...step(structuredClone(current)), schemaVersion: version + 1 };
  }
  return { manifest: current, migratedFrom: start === PROJECT_SCHEMA_VERSION ? null : (start as number) };
}
