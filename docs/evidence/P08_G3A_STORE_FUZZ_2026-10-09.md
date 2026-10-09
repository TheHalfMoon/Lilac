# P08-G3a: the project store under generated damage

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing project files and journals; hostile sizes and encodings; fail closed.

## What runs
`tests/store-fuzz.test.mjs` builds a real project for each seed: 8 to 20 generated edits, with a checkpoint at the first edit that commits at or after a chosen point. It asserts that the snapshot really is a checkpoint, so both the snapshot and the journal matter. It keeps the document for every journal length, so an earlier state can be checked against the exact state it must be.

Then, for each case, it copies the project, damages it, and opens the copy.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the damaged copies per seed (default 60). `NINERR_PROPERTY_SEED=<seed>` replays one. A seed decides its whole run; two runs of the default seeds give identical outcomes.
- **Cleanup:** every open is closed in a `finally`. Every copy and every host is removed in the seed's `finally`.
- **Real damage only:** damage that would leave a file unchanged is drawn again, so every case really damages the store.

**The damage:**
- **Any file:** bytes flipped, inserted (newline, brace, quote, NUL, a multi-byte character, a fake entry), removed or truncated; text appended; the file emptied, deleted, or replaced by a directory.
- **Encodings:** a UTF-8 byte-order mark, CRLF line endings, a UTF-16 re-encoding, an encoded lone surrogate.
- **Sizes:** a journal line of 4 MiB or more; a manifest or snapshot reference over 64 KiB.
- **The journal:** lines swapped, repeated or dropped; a byte flipped inside the last line only (what a crash mid-append can leave); a name inside one line changed, with the line still valid JSON.
- **The manifest and snapshot reference:** a value changed or removed, or a key added (`extra`, `__proto__`, `createdBy`), with the file still valid JSON.
- **An object, including the one the snapshot uses:** a name inside it changed, still valid canonical JSON.
- **The store itself:**
  - an extra unknown file;
  - the snapshot object's fan-out directory removed;
  - a lock held by someone else;
  - the leftovers of an interrupted write and an interrupted lock override, beside one more damage.

The changed name in a journal line and in the snapshot's object are there because only the hash chain or the object's content hash can tell them from the original.

## What must hold
- **A refused open** throws the store's own typed error (`PersistenceError`). It leaves every file and directory exactly as it found them, leftovers included (#241).
  - **A lock held by someone else** is refused as a lock error (`PersistenceLockError`), and that lock stays.
  - **Otherwise,** no lock is left.
- **An open that succeeds** yields a valid document the project really held:
  - **the latest one**, or
  - **an earlier one,** only when what is left of the journal is a strict prefix of it (its end was cut), and then exactly the state that journal length gave.

  A cut through a line is repaired and reported. A cut between whole lines cannot be told from changes never made (#239).
- **Leftovers** are cleared and counted (`recovery.staleTemporaryFiles`) by an open that succeeds.
- **Opening the result again** gives the very same document, with nothing left to repair: recovery is deterministic.
- **Through the studio host,** every fifth case is opened over HTTP on its own copy. It answers a typed refusal that also changes nothing, or it opens the very document the store opens. It never answers 500. The typed refusals are:
  - 422 `project-unreadable` or `project-version`;
  - 409 `project-locked`, for a lock held by someone else.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 60 cases pass in 40 s, identically on two runs:**
  - 196 refused (164 as corrupt, 19 as invalid, 12 as locked, 1 as a version the store does not know), each with nothing changed;
  - 40 opened at the latest state;
  - 3 opened at an earlier state after a cut through a line, repaired and reported;
  - 1 opened at an earlier state after a cut between lines (#239);
  - through the host: 36 refused with 422, 2 with 409, and 10 opened at the store's document.
- **12 seeds × 60 cases pass in 112 s:**
  - 590 refused;
  - 118 opened at the latest state, 8 after a repaired cut and 4 after a cut between lines;
  - through the host: 119 refused and 25 opened.

No damaged project ever opened as a document it did not hold. None made the host answer 500, and no refusal changed a file.

**Mutation checks** (each change made by hand to `packages/persistence/src`, the test run, the code restored):
- **Without an object's content-hash check** (`objects.ts`), the default run fails: a changed object opens as a state the project never held.
- **Without the journal's hash-chain check** (`verifyLine` in `journal.ts`), the default run fails the same way for a changed line.

  Disabling only half of that condition is still caught, because the line's re-encoding carries a fresh digest. Only removing the whole check lets a changed line through.

## Found
- **#239:** a journal cut between whole lines opens at an earlier state without saying so. The store cannot tell such a cut from changes never made, since nothing records where the journal should end. It is filed with options and counted separately here rather than hidden.
- **#241, fixed in #242:** a refused open deleted the leftover temporaries and broken locks before verifying the project. Since #242, the fuzz checks that a refused open keeps them.

## Not covered here
- **Requests and MCP calls:** P08-G3b.
- **Import inputs** (HTML, CSS, SVG, code): P08-G3c.
- **Hostile names and paths:** P08-G3d.
- **Damage while the project is open:** detected by the store's content pin, and covered by `tests/persistence.test.mjs`.
