# N0-G9: the independence regression gate

Issue: #190 (N0 umbrella). The founder required an independence regression gate with a narrow, reviewed allowlist.

## The gate
`.github/workflows/ci.yml` runs two steps before the checks:
- `node scripts/identity-census.mjs --verify`: the committed census summary is current;
- `node scripts/identity-census.mjs --check`: no tracked file carries a finding in a gated category.

The test suite enforces the same thing: `tests/identity-census.test.mjs` fails when the repository has any gated finding.

The gated categories are unchanged: active product identity, active internal identity, public API, persisted data, test fixtures and material to remove. Three categories are not gated: legacy compatibility, third-party obligations and immutable historical facts.

## The allowlist
Every rule that admits the old product name, Paper or a donor name is narrow, has a stated reason, and is reviewed. They are in `scripts/identity-policy.json`.

**Whole-line rules.** A rule constrained by line admits a line only when every mention of the old name on it is one of the rule's allowed forms. A sentence beside an allowed construct is therefore still gated.
- `legacy-refusals-in-code` covers the four constructs that recognize the old identity in code. These are the `@(?:ninerr|lilac)` scope refusal in the packaged resolver and in packaging, the renderer's `startsWith("data-lilac")` refusal, and the history view's `(?:ninerr|lilac):` recognition.
- `legacy-identity-tests` covers the old scope, attribute prefix, project format and journal genesis in the four tests that prove they are refused or migrated.
- `legacy-identity-docs` covers the old project directory, format and genesis in `docs/MIGRATION.md` only.
- `public-env` covers the old variable names and the old folder name in `docs/DESKTOP.md` only. Code reads them only in the legacy modules. It moved from the gated public-API category to legacy compatibility, because the variables are now read only as a fallback.
- `legacy-identity-readers` and `legacy-project-fixture` admit the old product name only, never Paper or a donor name.
- `repository-url` covers only the repository's own URL and clone directory, as whole tokens, in the three files that cite them: `docs/CURRENT.md`, `docs/RELEASE.md` and the license register's test. It lasts until N0-G10 renames the repository.

**Provenance and obligations name Ninerr as Ninerr.**
- `third-party-notices` admits donor and Paper names in the notices, the register, the license policy and Electron's license, but not the old product name.
- `donor-provenance-records` covers the provenance ledgers, the provenance records under `docs/provenance` and five per-package provenance modules. Each file is listed by name, so a new file is not admitted. It too admits donor and Paper names only.
- `provenance-history` admits the old name only in the four records made under it: the dated donor study and donor expansion, and the owner's Paper authorization and retired-records list.
- Six `provenance-*` rules each admit one donor in one package module that keeps its own provenance.
- Nine `provenance-test-*` rules each admit only the names of the records that test holds to their facts.
- The `independent-runtime-*` rules cover Impeccable and Docling, which Ninerr invokes, and the tests of Impeccable.

**No living document is exempt.** The program record before the rename is dated evidence (N0-G9a1). `docs/CURRENT.md` and `docs/MASTER_PLAN.md` hold only the current program (N0-G9a2), and the gate checks them like any other file.

## Proof that the rules are narrow
`tests/identity-census.test.mjs` passes the construct each rule was written for, and probes every opening the N0-G9 review found. Each of these probes stays gated:
- **Copy on the same line as an allowed form:** a dialog beside the history-view pattern, a sentence beside the repository URL, a test title beside an allowed scope.
- **An old variable outside the legacy module:** one read in the studio host, or one declared in a test fixture.
- **New prose in a narrowly admitted file:** in the desktop or migration guide, the notices, the register, the living ledger or a provenance module.
- **New or living documents:** a new donor document, and the old name or Paper in the current program pages.
- **A provenance test** naming the old product or another source.

## History of this grain
- **The second review** found three more openings. `repository-url` had no path limit. The legacy readers admitted any term. The provenance records were matched by pattern. All three are closed, and each has a probe.
- **The first allowlist** matched a line rule anywhere in the line, admitted the old variables from any file, and exempted whole files: the program pages, the ledgers and the register. That hid about 80 present-tense uses of the old name. The N0-G9 review found it and showed every opening.
- **N0-G9a1 and N0-G9a2** moved the record before the rename, renamed the living records and restored slim program pages. This grain tightened the rules as described above.

## Also
`trackedFiles` lists each path once. During a merge, `git ls-files` lists a conflicted path once per stage, which made the census overcount mid-merge in N0-G3f.
