# Lilac — Canonical Program State

Last updated: 2026-10-01

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE — substantial exact/shipped-source recovery proven; remaining unshipped source gaps are compatibility-reconstructable where observable

## Canonical facts

- Repository: `TheHalfMoon/Lilac`
- Product name: **Lilac**
- Paper.design is an authorized donor/source according to the project owner's explicit attestation.
- Bootstrap PR #1 merged at `d60ad17833ce658b7ba09b87c1865e700151dc53`.
- Paper Desktop 0.5.14 recovery evidence was merged in PR #4 at canonical `main` SHA `a469c151a38c4129406ee0e9639a6e2a1511267f`.
- Public/shipped recovery census PR #5 merged at canonical `main` SHA `2685a526d714ff2fe5b5cb2e602dea38d0b8a8cd`; post-merge CI run `36784889241` succeeded on that exact SHA.
- Expanded 21-release recovery PR #6 merged at canonical `main` SHA `961e9eb54abf40bb41bcc0da25ed04d756217f15`; post-merge Foundation check run `36786708837` succeeded on that exact SHA.
- The complete Paper private monorepo is **not** available through the connected GitHub source and has not been recovered from any public artifact.
- Private GitHub access is no longer a hard prerequisite for product progress: publicly downloadable and end-user-shipped artifacts expose substantial exact first-party source and high-confidence compatibility contracts.
- Current Desktop 0.5.14 packages expose exact `@paper/desktop` TypeScript source. Cross-platform packaging confirms the same current Desktop source surface with platform-specific native artifacts.
- The expanded public Desktop corpus spans **21 observed builds**, from early 0.1.x/0.2.x/0.3.x/0.4.x releases through every recovered 0.5.0–0.5.14 release in the lineage.
- The Desktop lineage contains **87 unique first-party source paths**; **46 paths have multiple distinct content hashes** across releases.
- Source maps are present through Paper Desktop **0.5.9** and disappear at the observed `0.5.9 → 0.5.10` boundary: 0.5.9 ships 1,450 maps; 0.5.10 ships zero.
- Historical source maps include embedded `sourcesContent`. Separately verified exact internal-package recovery covers **16 TypeScript files plus `cli/package.json`** across `models`, `assets`, `cli`, and `client-desktop-types`.
- Three high-value internal declaration/source targets remain unrecovered as exact original text: `assets/src/types.ts`, `models/src/mcp/mcp-types.ts`, and `client-desktop-types/src/desktop-bridge.ts`.
- Those three remaining client-side contracts are now classified `COMPATIBILITY_RECONSTRUCTABLE`: their observable value domains, public schemas, bridge methods, IPC behavior, and call sites are independently constrained by recovered current Desktop source, public web bundles, public MCP configuration, and shipped runtime behavior.
- The 12-version gap-filling workflow `Paper Public History Census` run `36785630738` completed **SUCCESS** on exact head `f7763bbbdfa1955e7f3fd3c28dcf63e0739e8134`; all 12 matrix jobs downloaded, checksum-verified, extracted, inventoried, and uploaded metadata-only evidence successfully.
- Paper Snapshot 0.4.4 was recovered from the official Chrome CRX distribution endpoint; its shipped bundle contains 3 JavaScript files totaling 243,920 bytes.
- The current public Paper web editor exposes production and lazy-loaded JavaScript chunks including MCP, code import, Figma parsing, HTML export, media, image resolution, PDF, gradient, and worker surfaces. Current web `.map` probes do not return valid source maps.
- Public archive history adds historical web bundles but has not yielded valid web-editor source maps in the observed corpus.
- A separate public MIT project, `vcashwin/paper-snapshot`, provides a readable TypeScript implementation of a Paper-compatible DOM capture/serialization pipeline. It is tracked as an independent external donor/reference, not as official Paper source.
- Paper Desktop 0.5.14 ships a native Go CLI whose runtime/build metadata proves module `github.com/paper-design/paper/cli` and current source paths `cmd/paper.go`, `internal/config.go`, `internal/relay.go`, plus platform-specific connection-reset files. Windows and Linux binaries were independently inspected; Linux recovery run `36788666557` succeeded.
- The current Go CLI exposes and consumes the public Paper Desktop MCP configuration endpoint `https://app.paper.design/mcp/desktop/config.json`.
- Public MCP census run `36788494280` succeeded and proves the current endpoint returns **35 tool definitions**. Their names exactly match the 35 handlers independently recovered from the production `MCPHandlers` web bundle. The response and instructions are bound by SHA-256 evidence; per-tool schema/description hashes are recorded without committing the raw response.
- The official public `paper-design/agent-plugins` MCPB was checked and is config-only; its executable is the external Paper CLI installed by Desktop, so it does not provide an additional hidden source payload.
- A final public GitHub/web/package sweep did not locate an independent exact copy of the three unresolved TypeScript files or a public mirror/fork of the complete `paper-design/paper` monorepo.
- Public Paper repositories remain separate independently licensed sources and must retain their own license/NOTICE obligations.
- Raw proprietary Paper source recovered from shipped artifacts is not committed to the public Lilac repository. Public evidence records contain hashes, paths, counts, contract metadata, and architectural findings only.
- Detailed recovery evidence:
  - `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`
  - `docs/evidence/PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md`
  - `docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md`
  - `docs/evidence/PAPER_PUBLIC_MCP_CONFIG_CENSUS_2026-10-01.json`
  - `docs/evidence/PAPER_LINUX_CLI_CENSUS_2026-10-01.json`
- Source-intake tracking issue remains #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged and maintained |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN | Exact current/historical Desktop source, 21-build lineage, historical source-map content, verified internal package fragments, current native CLI metadata, public MCP schemas, Snapshot bundle, current/historical public web bundles; full original monorepo not recovered |
| P00-G04 Reproducible upstream build | PARTIAL_NOT_STARTED | Recovered Desktop source can be qualified independently; full product clean build still unavailable without the complete original source tree |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Continue two tracks in parallel:

1. **Recovery:** accept only new public/shipped evidence with genuine marginal value. Preserve immutable hashes/provenance and never relabel reconstruction as original source.
2. **Implementation:** start Lilac's independent compatibility foundation from the proven document/MCP/Desktop surfaces. Implement the three reconstructed compatibility contracts with explicit provenance labels and tests, then proceed into the document model, deterministic transactions/history, renderer/canvas, and code-sync programs.

The full Paper monorepo is no longer a prerequisite for beginning Lilac implementation, but it remains a missing artifact for any claim of complete original-source recovery.

## Integrity rule

Never fabricate source availability, ownership, build success, parity, review results, or Paper provenance. `PARTIAL_RECOVERY_PROVEN` is not equivalent to a complete Paper repository import, and `COMPATIBILITY_RECONSTRUCTABLE` is not equivalent to recovered original source text.
