# Lilac — Canonical Program State

Last updated: 2026-10-03

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE — substantial exact/shipped-source recovery proven; remaining client-side source gaps are compatibility-reconstructed and validated where observable

## Canonical facts

- Repository: `TheHalfMoon/Lilac`
- Product name: **Lilac**
- Paper.design is an authorized donor/source according to the project owner's explicit attestation.
- Bootstrap PR #1 merged at `d60ad17833ce658b7ba09b87c1865e700151dc53`.
- Paper Desktop 0.5.14 recovery evidence was merged in PR #4 at canonical `main` SHA `a469c151a38c4129406ee0e9639a6e2a1511267f`.
- Public/shipped recovery census PR #5 merged at canonical `main` SHA `2685a526d714ff2fe5b5cb2e602dea38d0b8a8cd`; post-merge CI run `36784889241` succeeded on that exact SHA.
- Expanded 21-release recovery PR #6 merged at canonical `main` SHA `961e9eb54abf40bb41bcc0da25ed04d756217f15`; post-merge Foundation check run `36786708837` succeeded on that exact SHA.
- Deep MCP/CLI recovery PR #7 merged at canonical `main` SHA `480e198be3be23b5d401b739a2c0bfd9b7c4acd1`; post-merge Foundation check run `36790000118` succeeded on that exact SHA.
- The complete Paper private monorepo is **not** available through the connected GitHub source and has not been recovered from any public or end-user-shipped artifact.
- Private GitHub access is no longer a hard prerequisite for product progress: publicly downloadable, end-user-shipped, and user-authorized local runtime artifacts expose substantial exact first-party source and high-confidence compatibility contracts.
- Current Desktop 0.5.14 packages expose exact `@paper/desktop` TypeScript source. Cross-platform packaging confirms the same current Desktop source surface with platform-specific native artifacts.
- The expanded public Desktop corpus spans **21 observed builds**, from early 0.1.x/0.2.x/0.3.x/0.4.x releases through every recovered 0.5.0–0.5.14 release in the lineage.
- The Desktop lineage contains **87 unique first-party source paths**; **46 paths have multiple distinct content hashes** across releases.
- Source maps are present through Paper Desktop **0.5.9** and disappear at the observed `0.5.9 → 0.5.10` boundary: 0.5.9 ships 1,450 maps; 0.5.10 ships zero.
- Historical source maps include embedded `sourcesContent`. Separately verified exact internal-package recovery covers **16 TypeScript files plus `cli/package.json`** across `models`, `assets`, `cli`, and `client-desktop-types`.
- Three high-value internal declaration/source targets remain unrecovered as exact original text: `assets/src/types.ts`, `models/src/mcp/mcp-types.ts`, and `client-desktop-types/src/desktop-bridge.ts`.
- Those three client-side contracts are now `COMPATIBILITY_RECONSTRUCTED_VALIDATED`: exact current Desktop call sites, live renderer state/contracts, public MCP schemas, and shipped runtime behavior were used to reconstruct their material compatibility surfaces, then validate them with strict TypeScript and structural comparison.
- Reconstruction validation passed with **27/27 Desktop bridge top-level keys**, **6/6 AppIcon values**, **4/4 MCP bridge methods**, and zero missing/extra structural members across those checks.
- Paper Snapshot 0.4.4 was recovered from the official Chrome CRX distribution endpoint; its shipped bundle contains 3 JavaScript files totaling 243,920 bytes.
- A separate public MIT project, `vcashwin/paper-snapshot`, provides a readable TypeScript implementation of a Paper-compatible DOM capture/serialization pipeline. It is tracked as an independent external donor/reference, not as official Paper source.
- Paper Desktop 0.5.14 ships a native Go CLI whose runtime/build metadata proves module `github.com/paper-design/paper/cli` and current source paths `cmd/paper.go`, `internal/config.go`, `internal/relay.go`, plus platform-specific connection-reset files.
- The Go CLI exposes and consumes the public Paper Desktop MCP configuration endpoint `https://app.paper.design/mcp/desktop/config.json`.
- The 2026-10-01 public MCP census recorded 35 tools. A 2026-10-03 live/public recensus records **36 tools**, demonstrating contract drift and adding current resource-oriented surface including `list_resources` and `rename_resource`.
- User-authorized local Electron DevTools Protocol capture recovered a newer production renderer build than the earlier web census. Sixteen exact shipped JavaScript assets totaling **4,971,280 bytes** were retained locally with immutable hashes; raw bundles are not committed publicly.
- The current web runtime exposes editor state surfaces for camera, selection, editor context, files/resources, pages, layer tree, undo/redo, tokens, multiplayer/Yjs awareness, comments, vector editing, Tailwind styles, DOM, gradients, images, navigation, typography, and UI state.
- Current web AST analysis records 343 class declarations, 5,296 function declarations, 445 filtered semantic strings, and 1,200 retained semantic property signals in the main shipped bundle.
- Current web code directly references internal package identities including `@paper/assets`, `@paper/client-desktop-types`, `@paper/client-signals`, `@paper/models`, `@paper/svg-parser`, and `@paper/vector-graph`.
- A final public GitHub/web/package sweep did not locate an independent exact copy of the three unresolved original TypeScript files or a public mirror/fork of the complete `paper-design/paper` monorepo.
- Public Paper repositories remain separate independently licensed sources and must retain their own license/NOTICE obligations.
- Raw proprietary Paper source recovered from shipped/local artifacts is not committed to the public Lilac repository. Public evidence records contain hashes, paths, counts, contract metadata, validation results, and architectural findings only.
- Detailed recovery evidence:
  - `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`
  - `docs/evidence/PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md`
  - `docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md`
  - `docs/evidence/PAPER_PUBLIC_MCP_CONFIG_CENSUS_2026-10-01.json`
  - `docs/evidence/PAPER_LINUX_CLI_CENSUS_2026-10-01.json`
  - `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md`
- Source-intake tracking issue remains #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged and maintained |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN | Exact current/historical Desktop source, 21-build lineage, historical internal-package source fragments, native CLI metadata, current web bundles/runtime architecture, public MCP schemas, validated client-side compatibility reconstruction, and Snapshot evidence; full original monorepo not recovered |
| P00-G04 Reproducible upstream build | PARTIAL_NOT_STARTED | Recovered Desktop source can be qualified independently; full original product clean build remains unavailable without the complete original source tree |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Paper recovery is now opportunistic rather than an implementation blocker. Accept only genuinely new artifacts with marginal evidence value, preserve immutable provenance, and never relabel compatibility reconstruction as original source.

Implementation proceeds in the donor-study order:

1. **Grain 1 — Design Assurance Foundation (Issue #17):** integrate a bounded, revision-pinned Impeccable detector boundary and establish deterministic Lilac rule packs before expanding agent autonomy.
2. **Grain 2 — Durable Agent Kernel (Issue #16):** port Unreal Agent session/operation semantics into a Lilac-native runtime after Grain 1 is qualified.
3. Follow with the typed agent event protocol, Firstmate-derived supervision, Lilac-native collaboration, import stack, decision router, delivery governance, and design-method/resource layers defined in `docs/DONOR_INTEGRATION_MAP.md`.

The canonical donor rationale and exact studied revisions live in `docs/DONOR_DEEP_STUDY_2026-10-03.md`.

The full Paper monorepo is no longer a prerequisite for Lilac implementation, but it remains a missing artifact for any claim of complete original-source recovery.

## Integrity rule

Never fabricate source availability, ownership, build success, parity, review results, or Paper provenance. `PARTIAL_RECOVERY_PROVEN` is not equivalent to a complete Paper repository import, and `COMPATIBILITY_RECONSTRUCTED_VALIDATED` is not equivalent to recovered original source text.
