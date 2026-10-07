# P06 G11: file migration and version compatibility (#136)

P06 gate 11 (#100) requires file migration and version compatibility.
- A project written by this release must reopen byte-stably from a committed golden fixture.
- Every on-disk version boundary must either open through a registered migration or fail closed with `PersistenceVersionError`. The boundaries are the project manifest schema, the document schema and the journal format.
- Data from another version is never silently replayed with fields dropped, and never reported as corruption.

## Probe at main `9160be2`

| Boundary | Change | Before |
| --- | --- | --- |
| Manifest | `schemaVersion` 2, 0, -1, 1.5, `"1"`, `null` | `PersistenceVersionError`; 0 migrates through `options.migrations`. Correct. |
| Snapshot reference | extra or missing field | `PersistenceCorruptionError` "snapshot reference is malformed". Correct. |
| Journal entry | extra field on the entry | `PersistenceCorruptionError` (hash chain). Correct. |
| Journal transaction | unknown transaction field, re-chained | **replayed silently**, field dropped |
| Journal operation | unknown field on an operation, re-chained | **replayed silently**, field dropped |
| Journal node | unknown field on an inserted node, re-chained | **replayed silently**, field dropped |
| Journal operation | unknown operation type | refused, but as corruption |
| Document object | `schemaVersion` 0 or 2 | `PersistenceCorruptionError`, not a version error |

The silent replays are fail-open: history drops fields it does not know, so a journal written by a newer Lilac would open with that writer's meaning lost and no signal.

## Change (`packages/persistence`)

**Journal format 1** (`journal.ts`). Format 1 is the exact field set written by project schema 1:
- transactions;
- each of the five operation types (`insert-node`, `remove-node`, `restore-subtree`, `set-props`, `move-node`);
- node records.

`assertJournalFormat` reports the first departure. It is enforced at two points:
- **On open.** Every journal entry is checked before replay, including entries the snapshot already covers. A departure raises `PersistenceVersionError` naming the entry and the field ("...written by a newer Lilac").
- **On commit.** The persisted transaction is checked before its line is encoded. A departure raises `PersistenceValidationError`, so this release never writes an entry its own reader would refuse.

**Document schema** (`store.ts`, `loadDocument`). An integer `schemaVersion` other than `DOCUMENT_SCHEMA_VERSION` raises `PersistenceVersionError`. A larger value reads "newer than supported"; a smaller one reads "no migration from document schema N". Other malformed documents remain corruption.

## Golden fixture

`tests/fixtures/projects/v1-basic/.lilac` is a schema-1 project written by `tests/support/golden-project.mjs`, with fixed ids and timestamps. It holds:
- a genesis document object and a checkpoint document object;
- 4 journal entries, 2 below the checkpoint and 2 above it;
- set-props (with and without `unset`), insert-node, move-node and remove-node operations.

## Tests

`tests/migration-compatibility.test.mjs` has 7 tests. On base `9160be2` with the new test files, tests 1 to 3 and 6 pass; they pin behaviour that was already correct. Tests 4, 5 and 7 fail, because they need this change.

1. **Golden reopen.** The fixture opens at revision 4 with the recorded document, and replays the 2 entries above the checkpoint. Open plus close leaves every file byte-identical. A further commit and a reopen continue at revision 5.
2. **No format drift.** This release regenerates the fixture byte-for-byte, and every object file is named by the sha256 of its bytes.
3. **Manifest matrix.** 2 and 99 are newer. 0 has no migration. -1, 1.5, `"1"` and `null` are not integers. All are `PersistenceVersionError`, and a refused open releases the lock. A registered step migrates 0 to the golden manifest bytes exactly.
4. **Document schema 0 and 2** (written as a valid content-addressed object) raise `PersistenceVersionError`.
5. **Journal format departures**, re-chained so only the edit differs, each raise `PersistenceVersionError` naming the entry and field:
   - an unknown transaction field;
   - an unknown operation type;
   - an unknown operation field;
   - an unknown node field;
   - an unknown field in an entry the snapshot already covers.

   A control case re-chains an unedited journal, and it opens unchanged.
6. **Still corruption.** An entry-level extra field raises `PersistenceCorruptionError` (hash chain), as does a snapshot reference with an extra or missing field.
7. **Commit refuses before writing.** An unknown operation field and an unknown node field each raise `PersistenceValidationError`, the journal prefix stays byte-identical, and a valid commit afterwards reopens.

## Scope

- Migration remains a manifest-level, opt-in hook. `PROJECT_MIGRATIONS` is empty because schema 1 is the first released schema, and hosts reading pre-release projects pass `options.migrations`.
- User-facing migration documentation is the P07 "migration docs" artifact.
- **Residual: permissive node records.** `validateDocument` accepts node records with keys outside the format-1 set, and `createProject` stores them.
  - History rebuilds every inserted or restored node through `createNode`, which drops such keys.
  - So a `remove-node` of such a node produces an inverse `restore-subtree` that this change now refuses at commit with `PersistenceValidationError`, instead of silently dropping the key on undo.
  - The fix belongs upstream, in document validation or normalization, and is tracked separately rather than widened here.
- **Gate run.** `npm run check` in the worktree ran 613 tests: 610 passed, 2 failed and 1 was skipped.
  - "address classification is owned here and re-exported unchanged by import-stack" fails only because the worktree's `node_modules` is a symlink.
  - "a failed journal write poisons the store until reopen" fails only when run as root.
  - Both pass in CI.
