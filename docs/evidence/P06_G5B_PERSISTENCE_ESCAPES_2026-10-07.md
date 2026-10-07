# P06 G5b: persistence sandbox escapes (#115)

Part of P06 gate 5 (#100). The findings come from the gate-5 probe of base `f4aafd8`. The details and residual are recorded in the addendum to `P05_D6A_PERSISTENCE_2026-10-06.md`.

## Tests

`tests/sandbox-persistence.test.mjs` has 13 tests.

**Escapes.** These six fail on base:
1. A FIFO in place of the snapshot, manifest or journal is refused instead of hanging. The test runs in a child process with a 15 s timeout, so a regression fails the test rather than hanging the suite.
2. A FIFO in place of the lock is refused instead of hanging. Also run in a child process with a timeout; on base the in-process version hung the run.
3. Writes are refused after the root is swapped for a symlink, and nothing is written outside the project.
4. Writes are refused after `.lilac` is replaced by a fresh directory.
5. An `objects` path that is a regular file fails with a typed error.
6. A hard-linked lock is treated as unreadable. Its outside contents do not enter the override record, and the outside file is untouched.

**Gaps that already failed closed.** These four had no test before:
7. Symlinked object fan-out directories and objects directories are refused at checkpoint.
8. A hard-linked snapshot is replaced by atomic rename, never rewritten in place.
9. Malformed object ids, and NUL, relative, `~` and `file:` roots, are refused.
10. Recovering a torn journal tail replaces the journal atomically. Nothing is written through a hard link, and later appends go to the new, singly linked journal.

**Review delta 1.** Tests 11 and 13 fail on the pre-delta head `5f5afd9`; test 12 is a guard against false positives.

11. A root swapped during `openProject`, at its first look at the journal, through an `lstat` hook in a child process, is refused, and the outside lock is left alone.
12. A legitimately symlinked root opens, commits and checkpoints.
13. `close()` after the root moved leaves the lock instead of touching the other directory.

FIFO tests are skipped where `mkfifo` is unavailable; CI runs on Linux.
