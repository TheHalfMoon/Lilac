# Retired Paper recovery records

Before N0, Lilac kept tooling and evidence for recovering Paper's public and shipped artifacts. That tooling covered three census workflows, a source-intake script with its test and runbook, and an ASAR census script. The evidence covered the dated `PAPER_*` records. None of it has a role in Ninerr, so N0-G5 removes it from the tree in three parts. N0-G5a removes the tooling, N0-G5b the three behaviour-evidence records the provenance cites, and N0-G5c the other eight evidence records.

Git history keeps every file. Each one is pinned below by its blob at commit `ac204c2061df191d29085718dc7b3a15e644734e`. That is a commit on `main`'s first-parent line at which all eighteen are present with these blobs. They stay byte-identical until each one is removed. Read one with:

    git show ac204c2061df191d29085718dc7b3a15e644734e:<path>

The provenance records of `@ninerr/collaboration` and `@ninerr/import-stack` cite the behaviour evidence below by path. The PC-L1 license audit (`docs/evidence/PC_L1_LICENSE_AUDIT_2026-10-07.md`) found that no Paper source was ever committed.

| Path | Blob |
| --- | --- |
| `.github/workflows/paper-public-history-census.yml` | `610103772b9e36ba424cc2e0a02e0bb99c10838c` |
| `.github/workflows/paper-public-linux-cli-census.yml` | `f226c31b33e7b7fae2d6f73b28212e0202bdad28` |
| `.github/workflows/paper-public-mcp-config-census.yml` | `49bbcc31a82782f83b4c721c351b50e5736d5f1f` |
| `docs/IMPORT_RUNBOOK.md` | `78a83d388f8d85249a0d426ccbaaced883cbc1d5` |
| `docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md` | `8a598d076a3b572f6f75851bfffc428cc5796846` |
| `docs/evidence/PAPER_DESKTOP_0.5.14_RECOVERY.md` | `45717d4918a0421c43fe3eed3e3e0b8ba0e45819` |
| `docs/evidence/PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md` | `236dc385d6d543c129b7059a4befa01922480529` |
| `docs/evidence/PAPER_LINUX_CLI_CENSUS_2026-10-01.json` | `3802e14a613388ddb6597c992ed6496ceac1acd0` |
| `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md` | `98ffc54a03926ba1aea1131a0134008d0112dd44` |
| `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md` | `c668d4920c85b1e836eda629b5753cdee1f77612` |
| `docs/evidence/PAPER_LOCAL_FORENSIC_CLOSURE_2026-10-03.md` | `f9ebf6a79f4f34c63b1a8ffde62b2c2ab2c7a157` |
| `docs/evidence/PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md` | `6fa49e047a0f6036230ac02696dc6259629a7040` |
| `docs/evidence/PAPER_PUBLIC_MCP_CONFIG_CENSUS_2026-10-01.json` | `629944402e7dcd9ba3aab8e6fe9eeb53aa9c56d3` |
| `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md` | `76c40f5522446d5aa6a71a9ab3efc516d4dc6cd9` |
| `docs/evidence/PAPER_RECOVERY_EVIDENCE_ARCHIVE_INDEX_2026-10-04.md` | `4a1e998d57df3489bccb3c18536cb120d3fe90d0` |
| `scripts/census-paper-asar.py` | `575aa5548f006a5806f1997ce75d777f0d89ffef` |
| `scripts/import-authorized-paper.mjs` | `6fbb6deae7949673475e1d33fa92aed5a7251a55` |
| `tests/import-authorized-paper.test.mjs` | `c59bd1eaf63b3c9a49b24cc6206bc90d1aeef01c` |
