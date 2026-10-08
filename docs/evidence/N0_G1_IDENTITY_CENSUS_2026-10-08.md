# N0-G1: identity census

Issue: #190 (N0 umbrella). Baseline: `main` at `9020b1ebb20ede7611fdca65fe2027600513d12b`.

## Tool

- `scripts/identity-census.mjs` scans every tracked file's path and text, case-insensitively, for the terms in `scripts/identity-policy.json`: Lilac, Paper, and each previously authorized donor project name.
- Each finding is classified by the first matching rule in the policy. The categories are the nine N0.1 classes. Every rule carries a reason.
- The output depends only on tracked content, so it is byte-identical across runs. The artifact excludes itself from the scan.
- `--write` regenerates `docs/evidence/N0_IDENTITY_CENSUS.json`.
- `--check` is the N0.9 independence gate. It exits non-zero on any finding in a gated category: active product or internal identity, public API, persisted data, test fixtures, and material to remove.
- Legacy compatibility, independent third-party obligations and dated historical records are not gated. N0-G9 wires `--check` into CI once migration has emptied the gated categories.
- `tests/identity-census.test.mjs` checks the policy's shape, the rule semantics, determinism, binary handling and the gate's count, on synthetic trees.

## Baseline result

503 tracked files scanned; 308 have findings; 1,992 findings are gated.

| Category | Findings | Main locations | Owning grain |
|---|---:|---|---|
| ACTIVE_PRODUCT_IDENTITY | 786 | workspace names in `package-lock.json`, architecture catalog, studio host and web, desktop scripts, docs | N0-G3, N0-G8 |
| TEST_FIXTURE | 523 | browser, web-mode, crash-recovery and MCP tests; test support | N0-G3 |
| IMMUTABLE_HISTORICAL_FACT | 368 | dated evidence under `docs/evidence/` | not rewritten |
| ACTIVE_INTERNAL_IDENTITY | 306 | donor ledgers and study, per-package provenance records, donor names in code comments | N0-G5 |
| REMOVE_ENTIRELY | 288 | Paper recovery evidence, the three `paper-public-*` census workflows, Paper import and census scripts, the import runbook | N0-G5 |
| THIRD_PARTY_INDEPENDENT_OBLIGATION | 251 | Impeccable and Docling integrations, third-party notices, license register and policy | retained; reviewed in N0-G7 |
| PUBLIC_API | 62 | Paper-mirrored MCP catalog, CLI entry points, `LILAC_PROJECTS` and `LILAC_MCP_TOKEN` | N0-G3, N0-G4 |
| PERSISTED_DATA | 27 | `.lilac` project directory, `lilac-project` manifest format, journal genesis domain, host registries and discovery file, `lilac_agent_` credential prefix, projects-folder default, history tool identifiers | N0-G2, N0-G3 |
| LEGACY_COMPATIBILITY | 7 | the v1 golden project fixture | kept as migration corpus |

By term: Lilac 1,631; Paper 464; Impeccable 162; Docling 121; the remaining donor names 15 to 29 each.

## Persisted identity that needs migration (N0-G2)

- **Project directory and manifest.** `<root>/.lilac` with `format: "lilac-project"`, schema 1.
- **Journal genesis.** The hash chain starts at `sha256("lilac-journal-genesis:" + projectId)`. Every entry digest depends on it, so a migrated project must keep verifying under its original genesis domain. Rewriting the chain would discard its integrity record. The migrated manifest therefore has to record the domain.
- **Host files in the projects folder.** `.lilac-agents.json` (credential hashes; tokens prefixed `lilac_agent_`), `.lilac-codebases.json` and `.lilac-studio.json` (discovery).
- **Projects-folder default.** `~/Lilac Projects`.
- **History tool identifiers in journal entries.** `lilac:import`, `lilac:code`, `lilac:undo`, `lilac:redo` and `lilac:revert`. They are written, not read back for behaviour; N0-G3 confirms this before changing new writes.
- **Not persisted.** `data-lilac-*` attributes exist only in the rendered sandbox DOM. `lilac:*` performance marks exist only in the page.

## Paper independence findings (input to N0-G4 and N0-G5)

- **MCP surface.** The tool catalog is Paper's public MCP tool list, verbatim: 36 names, with Paper's read/write classification.
  - `assertPaperMCPCompatibility` refuses a server whose tools drift from Paper's.
  - This is the strongest "Paper renamed" signal in the product.
  - N0-G4 replaces it with a Ninerr-native surface organized around Ninerr's own model: transactions, review, source links and agents.
- **Recovery tooling.** Three CI workflows still download public Paper builds for census, on push to `codex/*` branches or manual dispatch. They are retired in N0-G5; the Git history keeps them.
- **Compatibility naming.** Collaboration and import-stack provenance records describe behaviour as Paper-compatible.
- **Licensing.** Per the PC-L1 audit, no Paper source was ever committed.
