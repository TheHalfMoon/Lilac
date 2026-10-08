# N0-G5: the Paper recovery tooling and records leave the tree

Issue: #190 (N0 umbrella).

## Removed
- **Workflows.** `.github/workflows/paper-public-history-census.yml`, `paper-public-linux-cli-census.yml` and `paper-public-mcp-config-census.yml`. They were manual censuses of Paper's public artifacts.
- **Scripts and docs.**
  - `scripts/import-authorized-paper.mjs`, with its test and `docs/IMPORT_RUNBOOK.md`. This intake path never received any source: the PC-L1 audit found that no Paper source was ever committed.
  - `scripts/census-paper-asar.py`.
- **Evidence** (N0-G5b and N0-G5c). The eleven dated `docs/evidence/PAPER_*` records.

Nothing in the product used any of these files. Only the root `check` script ran one of them, and it no longer does. The census policy, the license register and dated evidence name them as records.

## Kept
- **`docs/provenance/RETIRED_PAPER_RECORDS.md`** pins every removed file. It gives each file's blob at `ac204c2`, a commit on `main`'s first-parent line at which all of them are present, and says how to read it from Git history. History is unchanged, so the records stay verifiable.
- **The provenance records of `@ninerr/collaboration` and `@ninerr/import-stack`** (N0-G5b) still cite the behaviour evidence by path, now through the retired record. Their tests check two things for each cited file:
  - the retired record pins it with a blob;
  - it is no longer in the tree.
- **The authorization record and the license register** (`docs/provenance/PAPER_AUTHORIZATION.md`, `LICENSE_REGISTER.json`). They move with the license work in N0-G7.
- **The census rules** for these paths. They stay in `scripts/identity-policy.json`, so a recovery file added back is classified `REMOVE_ENTIRELY` and gated.

## Split
The deletions exceed the exact-head reviewer's context, so N0-G5 lands in three parts:
- **N0-G5a:** the workflows, scripts, test and runbook; the retired record; the license register note; and the root check script.
- **N0-G5b:** the three behaviour-evidence records that the provenance of `@ninerr/collaboration` and `@ninerr/import-stack` cites, together with those provenance records and their tests.
- **N0-G5c:** the remaining eight evidence records, and `docs/DONORS.md`, which cites two of them.

The retired record lists all eighteen files from the start. Each one's blob is pinned at `ac204c2`, whichever part removes it.

## N0-G5b
This part removes the three behaviour-evidence records:
- `PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md`;
- `PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md`;
- `PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md`.

In the same change, the provenance of `@ninerr/collaboration` and `@ninerr/import-stack` cites them through the retired record. The tests check, for each cited path, that the record pins a blob for it and that it is no longer in the tree.

## N0-G5c
This part removes the remaining eight dated Paper evidence records:
- the deep, desktop and history recovery records;
- the Linux CLI and public MCP configuration censuses;
- the public shipped recovery census;
- the local forensic closure;
- the archive index.

`docs/DONORS.md` cited two of them; it now names them as retired and points to the retired record. With this part, N0-G5 is complete: none of the eighteen files is in the tree, and the retired record pins every one.
