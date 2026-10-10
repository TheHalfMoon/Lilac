# P08-G10: the durable migration corpus

Issue: #230 (P08 umbrella), founder section P08.10: a durable migration corpus covering historical, legacy, current, future and corrupt projects. Migration must be deterministic and preserve meaning, and a refusal must change nothing.

**Status:** nineteen project folders, committed under `tests/fixtures/corpus/`. Each says in advance what opening it must do. `tests/migration-corpus.test.mjs` opens every one through the studio host, as the editor opens a project, and every case does what it says. **No defect was found.**

It landed in two parts: #276 (the projects that open) and this one (future and corrupt projects). The split keeps each diff within the exact-head review's size limit.

## How it is built
- **The generator:** `tests/support/migration-corpus.mjs` makes each case from one of the golden fixtures (`tests/fixtures/projects/`) by one small, stated change.
- **Expected outcomes:** each case records its expected outcome, written by hand from the fixture, not taken from what the code does. The golden snapshot stands at entry 2 of 5, so every open replays 3 entries.
- **The corpus is frozen:**
  - `corpus.json` records one SHA-256 over every file, and the test fails if any file changes, is added or is removed;
  - the test also regenerates the corpus and requires the same bytes, so the generator and the files cannot drift apart.
- **To change it on purpose:** `node tests/support/migration-corpus.mjs --write`.

## The cases

| Category | Case | What it is | What opening it must do |
|---|---|---|---|
| Legacy | `legacy-v1` | A project from before the rename (its own directory and format, schema 1) | Open migrated from schema 1. Make a Ninerr copy, and leave the original's every byte as it was |
| Legacy | `legacy-v1-torn-tail` | The same, with its last journal write cut off (a crash of the earlier release) | Open; the copy is repaired (15 torn bytes dropped and reported), and the original keeps its torn tail |
| Historical | `historical-v2` | Project schema 2, from before journal segments | Open, migrated from schema 2 |
| Current | `current-v3` | Project schema 3 | Open; opening and closing it leaves it byte-identical |
| Current | `current-v3-segments` | Schema 3 with an archived journal segment | Open; byte-identical after close |
| Recoverable | `recoverable-torn-tail` | A journal whose last write was cut off | Open, drop the 15 torn bytes, and report them |
| Recoverable | `recoverable-stale-temporary` | A temporary file left by an interrupted save | Open, remove it, and report it |
| Future | `future-manifest-schema` | Project schema 4 | Refuse as `project-version`, and change nothing |
| Future | `future-document-schema` | A document of document schema 2 (its object correctly named by its hash) | Refuse as `project-version`, and change nothing |
| Future | `future-journal-operation` | A correctly chained journal entry with an operation this release does not know | Refuse as `project-version`, not as damage, and change nothing |
| Future | `legacy-v1-future-schema` | A project from before the rename, of a newer schema than any release wrote | Refuse as `project-version`, and create no Ninerr copy |
| Corrupt | `corrupt-journal-chain` | A journal entry changed after it was written | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `corrupt-document-object` | A document object whose bytes no longer match its name | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `corrupt-missing-object` | A document object that is gone | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `corrupt-object-fan-out` | An object fan-out folder that is a file (on Windows it would read as a missing object) | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `corrupt-snapshot` | A snapshot reference that is not JSON | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `corrupt-snapshot-past-end` | A snapshot reference past the end of the journal | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `corrupt-manifest` | A manifest that is not JSON | Refuse as `project-unreadable`, and change nothing |
| Corrupt | `legacy-v1-corrupt-chain` | A project from before the rename with a journal entry changed after it was written | Refuse as `project-unreadable`, and create no Ninerr copy |

The corrupt cases are a sample of the damage the store detects; `tests/persistence.test.mjs` and the store fuzz cover the rest at the store's level.

## What each case is held to
- **The document is preserved:** a case that opens must open to the document this release writes for the same history, compared as canonical JSON.
  - That reference is built from code (`tests/support/golden-project.mjs`), not from the corpus, so a corpus file cannot vouch for itself.
  - Its SHA-256 is also pinned by hand in the test, so a reader that misread the corpus and the reference alike would still be caught.
- **The history is preserved:** every journal entry, with its actor, tool, intent, metadata and timestamp, must equal the golden history entry by entry.
  - A legacy project keeps its own entries exactly as they were written, old tool names included: migration copies history and never rewrites it.
  - With only the package scope from before the rename swapped, that history must equal the golden one.
- **The recovery report is exact:** what the host says it did on opening (torn bytes dropped, temporaries removed, entries replayed, the version migrated from, and that a legacy project was copied) must equal a report written by hand for each case.
- **Refusals change nothing,** in the project or anywhere in the projects folder. Each case's projects folder first gets what a person's has, an agent registry from a real host run. Every file's SHA-256 before and after the open, and the set of files, must be the same. A project that opens changes nothing beside itself either.
- **The right reason:** each refusal is a 422 with the host's error code, and its message must name the exact cause (for example "journal line 1 breaks the hash chain"), not just a word shared with other causes.
  - A newer format is refused as a version problem, never reported as damage.
  - The future journal entry is chained correctly, so the open reaches the format check instead of stopping at the chain.
- **The legacy original is untouched:** after the open, its directory holds exactly the files it did, byte for byte.
- **Deterministic:** every case is opened twice, each time from a fresh copy. The answers, documents, journals and every file afterwards must be the same.
- **Migration happens once:** the first open of a legacy or historical project reports the version it migrated from (1 or 2); a second open reports none and changes nothing.

## The test is not vacuous
Hand mutations each fail it, and each was restored:

| Mutation | Fails |
|---|---|
| The host reporting a version error as damage | Every case refused as `project-version` (4) |
| A refused open writing a file into the project | Every refused case |
| A refused open deleting the person's agent registry beside the project (the reviewer's) | Every refused case (12) |
| One byte added to a corpus file | The frozen-corpus check |
| The v2 migration rewriting each entry's actor and tool and dropping its metadata (the reviewer's) | `historical-v2` |
| The host no longer reporting a legacy migration (the reviewer's) | Both legacy cases and the migrate-once test |

The first version of the test missed the last two. The review of #276 found them, and the history and recovery checks above were added for them.

## Not covered here
- **The founder's own historical projects:** none were provided, so the corpus is built from the golden fixtures. The dogfooding projects of P08-G11 can add real ones.
- **Migration from releases that never shipped:** Ninerr has no published release yet (v1.0.0 is not authorized).
- **The archived segment's entries** are not compared entry by entry, only the current segment's. The segmented case must stay byte-identical, which covers the archive.
