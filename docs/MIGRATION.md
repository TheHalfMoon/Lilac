# Project files, versions and migration

Ninerr stores a project under `<root>/.ninerr`. This page describes:

- the on-disk format this release writes and reads;
- how version changes are handled;
- how projects from before the rename are migrated;
- what to do when a project will not open.

`packages/persistence` enforces this behaviour. Two suites check it:

- `tests/migration-compatibility.test.mjs` (P06 gate 11);
- `tests/legacy-migration.test.mjs` (N0-G2).

## Layout

| Path | Contents |
| --- | --- |
| `project.json` | The manifest: `{ format: "ninerr-project", schemaVersion, projectId, documentId, createdAt, journalGenesis }`. Exactly these fields. |
| `snapshot.json` | The snapshot reference: `{ revision, documentObject, journalSeq, chainDigest }`. Exactly these fields. |
| `objects/xx/yyyy...` | Content-addressed objects. Each file is named by the SHA-256 of its bytes. A snapshot's document object is canonical JSON. |
| `journal.log` | Newline-terminated JSON lines `{ digest, entry: { seq, revision, transaction } }`. Each digest chains to the previous one, starting from a per-project genesis digest. |
| `lock` | The single-writer lock while a project is open. |

**Journal genesis.** The genesis digest is `sha256("<journalGenesis>:<projectId>")`. A project created by this release records `journalGenesis: "ninerr-journal-genesis"`. A migrated project records the domain its journal was chained from. Its history is never re-chained, so every recorded digest still verifies. Only the two known domains are accepted.

**The document comes only from replay.** It is produced by replaying history transactions from the snapshot's document onward.

**Golden fixtures.**

- `tests/fixtures/projects/v2-basic` is the golden project of this release, and this release must regenerate it byte for byte.
- `tests/fixtures/projects/v1-basic` is the same history written before the rename. It is frozen as the legacy migration corpus.

## Versions

There are three version boundaries. Each is checked on open, before anything is replayed and before any project file is rewritten.

| Boundary | Current | Unknown or newer data |
| --- | --- | --- |
| Project manifest | `PROJECT_SCHEMA_VERSION` = 2 | Newer: refused. Older: migrated through the built-in step or a host step, or refused. Not a non-negative integer: refused. |
| Document schema | `DOCUMENT_SCHEMA_VERSION` = 1 | Any `schemaVersion` other than the integer 1, or a document or node field outside `DOCUMENT_FIELDS`/`NODE_FIELDS`: refused. |
| Journal format | 1 | A transaction, operation or node field outside format 1, or an unknown operation type, in any entry (including entries the snapshot already covers): refused. |

Every refusal above is a `PersistenceVersionError`. Its message names the boundary and, for the journal, the entry and field.

**A refused open leaves the project's manifest, snapshot, journal and objects as it found them.** Torn-tail repair and manifest migration are written only after all checks pass. What an open does do before its checks, under the writer lock:
- It takes the lock and releases it again when the open is refused.
- It removes unreferenced temporaries from interrupted writes, and leftover `lock.broken-*` copies from an earlier lock override.
- With `breakStaleLock`, it replaces the old lock. If the open is then refused, the old lock is not restored and the override record is not kept.

**Damage is reported differently from version mismatches.** It raises `PersistenceCorruptionError`. Damage includes:
- a broken hash chain;
- an object whose bytes do not match its name;
- a malformed snapshot reference;
- a structurally invalid document;
- an unknown `journalGenesis`;
- a schema-1 manifest that is not in the legacy format.

The only damage that is repaired automatically is an unterminated last journal line from an interrupted write (`recovery.tornTailBytes`). Stale temporary files and leftover `lock.broken-*` copies are also cleared, and they are counted in `recovery.staleTemporaryFiles`.

This release never writes anything a format-1 reader would refuse:
- **History normalizes first.** It drops unknown transaction fields, and refuses an unknown operation type with `TransactionError`.
- **`commit` checks the result.** An unknown operation or node field raises `PersistenceValidationError` before anything is written.
- **`createProject`** refuses an off-schema document with `PersistenceValidationError`.

## Projects from before the rename

A project written before the product was named Ninerr lives in `<root>/.lilac` (project schema 1, format `lilac-project`).

- `projectLayout(root)` reports `"legacy"` for such a root.
- `openProject` refuses it with a `PersistenceVersionError` and writes nothing.
- `createProject` refuses to create a new project over it.

`migrateLegacyProject` turns it into a Ninerr project:

```js
import { migrateLegacyProject, openProject, projectLayout } from "@lilac/persistence";

if (projectLayout(root) === "legacy") migrateLegacyProject(root, { owner: "my-app", at: new Date().toISOString() });
const store = openProject(root, { owner: "my-app", at: new Date().toISOString() });
store.manifest.journalGenesis; // "lilac-journal-genesis"
```

### What migration guarantees

- **Verify first.** The whole legacy project is verified under its own writer lock before anything is created. That covers its manifest, snapshot, document, the full journal chain, replay, and every object against its hash.
- **Refusals create nothing.** A legacy project that is newer, damaged or still locked by the earlier release is refused, and nothing is created.
- **All or nothing.** The new directory is assembled beside the project and renamed into place, so a crash leaves either no `.ninerr` or a complete one. A leftover `.ninerr.tmp-*` directory is not a project, and migration can simply run again.
- **Exact copy.**
  - The journal, snapshot and objects are copied byte for byte.
  - The manifest becomes schema 2 in the Ninerr format and records the legacy genesis domain.
  - A torn journal tail is carried over and recovered by the first open, as usual.
- **Deterministic.** The same legacy project always produces the same `.ninerr` bytes.
- **The original is never modified.** Its lock is taken and released, as any open does. The earlier release can still open it.
  - Changes made in Ninerr afterwards are not written back to it.
  - Once `.ninerr` exists, it is the project and the legacy directory is ignored.

The studio host does this automatically. A legacy project is listed with the others and migrated the first time it is opened, and the editor says so.

## Host migration steps

`PROJECT_MIGRATIONS` has one built-in step, from schema 1 to 2. It applies only to a manifest in the legacy format, and it also upgrades a schema-1 manifest placed directly in `.ninerr`.

A host that reads pre-release manifests may pass `migrations` for versions without a built-in step. Each step takes a manifest at version `n` and returns version `n + 1`. A built-in step always wins for its own version. A host step that yields schema 1 must yield the legacy format, because schema 1 only ever existed in it.

The migrated manifest is written back atomically once the open succeeds. Documents and journals are not migrated. A project whose document or journal is from another version must be opened by the release that wrote it.

## When a project will not open

- **`PersistenceVersionError` saying "legacy project from before Ninerr".** Migrate it with `migrateLegacyProject` (the studio host does this when the project is opened).
- **`PersistenceVersionError` saying "newer than supported" or "written by a newer Ninerr".** The project was written by a later release; open it with that release.
- **`PersistenceVersionError` saying "no migration from project schema N".** The manifest predates every known schema. Supply a migration step as above.
- **`PersistenceVersionError` saying "no migration from document schema N", or "has field X" or "has node field X, which document schema 1 does not have".** The document is from another schema, or carries fields schema 1 lacks. Only the release that wrote it can read it, because documents are not migrated.
- **`PersistenceCorruptionError`.** The files are damaged. Restore `.ninerr` from a backup or version control. Ninerr does not guess at repairs beyond the torn tail.
- **`PersistenceValidationError` on open.** The project is refused without reading further. Examples:
  - a project file that is a symbolic link;
  - a file over the size limits in `PERSISTENCE_LIMITS`;
  - a project directory that changed during the open.

  A hard-linked journal is refused at the first `commit`, not at open. Check how the directory was copied or mounted.
- **`PersistenceLockError`.** Another writer holds the project, or, for a migration, the earlier release still has the legacy project open. If the previous writer is known to be gone, the host may pass `breakStaleLock: { reason }`, where `reason` is a non-empty string of at most 500 characters.
  - Ninerr does not check whether the holder is still alive; that decision is the host's.
  - The previous holder (or `null`, if its lock was unreadable) and the reason are recorded in the new lock and in `recovery.lockOverride`.
  - Migration never overrides a legacy lock.
