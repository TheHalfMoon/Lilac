# P06 G1b: locale-independent ordering (#103)

Part of P06 gate 1 (#100). This follows G1a (#101).

## Finding

26 `localeCompare` sorts in 6 packages made output order depend on the process locale: agent-runtime, agent-supervisor, decision-router, design-assurance, design-method and import-stack. The spec on #103 first said 27 sorts in 9 packages; it is corrected on the issue. On base `51394584`, the multi-locale test below already differs under `sv_SE.UTF-8` versus `C`. `localeCompare` also treats canonically equivalent but different strings as equal, so their relative order depended on input order.

## Delivered

Every such sort now uses a code-unit comparator, `compareCodeUnits`.
- In import-stack and decision-router it is defined in `validation.ts`, which the package index re-exports. That is an additive export; no existing signature changes.
- Elsewhere it is a module-local helper.
- No dependency was added.

No existing test depended on a locale-produced order.

Identity digests (`proposalId`, ledger `recordId`, `inputSha256`) hash their inputs before these sorts run. Load paths do not check order, so artifacts already stored in locale order still load.

Some sorted keys are hex digests and are locale-invariant by construction: import node and stylesheet ids, and decision `cellId`s.

## Evidence

`tests/locale-independence.test.mjs` has two tests:
- A source guard that fails if `localeCompare(`, `Intl.Collator` or `toLocale(Lower|Upper)Case(` appears in any `.js`, `.cjs`, `.mjs`, `.ts`, `.cts` or `.mts` file under `packages/*/src`.
- One child process per `LC_ALL` (`C`, `en_US.UTF-8`, `sv_SE.UTF-8`, `tr_TR.UTF-8`). Each produces an `importHtmlSnapshot` proposal with attribute names that ICU and code-unit order disagree on (`data-x1`, `data-x_`, `data-xä`, ...), percent-encoded resource URLs that include both `e` + U+0301 and U+00E9, an import ledger, and a `scanDocument` report over locale-sensitive node ids. The outputs must be byte-identical.

Both tests fail on base and pass here.
