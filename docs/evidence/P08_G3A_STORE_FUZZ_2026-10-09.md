# P08-G3a: the project store under generated damage

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing project files and journals; fail closed.

## What runs
`tests/store-fuzz.test.mjs` builds a real project for each seed: 8 to 20 generated edits, with a checkpoint part-way, so both the snapshot and the journal matter. It keeps every document the project ever held. Then, for each case, it copies the project, damages one file and opens the copy.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the damaged copies per seed (default 60). `NINERR_PROPERTY_SEED=<seed>` replays one. A seed decides its whole run; two runs of the default seeds give identical outcomes.
- **Cleanup:** every copy and every host is removed in the seed's `finally`.

**The damage:**
- **Any file:** bytes flipped, inserted (newline, brace, quote, NUL, a multi-byte character, a fake entry), removed or truncated; text appended; the file emptied.
- **The journal:** lines swapped, repeated or dropped; a byte flipped inside the last line only (what a crash mid-append can leave); a name inside one line changed, with the line still valid JSON.
- **The manifest and snapshot reference:** a value changed or removed, or a key added (`extra`, `__proto__`, `revision`), with the file still valid JSON.
- **An object, including the one the snapshot uses:** a name inside it changed, still valid canonical JSON.

The last two kinds, a changed name in a journal line and in the snapshot's object, are there because only the hash chain or an object's content hash can tell them from the original.

## What must hold
- **A refused open** throws the store's own typed error (`PersistenceError`). It leaves every file exactly as it found them, and no lock.
- **An open that succeeds** yields a valid document that is exactly one the project really held:
  - **the latest one**, or
  - **an earlier one,** only when what is left of the journal is a prefix of the original journal (its end was cut).

  A cut through a line is repaired and reported. A cut between whole lines cannot be told from changes never made (#239).
- **Opening the result again** gives the very same document, with nothing left to repair: recovery is deterministic.
- **Through the studio host,** every fifth case is opened over HTTP on its own copy. It answers 422 with `project-unreadable` or `project-version`, never a 500, or it opens the very document the store opens.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 60 cases pass in 18 s, identically on two runs:**
  - 206 refused (204 as corrupt, 2 as a version the store does not know), each with every file unchanged and no lock;
  - 24 opened at the latest state;
  - 9 opened at an earlier state after a cut through a line, repaired and reported;
  - 1 opened at an earlier state after a cut between lines (#239);
  - through the host: 41 refused with 422 and 7 opened at the store's document.
- **12 seeds × 60 cases pass in 52 s:**
  - 630 refused;
  - 68 opened at the latest state, 15 after a repaired cut and 7 after a cut between lines;
  - through the host: 125 refused and 19 opened.

No damaged project ever opened as a document it did not hold, and none made the host answer 500.

**Mutation checks** (each change made by hand to `packages/persistence/src`, the test run, the code restored):
- **Without an object's content-hash check** (`objects.ts`), the default run fails: a changed object opens as a document the project never held.
- **Without the journal's hash-chain check** (`verifyLine` in `journal.ts`), the default run fails the same way for a changed line.

  An earlier attempt disabled only half of that condition. It was still caught, because the line's re-encoding carries a fresh digest. Only removing the whole check lets a changed line through.

## Found
- **#239:** a journal cut between whole lines opens at an earlier state without saying so. The store cannot tell such a cut from changes never made, since nothing records where the journal should end. It is filed with options, and the evidence counts it separately rather than hiding it.

## Not covered here
- **Requests and MCP calls:** P08-G3b.
- **Import inputs** (HTML, CSS, SVG, code): P08-G3c.
- **Hostile names and paths:** P08-G3d.
- **Damage while the project is open:** detected by the store's content pin, and covered by `tests/persistence.test.mjs`.
