# N0-G11b: the repository cleanup, part two

Issue: #190 (N0 umbrella). This grain finishes the cleanup audit of N0-G11a. It covers the donor records, the architecture overview and the MCP doc.

## The donor records
- **The integration map is now dated evidence.** It was the plan that allocated the donors to grains 1 to 9, written in the future tense. All nine grains have shipped, so it moved unchanged to `docs/evidence/DONOR_INTEGRATION_MAP_2026-10-09.md`, dated by its last update.
- **The donor study** moved unchanged from the `docs/` root to `docs/evidence/DONOR_DEEP_STUDY_2026-10-03.md`.
- **The references to both files** now use the new paths: the license register's evidence strings, the license register's test that reads the ledgers, and `docs/DONORS.md`. In the identity policy, the dated-evidence rule now covers them, so their paths left the `provenance-history` and `donor-provenance-records` rules.
- **`docs/DONORS.md`** now states what the license register records:
  - **Paper.** The present-tense recovery status lines (the Desktop builds, package files, web bundles and extension) became three lines in the past tense. The monorepo was not available through connected GitHub sources, a partial recovery was studied and later retired (N0-G5), and no recovered source was ever committed. The authorization basis and the public-repository boundary are unchanged.
  - **The three Paper repositories marked "pending exact license check"** now carry the register's results: no license file for two, PolyForm Shield 1.0.0 for `liquid-logo`. All three are reference only.
  - **`vcashwin/paper-snapshot` and Doop** were described as donors for intake and collaboration. They are reference only, nothing was copied, and the register and `packages/collaboration/src/provenance.ts` record this.
  - **The donor table** now says that its middle column is the use intended at intake, and that actual use, category and license are in the register.

The founder's authorization statements in the ledger are unchanged.

## The architecture overview
- **Title and structure.** The document was titled "Target Architecture" and opened with a target tree of directories that do not exist. It is now "Ninerr Architecture". A new section lists the 26 packages that exist today, and the tree is headed as the target layout.
- **Stale plans.** "Do not choose a CRDT library until the donor baseline is inspected" and "The PC phase adds one Node studio host" describe a past plan. They now state the current facts.
- **Persistence.** Local mode stores projects as files with no service, so the persistence line now says that.
- **The desktop boundary** separates what the shell owns today from what is planned. Today it owns filesystem access through the host, the MCP lifecycle, the sandboxed window that loads the editor, and menus. Planned are local fonts, credential storage and updates, none of which is in `packages/desktop/src`.
- **The acceptance tests** now cite the test files that cover each one.

## The MCP doc (unchanged)
The table of tool names before the rename is kept. History entries recorded before the rename keep the tool name they were made with, so the table is what a reader needs to read them. It names no product.
