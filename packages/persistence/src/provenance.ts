export const PERSISTENCE_PROVENANCE = {
  package: "@ninerr/persistence",
  posture: "Project-owned local project store: content-addressed objects, a hash-chained append-only transaction journal, atomic writes, crash recovery, single-writer locking, and schema migration. Document state is only ever produced by applying @ninerr/history transactions to a verified snapshot. No network, model, or hosted service. No donor code is involved.",
} as const;
