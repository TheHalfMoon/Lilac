# P08-G3c: imports through the host under mutated real input

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing HTML, CSS, SVG and import inputs; fail closed.

## What runs
`tests/import-fuzz.test.mjs` starts a studio host with a project and a connected codebase. Each case mutates one or two real inputs:
- **The corpus:** the 44 HTML cases of the malicious-markup corpus (with SVG and CSS inside them), realistic pages, and the JSX fixtures.
- **The mutations:**
  - bytes flipped;
  - markup and syntax characters inserted: `<`, `>`, quotes, `&`, NUL, comment and CDATA openers and closers, `</script>`, JSX braces and fragments, a lone surrogate, CRLF;
  - ranges removed, or repeated up to 400 times (deeper nesting, longer lists, larger input);
  - truncation;
  - two inputs spliced.

Each case then brings the result in through the host in one of three ways:
- **an HTML import:** reviewed, then committed or discarded;
- **code:** brought in, exported, brought in again and exported again;
- **a file in the connected codebase:** scanned, and brought in when it is a component. Most files are written as UTF-8; some have a byte-order mark, are UTF-16, or are not text at all.

**Limits.** Each seed first brings in inputs at and past each limit:
- an HTML page over 4 MiB;
- HTML nested past the depth limit;
- HTML past the node limit;
- code over 256 KiB;
- a source file over 256 KiB.

The whole file runs with every way out of the computer trapped (`tests/support/no-network.mjs`). Any attempt is refused and reported, and the test watches for those reports.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the cases per seed (default 50). `NINERR_PROPERTY_SEED=<seed>` replays one. Two runs of the default seeds give identical outcomes.
- **Not repeated:** P06's package-level properties, import idempotence (`tests/import-idempotence.test.mjs`) and the code IR round trip (`tests/code-ir-differential.test.mjs`). This grain tests the integrated path through the host.

## What must hold
- **The host never answers 500.** Every refusal names a typed error, and no case takes more than 5 seconds.
- **A refusal says what is wrong with the input,** not what went wrong in the engine. The host turns a parser's exception into a typed refusal, so a crash (a `TypeError`, a stack overflow) would otherwise pass as one. Its message must not read like an engine error. Refusals are also counted by message, so the kinds are visible.
- **A refusal changes nothing:** the document and its revision stay as they were.
- **What is committed leaves a valid document.** Code that is brought in exports, and that export brought in again exports the very same code.
- **Nothing tries to reach the network.** At the end, the test makes one deliberate attempt, and the watch must see it.
- **Coverage:** a full run must commit an HTML import, round-trip code and bring in a codebase component.
- **At the end,** closing and reopening the project in a new host gives back exactly the document the session held.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × (5 limit inputs + 50 cases) pass in 18 s, identically on two runs:**
  - **Limits:** each refused by name, as `import-too-large`, the DOM depth and node limits, and `code-too-large`. A source file over the limit is not listed as a component.
  - **HTML:** 94 reviewed as ready, of which 74 committed and 20 discarded; 18 refused as `import-refused`, each naming the problem (no importable nodes, depth or node limits).
  - **Code:** 9 brought in, each with a stable round trip; 34 refused, each naming the construct it cannot bring in (unparseable JSX, an unsupported attribute, a stray angle bracket, the token budget).
  - **Codebase:** 2 components brought in and 23 refused; 32 files not a component, including those that are not UTF-8.
  - **No engine error** behind any refusal.

No case made the host answer 500, took more than 5 seconds, changed the document while refusing, or tried to reach the network. Every committed document was valid, and every reopen was exact.

## Not covered here
- **Mirrored imports from the network:** they are off in this release (the offline policy). `tests/import-network-policy.test.mjs` covers them.
- **Hostile names and paths on disk:** P08-G3d.
