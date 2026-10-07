# Project files, versions and migration

Lilac stores a project under `<root>/.lilac`. This page describes the on-disk format this release writes and reads, how version changes are handled, and what to do when a project will not open. The behaviour described here is enforced by `packages/persistence` and checked by `tests/migration-compatibility.test.mjs` (P06 gate 11).

## Layout

| Path | Contents |
| --- | --- |
| `project.json` | The manifest: `{ format: "lilac-project", schemaVersion, projectId, documentId, createdAt }`. Exactly these fields. |
| `snapshot.json` | The snapshot reference: `{ revision, documentObject, journalSeq, chainDigest }`. Exactly these fields. |
| `objects/xx/yyyy...` | Content-addressed objects. Each file is named by the SHA-256 of its bytes. A snapshot's document object is canonical JSON. |
| `journal.log` | Newline-terminated JSON lines `{ digest, entry: { seq, revision, transaction } }`. Each digest chains to the previous one, starting from a per-project genesis digest. |
| `lock` | The single-writer lock while a project is open. |

The document is only ever produced by replaying history transactions from the snapshot's document onward. A golden project of this release is kept in `tests/fixtures/projects/v1-basic`, and this release must regenerate it byte for byte.

## Versions

There are three version boundaries. Each is checked on open, before anything is replayed or written.

| Boundary | Current | Unknown or newer data |
| --- | --- | --- |
| Project manifest | `PROJECT_SCHEMA_VERSION` = 1 | Newer: refused. Older: migrated through a registered step, or refused. Not a non-negative integer: refused. |
| Document schema | `DOCUMENT_SCHEMA_VERSION` = 1 | Any `schemaVersion` other than the integer 1, or a document or node field outside `DOCUMENT_FIELDS`/`NODE_FIELDS`: refused. |
| Journal format | 1 | A transaction, operation or node field outside format 1, or an unknown operation type, in any entry (including entries the snapshot already covers): refused. |

Every refusal above is a `PersistenceVersionError`. Its message names the boundary and, for the journal, the entry and field. A refused open leaves every file untouched: torn-tail repair and manifest migration are written only after all checks pass.

**Damage is reported differently from version mismatches.** It raises `PersistenceCorruptionError`. Damage includes:
- a broken hash chain;
- an object whose bytes do not match its name;
- a malformed snapshot reference;
- a structurally invalid document.

The only damage that is repaired automatically is an unterminated last journal line from an interrupted write (`recovery.tornTailBytes`), together with stale temporary files (`recovery.staleTemporaryFiles`).

This release also refuses to write anything a format-1 reader would refuse. `commit` rejects such a transaction with `PersistenceValidationError` before writing, and `createProject` rejects an off-schema document.

## Migrating a manifest

Schema 1 is the first released project schema, so the built-in registry `PROJECT_MIGRATIONS` is empty. A host that must read pre-release projects passes its own steps. Each step takes a manifest at version `n` and returns version `n + 1`:

```js
import { openProject } from "@lilac/persistence";

const store = openProject(root, {
  owner: "my-app",
  at: new Date().toISOString(),
  migrations: { 0: ({ legacyRoot, ...rest }) => ({ ...rest, documentId: legacyRoot }) },
});
store.recovery.migratedFrom; // 0
```

The migrated manifest is written back atomically once the open succeeds. Migration of documents and journals is not supported. A project whose document or journal is from another version must be opened by the Lilac release that wrote it.

## When a project will not open

- **`PersistenceVersionError` "newer than supported" or "written by a newer Lilac".** The project was written by a later release. Open it with that release. Nothing was changed on disk.
- **`PersistenceVersionError` "no migration from project schema N".** The project predates schema 1. Supply a migration step as above.
- **`PersistenceCorruptionError`.** The files are damaged. Restore `.lilac` from a backup or version control. Lilac does not guess at repairs beyond the torn tail.
- **`PersistenceLockError`.** Another writer holds the project. If the previous writer is known to be gone, the host may replace its lock by passing `breakStaleLock: { reason }`. Lilac does not decide this itself. The previous holder and the reason are recorded in the new lock and in `recovery.lockOverride`.
