# P08-G3c: imports through the host under mutated real input

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing HTML, CSS, SVG and import inputs; fail closed.

## What runs
`tests/import-fuzz.test.mjs` starts a studio host with a project and a connected codebase. Each case mutates one or two real inputs:
- **The corpus:** the 45 cases of the malicious-markup corpus (HTML, SVG, CSS), realistic pages, and the JSX fixtures.
- **The mutations:**
  - bytes flipped;
  - markup and syntax characters inserted: `<`, `>`, quotes, `&`, NUL, comment and CDATA openers and closers, `</script>`, JSX braces and fragments, a lone surrogate, CRLF;
  - ranges removed, or repeated up to 400 times (deeper nesting, longer lists, larger input);
  - truncation;
  - two inputs spliced.

Each case then brings the result in through the host in one of three ways:
- **an HTML import:** reviewed, then committed or discarded;
- **code:** brought in, exported, brought in again and exported again;
- **a file in the connected codebase:** scanned, and brought in when it is a component.

The whole file runs with every way out of the computer trapped (`tests/support/no-network.mjs`). Any attempt is refused and reported, and the test watches for those reports.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the cases per seed (default 50). `NINERR_PROPERTY_SEED=<seed>` replays one. Two runs of the default seeds give identical outcomes.
- **Not repeated:** P06's package-level properties, import idempotence (`tests/import-idempotence.test.mjs`) and the code IR round trip (`tests/code-ir-differential.test.mjs`). This grain tests the integrated path through the host.

## What must hold
- **The host never answers 500.** Every refusal names a typed error, and no case takes more than 5 seconds.
- **A refusal changes nothing:** the document and its revision stay as they were.
- **What is committed leaves a valid document.** Code that is brought in exports, and that export brought in again exports the very same code.
- **Nothing tries to reach the network.** The capture was checked to see a trapped attempt.
- **At the end,** closing and reopening the project in a new host gives back exactly the document the session held.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 50 cases pass in 13 s, identically on two runs:**
  - **HTML:** 93 reviewed as ready, of which 75 committed and 18 discarded; 10 refused as `import-refused`.
  - **Code:** 8 brought in, each with a stable round trip; 38 refused as `code-refused`.
  - **Codebase:** 5 components brought in, 27 refused as `code-refused`, 19 files not a component.
- **12 seeds × 50 cases pass in 32 s:**
  - **HTML:** 210 committed and 57 discarded; 25 refused, plus 1 `invalid-import`.
  - **Code:** 32 round trips, all stable; 121 refused.
  - **Codebase:** 18 components brought in, 72 refused, 64 files not a component.

No case made the host answer 500, took more than 5 seconds, changed the document while refusing, or tried to reach the network. Every committed document was valid, and every reopen was exact.

## Not covered here
- **Mirrored imports from the network:** they are off in this release (the offline policy). `tests/import-network-policy.test.mjs` covers them.
- **Hostile names and paths on disk:** P08-G3d.
