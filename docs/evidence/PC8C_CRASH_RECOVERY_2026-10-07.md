# PC8c: crash and recovery through the actual app

PC8c closes PC gate 14: crash and recovery behaviour through the actual app surface.

## What happens on a crash

Lilac commits every change durably before it is confirmed (P06 G10: journal and snapshot, with torn-tail repair and stale-temporary removal). PC1 to PC4 put recovery in the product:
- **Taking over a lock.** A crashed session leaves its lock. Opening the project offers to take it over, with a reason, and only if the lock's process is gone.
- **The recovery report.** It says what recovery did: a discarded unfinished write, removed temporary files, a format upgrade, a lock takeover.
- **Orphaned editors.** An editor whose Lilac has gone says it cannot reach Lilac. It loses nothing it showed, because everything it showed was committed.

## The test

**`tests/crash-recovery.test.mjs`** (Chromium) starts Lilac as a person does (`scripts/lilac.mjs`), under the PC7 no-network preload.

1. **The session.** It creates a project in the editor, adds three boxes and renames one.
2. **Crash 1:** `SIGKILL` with the project open and the editor attached.
   - The lock is left behind.
   - The orphaned editor's next action reports that Lilac could not be reached.
   - Lilac is started again. In the editor, opening the project shows the lock dialog. The takeover with a reason gives a recovery report naming the takeover and its reason.
   - Every change is there: the revision, the layer count and the renamed layer.
3. **Crash 2:** `SIGKILL` in the middle of a burst of edits from another client, with a torn, partly written entry added to the end of the journal.
   - Lilac is started again and the lock taken over, again through the editor.
   - The report names the discarded unfinished write and the takeover.
   - The reopened revision counts every complete journal entry, and includes every change the host confirmed before the kill. Each committed edit of the burst is a layer.
   - The project keeps working: one more edit commits.
4. **Isolation.** No process or page reached anything off this computer. The only console error is the expected 409 when the locked project is first opened.

`tests/support/lilac-process.mjs` holds the helpers that run Lilac and open its links. It adds `kill()`, which is a crash with no cleanup.
