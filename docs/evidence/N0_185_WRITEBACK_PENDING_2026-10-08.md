# #185: write-back followed by a failed project write

Issue: #185. Program: N0 (#190). Builds on N0-G2d.

## Defects proven before the fix

The tests are in `tests/writeback-failure.test.mjs`. The first run was against `7157fa0`, with the journal append refused right after the file was renamed. Evidence is on #185.

1. **The failure was reported as the client's fault.** The response was `400 invalid-edit` ("journal must not be hard-linked"), although the source file had been written. The session was not marked for reopen, because `#storeFailure` decided "store broken" from the error message alone.
2. **Silent overwrite.**
   - After the failure the layer's base still described the old file.
   - An external edit that put the old text back made the file look unchanged and the layer look changed.
   - The next write-back re-applied the layer's value over the external edit.
   - Content alone cannot tell "written, then reverted" from "never written". The file's new state was recorded nowhere durable.

The issue's own hypothesis held for the two paths it named: after a reopen nothing is offered, and a later edit writes back only itself.

## Fix

- **Report it as a failed store.** `ProjectStore.needsReopen` is true after a failed journal write; the store already refuses further commits in that state. The session treats a store in that state as broken, whatever the error message says. A failed journal write is therefore always `409 project-needs-reopen`, never `invalid-edit`. This applies to every edit, not only write-back.
- **Record before renaming.** `writeBack(document, nodeId, folder, token, commit)` performs three committed steps:
  1. **`record`** commits, on each layer whose base the write changes, `codeSource.pending = { base, sha256 }`. These are the bases it writes and the SHA-256 the file will have. If this fails, nothing has been written.
  2. **The rename.** The file is renamed into place. If that fails, or if the file changed since it was planned, **`withdraw`** removes the record.
  3. **`confirm`** commits the new bases and clears the record.
- **Planning resolves records from the file.**
  - When the file's SHA-256 equals a layer's record, the write landed and the recorded bases apply.
  - Otherwise it is unknown whether the file changed before or after that write. The layer is reported as a `write-back` conflict and nothing is written to it.
  - Layers still carrying a resolved record take part in the next write, which settles them.
- **The route** commits each step through the session, with intents "Write N changes back to F", "Confirm the write to F" and "Withdraw the write to F".

## Proven after the fix

| Failure point | Outcome |
|---|---|
| Recording the write | The file is untouched and the response is `project-needs-reopen`. After a reopen the change is offered again and writes normally. |
| Confirming, after the rename | The record survives the reopen. The preview shows nothing to write and no conflicts, and a write is refused as having nothing to write. |
| Confirming, then an external edit restoring the old text | The preview plans nothing and reports a `write-back` conflict. A write is refused, and the external edit stands. |
| Confirming, then a later edit to another field | Only that field is written, and the record is settled. |
| The file changing between record and rename | The rename is refused (`plan-changed`) and the record is withdrawn. The change is offered again on the new file. |
| The same, with the withdrawal failing too | The record stays, and the layer is a conflict; nothing is written. |

The store failure in these tests is real. A second hard link to the journal makes the store refuse its next append, at exactly the step under test. The route's own `writeBack` runs, committing through the real session.

The existing write-back suite (`tests/codebase.test.mjs`) still passes: three-way merge, stale previews, runs of text. Its three Windows failures (symlink EPERM, file mode) are pre-existing (#192).

## Residuals

- **A layer reported as a `write-back` conflict is resolved by bringing the component in again.** Showing the recorded write next to the file, and letting the person choose, is P09 source-UX work.
- **A write-back now adds two history entries:** the write and its confirmation. Grouping them in the history view is P09 work.
