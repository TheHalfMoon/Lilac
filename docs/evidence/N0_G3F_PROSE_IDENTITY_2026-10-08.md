# N0-G3f: the product name in code comments, messages and test titles

Issue: #190 (N0 umbrella). The product name `Lilac` becomes `Ninerr` throughout:
- the packages' source, and their READMEs;
- code comments and user-visible messages;
- test titles and names, and temporary-directory prefixes.

A few renamed literals reach runtime output. None is persisted, compared by product code, or part of a stored format:
- the browser wrapper's and design-assurance scanner's temporary-folder prefixes (`ninerr-browser-`, `ninerr-design-assurance-`);
- the rule pack's local provenance `source` (`ninerr-rule-pack`);
- the import stack's User-Agent (`NinerrImportStack/1`);
- the operation type that one authority test uses as sample data (`ninerr.document.request`).

## Not renamed
- **Deliberate legacy references.**
  - Every `legacy.ts` module and its tests.
  - The packaged resolver's and packaging's scope pattern `/^@(?:ninerr|lilac)\//iu`, which recognizes the old scope so that it can be refused.
  - The history view's recognition of `lilac:` tools.
  - Test values that stand for the legacy format (`lilac-project`, `lilac-journal-genesis`).
- **Elsewhere:**
  - fixtures;
  - dated evidence;
  - the repository URL, until N0-G10;
  - the Paper recovery tooling, which N0-G5 removes.

## Found while qualifying
The first run of the rename also rewrote five deliberate legacy references. Among them was `(?:ninerr|lilac)` in the packaged resolver's refusal pattern, which would have re-opened the gap N0-G3a closed. The suite caught every one: `tests/desktop-package.test.mjs` and `tests/migration-compatibility.test.mjs`. All five are restored, and both suites pass.

## Split
The whole change exceeded the exact-head reviewer's context, so it lands in two halves.
- **N0-G3f1** renames the packages' source and READMEs and this note. It also carries the tests that assert renamed product text:
  - the editor's dialog titles, including crash recovery;
  - the browser wrapper's temporary-folder prefix;
  - the codebase link messages;
  - the serving and accessibility checks;
  - the authority tests' sample operation type;
  - the license register's source scan.

  The first split missed `codebase` and `app-crash-recovery`, because on Windows both already fail for unrelated reasons (#192). The review panel caught them. The check now also scans every test outside this half for renamed product text. Those tests move together with the product text they check.
- **N0-G3f2** renames the remaining test titles, comments and helper prose, and the scripts' prose. None of it changes what a test checks.
