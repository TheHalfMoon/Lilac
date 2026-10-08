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

## Review delta 1

The full ps-review panel found one must-fix, and reproduced it. Undoing a write-back's record and confirm transactions restored the old bases while the file kept the new text, which brought back the stale-base overwrite.
- The write-back's steps are now committed as not undoable: `edit(…, { undoable: false })`. Undo cannot take back a file, so undoing them could only make the project disagree with it.
- Tested: the first undo after a write-back reverses the person's own edit, and the bases still describe the file. A later preview then either agrees with the file or offers the undone edit as a change to write, never silently.

Also taken from the panel:
- **A crash between record and rename is recoverable.** The new content is written to a durable temporary file first, and the record names it. While that temporary exists, the rename provably never happened, so the record is withdrawn and the temporary removed. The layer no longer becomes a permanent conflict. Tested by reproducing the post-crash disk state.
- **Records are settled whenever their outcome is known from the file.** `settleWriteBacks` runs when a project opens, and before every preview and write, across every layer bound to every file. That covers several components in one file. The settling commit is not undoable. Tested at unit level, including all three outcomes: landed, not written, and unknown.
- **Source files must be exact UTF-8.** A byte-order mark is kept, and any other file is refused (`source-not-utf8`). The digest of the text is therefore the digest of the bytes, and a write-back rewrites no byte it did not plan. Before, invalid bytes decoded to U+FFFD and were rewritten. Tested.
- The test's two store-failure helpers are now one.

Remaining residual: a write to the file in the microseconds between the last digest check and the rename is lost. Closing that gap would need operating-system file locking. This predates #185.

With records settled on open, the earlier "write-back conflict until the component is brought in again" case now arises only when the file changed in a way that cannot be told apart. That case remains P09 source-UX work.

## Review delta 2

The delta re-review found no must-fix. Taken from it:
- **A failed rename keeps its temporary until the withdrawal is committed.** If the withdrawal fails too, the temporary still proves the rename never happened, and the next settle withdraws the record. Before, the temporary was removed first, which left a permanent conflict. Tested: the record and its temporary stay, then the next preview settles both and offers the change again.
- **Temporary removal never fails a request.** A file held open on Windows, for example by a scanner, is left in place, which is harmless: nothing reads it, as scanning reads only `.jsx` and `.tsx` files. No record names it any more, so it is not retried.
- **Scanning decodes source the same way planning does.** A file that is not exact UTF-8 is not offered for bringing in (tested).
- **Opening a project with a connected codebase** still ignores a folder that cannot be read during settling. A failed store write is now reported as needing a reopen, not swallowed.

## CI on the first PR head

The Desktop journey failed on macOS and Windows at step 4b: it waited for revision 16 after the write-back. A write-back now commits two transactions, the record and then the confirmation, so the journey's later revisions move up by one. The same applies to `tests/codebase-workflow.test.mjs`. Both are updated.

Linux CI showed the same failure, because that test runs in the browser suite. It was skipped on the local Windows machine for lack of Chromium.
