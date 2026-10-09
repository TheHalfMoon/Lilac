# N0-G9: the independence regression gate

Issue: #190 (N0 umbrella). The founder required an independence regression gate with a narrow, reviewed allowlist.

## The gate
`.github/workflows/ci.yml` runs two steps before the checks:
- `node scripts/identity-census.mjs --verify`: the committed census summary is current;
- `node scripts/identity-census.mjs --check`: no tracked file carries a finding in a gated category.

The test suite enforces the same thing: `tests/identity-census.test.mjs` fails when the repository has any gated finding. At this commit the census scans 527 files and finds no gated findings.

The gated categories are unchanged: active product identity, active internal identity, public API, persisted data, test fixtures and material to remove. Three categories are not gated: legacy compatibility, third-party obligations and immutable historical facts.

## The allowlist
Every rule that admits the old product name, Paper or a donor name is narrow, has a stated reason, and is reviewed. They are in `scripts/identity-policy.json`, and they are ordered before the catch-all rules.

- **Legacy compatibility.**
  - `legacy-refusals-in-code` admits only the four constructs that recognize the old identity in code. These are the `@(?:ninerr|lilac)` scope refusal in `packages/desktop/src/resolve.mjs` and `scripts/package-desktop.mjs`, the renderer's `startsWith("data-lilac")` refusal, and the history view's `(?:ninerr|lilac):` recognition. Each is matched by its exact line, so any other mention of the old name in those files is gated.
  - `legacy-identity-tests` admits the old scope, attribute and format, matched by line, in the four tests that prove they are refused or migrated.
  - `legacy-identity-docs` covers the migration guide and the desktop guide's note on the old folder and variable.
  - `public-env` covers the old environment variables, which Ninerr reads only as a fallback with a notice.
  - `repository-url` admits only the repository's own URL and clone directory. N0-G10 renames the repository and removes the need for it.
- **Historical facts.**
  - `donor-provenance-records` covers the provenance ledgers and the per-package provenance files.
  - Six per-file rules (`provenance-*`) each admit one donor name in one package module that keeps its own provenance.
  - `program-history` covers the program state and the plan, whose earlier sections are the record before the rename.
  - `provenance-and-license-tests` covers the tests that hold those records to their facts.
- **Third-party obligations.**
  - `third-party-notices` covers the notices, the register, the license policy and Electron's license.
  - The `independent-runtime-*` rules cover Impeccable and Docling, which Ninerr invokes, and the tests of them.

`tests/identity-census.test.mjs` proves that each rule is narrow. The construct a rule was written for passes, and the following stay gated:
- new product copy in the same file;
- a comment naming the old product;
- a test title naming it;
- another donor in a provenance module;
- a donor name outside provenance;
- product prose beside the repository URL;
- Paper in a current document.

Writing that test caught one rule that was too broad: one provenance rule paired any of its files with any of its donors. It is now one rule per file and donor.

## Also
`trackedFiles` lists each path once. During a merge, `git ls-files` lists a conflicted path once per stage, which made the census overcount mid-merge in N0-G3f.
