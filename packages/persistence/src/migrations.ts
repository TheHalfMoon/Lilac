import { PersistenceVersionError } from "./errors.ts";
import { PROJECT_SCHEMA_VERSION } from "./types.ts";

/** Upgrade a manifest record from version `n` to `n + 1`. */
export type ManifestMigration = (manifest: Record<string, unknown>) => Record<string, unknown>;

/**
 * Built-in manifest migrations keyed by source version. Version 1 is the first released
 * schema, so the registry is empty; hosts that read pre-release projects pass extra steps.
 */
export const PROJECT_MIGRATIONS: Readonly<Record<number, ManifestMigration>> = Object.freeze({});

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
