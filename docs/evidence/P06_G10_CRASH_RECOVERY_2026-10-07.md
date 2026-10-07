# P06 G10: systematic crash-point injection (#133)

P06 gate 10 (#100) requires systematic crash-point injection: the journal is truncated at every byte offset of its last entries, and atomic writes are interrupted. Each case must either recover to the last durable revision or fail closed with a specific error. It must never silently lose a committed revision.

## Change (`packages/persistence`)

**Problem.** An interrupted `atomicWrite` leaves its temporary (`<target>.tmp-<pid>-<uuid>`) next to the intact target. Open ignored these, but never removed them, so they accumulated.

**Fix.** Open now removes them under the writer lock, through `removeStaleTemporaries` in `fsio.ts`, and reports the count as `recovery.staleTemporaryFiles`. Removal is deliberately narrow:
- Only regular files are removed; directories and symlinks are left alone.
- The name must exactly match a temporary of `project.json`, `snapshot.json`, `journal.log` or an object.
- The `.lilac` directory and the real two-hex object fan-out directories are scanned. An `objects` path that is not a real directory is left to the object store's existing typed checks.

A temporary is never referenced, so removing it loses nothing. The recovery report gains the new field. The one test that pinned its exact shape, the round trip in `tests/persistence.test.mjs`, is updated.

## Tests

`tests/crash-recovery.test.mjs` had 8 tests in the first version; review delta 1 brought it to 10.
- **Tests 1 to 3** pass on base `b320820`. They pin, offset by offset, behaviour that was already correct.
- **Tests 4 to 8** fail on base, because they need the cleanup.

1. **Truncation at every byte offset.** A 6-entry journal with multi-byte text is truncated at every offset of its last 3 entries (904 cases).
   - Each recovers to the last complete, newline-terminated entry, with that revision's document and the exact `tornTailBytes`.
   - The repair is durable: the next open reports 0 torn bytes, and a further commit continues from the recovered head.
2. **With a checkpoint at entry 4.** Truncating below the checkpoint fails closed with `PersistenceCorruptionError` ("snapshot reference points past the end of the journal"). Truncating at or above it recovers.
3. **Byte flips.** Every byte of the last entry is flipped in turn.
   - Each flip either fails closed with `PersistenceCorruptionError`, or, when only the line terminator is lost, recovers the previous revision.
   - Whatever revision opens always has exactly that revision's document.
4. **Interrupted atomic writes of the manifest, snapshot and journal.** The temporary is left empty, partial, or complete but unrenamed, and the complete one holds a later state.
   - Each recovers the last durable revision.
   - The temporary is removed and counted, and the next open counts 0.
5. **Objects.** An interrupted object write (a temporary in a fan-out directory) is cleared. An orphaned object, from a checkpoint interrupted before the snapshot reference moved, is left alone and the previous snapshot is used.
6. **An interrupted torn-tail repair** (a torn journal plus the repair's temporary) is redone on the next open.
7. **An interrupted migration** (the old manifest plus the new one as a temporary) migrates again.
8. **Cleanup scope.** A temp-named directory, a temp-named symlink, a non-UUID name and an unknown target are all left untouched. The symlink's target is unchanged.

## Disposition

A whole-entry truncation at an exact line boundary below the head looks the same as a crash before that commit was written.
- **Why a crash cannot cause it.** A commit is acknowledged only after its newline-terminated line is fsynced, so a real crash cannot produce that state. Only a storage layer that loses fsynced data can.
- **What does catch it.** The checkpoint snapshot is the only independent head record, and losing data below it fails closed (test 2).

Detecting loss above the last checkpoint would need a second, separately fsynced head record. That is recorded here as a residual, not claimed as detected.

## Review delta 1

The judge returned no must-fix. Probes confirmed that cleanup cannot reach outside the project or anything still referenced. Its worth-considering items:

**Product.**
- **Best-effort cleanup.** It used to throw on an unreadable directory or a vanishing entry, which would have refused a project because of garbage. It now leaves anything it cannot list, inspect or remove. Only filesystem (errno) errors are absorbed: while making this change, a dropped declaration turned cleanup into a silent no-op behind a blanket `catch`, so both catches now rethrow anything that is not a filesystem error.
- **Leftover renamed locks.** A lock override renames the stale lock aside before reading it, so a crash in between left a `lock.broken-<uuid>`. It is now removed by the same cleanup and counted in `staleTemporaryFiles`. The previous holder is already recorded in the persisted override.

**Tests.**
- **Byte flips (test 3).** The assertion is strict: every flip fails closed except the terminator flip, which recovers revision 3 with `tornTailBytes` equal to the line length.
- **Checkpoint (test 2).** Every offset is covered.
- **Real orphan (test 5).** A checkpoint is taken in a copy and the old snapshot reference restored. The test asserts the previous snapshot is used, all 3 entries are replayed, and the orphan is kept.
- **Cleanup scope (test 8).** It now also covers a symlinked fan-out directory, a non-hex directory and the `objects` root.
- **New test 9.** A lock left empty or partial fails closed with `PersistenceLockError` until explicitly overridden, and the override records no previous owner.
- **New test 10.** A leftover renamed lock is removed. Test 10 fails on `bf5aa74`.

**Residuals recorded:**
- **Interrupted `createProject`.** It leaves a `.lilac.tmp-<pid>-<uuid>` staging directory beside the project, in the user's directory. It is never cleaned, because nothing in Lilac owns that location. A retry is unaffected: staging names are unique, and creation refuses an existing `.lilac`.
- **Loss above the last checkpoint.** Whole-entry loss there stays undetectable, as described under Disposition.

`tests/crash-recovery.test.mjs` now has 10 tests.
