# P06 G1b: locale-independent ordering (#103)

Part of P06 gate 1 (#100). This follows G1a (#101).

## Finding

27 sorts in 9 packages used `localeCompare`: agent-runtime, agent-supervisor, decision-router, design-assurance, design-method and import-stack. That made the output order depend on the process locale. On base `51394584`, the multi-locale test below already differs under `sv_SE.UTF-8` versus `C` for an import proposal, an import ledger and a design-assurance report. `localeCompare` also ranks canonically equivalent but different strings as equal, so their order depended on input order.

## Delivered

- Every such sort now uses a code-unit comparator, `compareCodeUnits`. It is exported from the import-stack and decision-router `validation.ts`, and is a module-local helper in agent-runtime `session.ts`, agent-supervisor `local.ts`, design-method `evaluate.ts` and design-assurance `index.mjs`. No dependency was added and no public signature changed.
- No existing test depended on a locale-produced order. The suite stayed at 433 of 433 before the new tests were added.
- Identity digests (`proposalId`, ledger intent hashes) and the key-sorted canonical stringifiers do not depend on these sorts.

## Evidence

`tests/locale-independence.test.mjs` has two tests:
- A source guard that fails if `localeCompare(` appears in `packages/*/src`.
- One child process per `LC_ALL` (`C`, `en_US.UTF-8`, `sv_SE.UTF-8`, `tr_TR.UTF-8`). Each produces an `importHtmlSnapshot` proposal (node keys, attribute keys, resources, stylesheets), an import ledger, and a `scanDocument` report over locale-sensitive ids. The outputs must be byte-identical.

Both tests fail on base and pass here.
