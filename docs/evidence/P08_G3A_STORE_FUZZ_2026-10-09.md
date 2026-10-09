# P08-G3a: the project store under generated damage

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing project files and journals; hostile sizes and encodings; fail closed.

## What runs
`tests/store-fuzz.test.mjs` builds a real project twice for each seed: 8 to 20 generated edits, a checkpoint at the first edit that commits at or after a chosen point, and one more edit after it. It keeps the document for every journal length, so an earlier state can be checked against the exact state it must be.
- **Closed cleanly.** Since #239, a clean close after changes checkpoints at the journal's last entry. The test asserts the snapshot stands there.
- **As a crash leaves it.** The writer stops without closing, and its lock is gone, as after an override. The test asserts the snapshot is still at the checkpoint part-way, so both the snapshot and the journal matter.

Then, for each case, it copies one of the two, damages it, and opens the copy.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the damaged copies per seed (default 60). `NINERR_PROPERTY_SEED=<seed>` replays one. A seed decides its whole run; two runs of the default seeds give identical outcomes.
- **Cleanup:** every open is closed in a `finally`. Every copy and every host is removed in the seed's `finally`.
- **Real damage only:** damage that would leave a file unchanged is drawn again, so every case really damages the store.

**The damage:**
- **Any file:** bytes flipped, inserted (newline, brace, quote, NUL, a multi-byte character, a fake entry), removed or truncated; text appended; the file emptied, deleted, or replaced by a directory.
- **Encodings:** a UTF-8 byte-order mark, CRLF line endings, a UTF-16 re-encoding, an encoded lone surrogate.
- **Sizes:** a journal line of 4 MiB or more; a manifest or snapshot reference over 64 KiB. The manifest and snapshot are padded with whitespace, which JSON allows, so only their size limit can refuse them. The oversize journal line is also malformed, so it shows that a huge line is refused without a crash or a hang, not that the size limit alone refuses it.
- **The journal:** lines swapped, repeated or dropped; a byte flipped, or a cut, inside the last line only (what a crash mid-append can leave); a name inside one line changed, with the line still valid JSON.
- **The manifest and snapshot reference:** a value changed or removed, or a key added (`extra`, `__proto__`, `createdBy`), with the file still valid JSON.
- **An object, including the one the snapshot uses:** a name inside it changed, still valid canonical JSON.
- **The store itself:**
  - an extra unknown file;
  - the snapshot object's fan-out directory removed;
  - a lock held by someone else;
  - the leftovers of an interrupted write and an interrupted lock override, beside one more damage to a file.

The changed name in a journal line and in the snapshot's object are there because only the hash chain or the object's content hash can tell them from the original.

## What must hold
- **A refused open** throws the store's own typed error (`PersistenceError`). It leaves every file and directory exactly as it found them, leftovers included (#241).
  - **A lock held by someone else** is refused as a lock error (`PersistenceLockError`), and that lock stays.
  - **Otherwise,** no lock is left.
- **An open that succeeds** yields a valid document the project really held.
  - **A cleanly closed project** opens at its latest state or not at all. Any cut of its journal no longer reaches its snapshot, and is refused (#239).
  - **A crashed project** opens at its latest state, or at an earlier one only when what is left of the journal is a strict prefix of it, and then at exactly the state that journal length gave. A cut through a line is repaired and reported. A cut between whole lines after a crash cannot be told from changes never made: nothing has recorded where the journal ends since the last checkpoint.
- **Leftovers** are cleared and counted (`recovery.staleTemporaryFiles`) by an open that succeeds.
- **Opening the result again** gives the very same document, with nothing left to repair: recovery is deterministic.
- **Through the studio host,** every fifth case is opened over HTTP on its own copy. It answers a typed refusal that also changes nothing, or it opens the very document the store opens. It never answers 500. The typed refusals are:
  - 422 `project-unreadable` or `project-version`;
  - 409 `project-locked`, for a lock held by someone else.
- **Coverage:** a full run must reach every outcome that matters:
  - both kinds of project, opened and refused;
  - a crash's cut through a line, repaired;
  - all three host answers.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 60 cases pass in 11 s, identically on two runs:**
  - **cleanly closed (123 cases):** 93 refused, each with nothing changed, and 30 opened at the latest state. None opened at an earlier state;
  - **crashed (117 cases):** 103 refused, 9 opened at the latest state, and 5 at an earlier state after a cut through a line, repaired and reported;
  - **through the host:** 35 refused with 422, 3 with 409, and 10 opened at the store's document.
- **12 seeds × 60 cases pass in 29 s:**
  - **cleanly closed (359 cases):** 294 refused and 65 opened at the latest state. None opened at an earlier state;
  - **crashed (361 cases):** 302 refused, 47 opened at the latest state, 10 after a repaired cut through a line, and 2 after a cut between whole lines;
  - **through the host:** 116 refused and 28 opened.

No damaged project ever opened as a document it did not hold. None made the host answer 500, and no refusal changed a file.

**Mutation checks** (each change made by hand to `packages/persistence/src`, the test run, the code restored):
- **Without an object's content-hash check** (`objects.ts`), the default run fails: a changed object opens as a state the project never held.
- **Without the journal's hash-chain check** (`verifyLine` in `journal.ts`), the default run fails the same way for a changed line.

  Disabling only half of that condition is still caught, because the line's re-encoding carries a fresh digest. Only removing the whole check lets a changed line through.
- **Without the checkpoint a clean close makes (#239)** (`close()` in `store.ts`), the default run fails: a cleanly closed project's snapshot no longer stands at the journal's end.

## Found
- **#239, fixed in the PR that closes it:** a journal cut between whole lines opened at an earlier state without saying so. Nothing recorded where the journal should end. A clean close after changes now checkpoints at the journal's last entry, so a cut while the project is closed is refused. After a crash, a cut between whole lines since the last checkpoint still cannot be detected. This is a limit of an append-only journal, and `docs/MIGRATION.md` states it.
- **#241, fixed in #242:** a refused open deleted the leftover temporaries and broken locks before verifying the project. Since #242, the fuzz checks that a refused open keeps them.

## Not covered here
- **Requests and MCP calls:** P08-G3b.
- **Import inputs** (HTML, CSS, SVG, code): P08-G3c.
- **Hostile names and paths:** P08-G3d.
- **Damage while the project is open:** detected by the store's content pin, and covered by `tests/persistence.test.mjs`.
