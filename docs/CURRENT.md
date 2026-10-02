# Lilac — Canonical Program State

Last updated: 2026-10-02

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE — substantial exact/shipped-source recovery proven; client compatibility frontier materially reconstructed; complete private monorepo remains unavailable

## Canonical facts

- Repository: `TheHalfMoon/Lilac`
- Product name: **Lilac**
- Paper.design is an authorized donor/source according to the project owner's explicit attestation.
- Bootstrap PR #1 merged at `d60ad17833ce658b7ba09b87c1865e700151dc53`.
- Paper Desktop 0.5.14 recovery evidence was merged in PR #4 at canonical `main` SHA `a469c151a38c4129406ee0e9639a6e2a1511267f`.
- Public/shipped recovery census PR #5 merged at canonical `main` SHA `2685a526d714ff2fe5b5cb2e602dea38d0b8a8cd`; post-merge CI run `36784889241` succeeded on that exact SHA.
- Expanded 21-release recovery PR #6 merged at canonical `main` SHA `961e9eb54abf40bb41bcc0da25ed04d756217f15`; post-merge Foundation check run `36786708837` succeeded on that exact SHA.
- Deep CLI/MCP recovery PR #7 merged at canonical `main` SHA `480e198be3be23b5d401b739a2c0bfd9b7c4acd1`; post-merge Foundation check run `36790000118` succeeded on that exact SHA.
- The complete Paper private monorepo is **not** available through the connected GitHub source and has not been recovered from any public or end-user artifact.
- Private GitHub access is no longer a hard prerequisite for product progress: public and end-user-shipped artifacts expose substantial exact first-party source, current runtime implementation, and high-confidence compatibility contracts.
- Current Desktop 0.5.14 packages expose exact `@paper/desktop` TypeScript source. A local ASAR recovery pass extracted **95 current Desktop source/test/script/metadata files totaling 463,901 bytes**.
- The expanded public Desktop corpus spans **21 observed builds**, from early 0.1.x/0.2.x/0.3.x/0.4.x releases through every recovered 0.5.0–0.5.14 release in the lineage.
- The Desktop lineage contains **87 unique first-party source paths**; **46 paths have multiple distinct content hashes** across releases.
- Source maps are present through Paper Desktop **0.5.9** and disappear at the observed `0.5.9 → 0.5.10` boundary: 0.5.9 ships 1,450 maps; 0.5.10 ships zero.
- Historical source maps include embedded `sourcesContent`. Separately verified exact internal-package recovery covers **16 TypeScript files plus `cli/package.json`** across `models`, `assets`, `cli`, and `client-desktop-types`.
- Three high-value internal declaration/source targets remain unrecovered as exact original text: `assets/src/types.ts`, `models/src/mcp/mcp-types.ts`, and `client-desktop-types/src/desktop-bridge.ts`.
- Those three client-side contracts now have **usable local compatibility TypeScript implementations** derived from exact Desktop call sites, current public schemas, IPC behavior, and shipped runtime evidence. The reconstructed files pass TypeScript syntax parsing and remain explicitly labeled reconstruction rather than original source.
- Paper Snapshot 0.4.4 was recovered from the official Chrome CRX distribution endpoint; its shipped bundle contains 3 JavaScript files totaling 243,920 bytes.
- The current public Paper web editor exposes production and lazy-loaded JavaScript chunks including MCP, code import, Figma parsing, HTML export, media, image resolution, PDF, gradient, vector, signal, and worker surfaces. Current Paper `.map` probes do not return valid source maps.
- A live 2026-10-02 web recovery captured **36 current public resources totaling 15,463,061 bytes** and identified current first-party package references including `@paper/assets`, `@paper/client-signals`, `@paper/models`, `@paper/svg-parser`, and `@paper/vector-graph`.
- Paper's shipped TypeScript compiler parsed **27 current JavaScript chunks with zero diagnostics**, inventorying **536 classes, 23,031 functions, and 48,929 variable declarations**.
- Public-playground runtime inspection recovered constructor/prototype/function-source evidence for **66 editor subsystems totaling 628,676 serialized bytes**, including tree/history/tokens/selection/snap/agents/multiplayer/vector/page/comment/font/image/library/camera/text/theme surfaces.
- **60 editor subsystem classes** were mapped back into the current parsed AST and isolated into class-level recovery files totaling approximately 262,812 bytes.
- Public-playground React Fiber inspection recovered **68 component function sources totaling 51,189 bytes** without recording component props or private design content.
- Paper Desktop 0.5.14 ships a native Go CLI whose runtime/build metadata proves module `github.com/paper-design/paper/cli` and current source paths `cmd/paper.go`, `internal/config.go`, `internal/relay.go`, plus platform-specific connection-reset files.
- The current Go CLI exposes and consumes the public Paper Desktop MCP configuration endpoint `https://app.paper.design/mcp/desktop/config.json`.
- The live 2026-10-02 MCP endpoint returns **36 tool definitions**, and `window.mcpHandlers.toolHandlers` exposes the exact same 36-name set. This supersedes the earlier 35-tool snapshot as the current contract.
- Live V8 function-source recovery captured current MCP implementation behavior including schema validation, dispatch/timeouts, edit/usage/connectivity gates, undo-bypass transactions, agent read/write attribution, tree serialization, HTML-to-design import, style application, comments, and resource operations. The current `mcpHandlers` class source alone is approximately 42.7 KB of shipped runtime implementation.
- The official public `paper-design/agent-plugins` MCPB remains config-only; its executable is the external Paper CLI installed by Desktop, so it does not provide an additional hidden source payload.
- A final public GitHub/web/package sweep did not locate an independent exact copy of the three unresolved TypeScript files or a public mirror/fork of the complete `paper-design/paper` monorepo.
- Public Paper repositories remain separate independently licensed sources and must retain their own license/NOTICE obligations.
- Raw proprietary Paper source and recovered production bundles are **not** committed to the public Lilac repository. Public evidence records contain hashes, paths, counts, contract metadata, and architectural findings only.
- Detailed recovery evidence:
  - `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`
  - `docs/evidence/PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md`
  - `docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md`
  - `docs/evidence/PAPER_PUBLIC_MCP_CONFIG_CENSUS_2026-10-01.json`
  - `docs/evidence/PAPER_LINUX_CLI_CENSUS_2026-10-01.json`
  - `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md`
- Source-intake tracking issue remains #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged and maintained |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN | Exact current/historical Desktop source, 21-build lineage, historical source-map content, verified internal package fragments, current CLI metadata, current 36-tool public/runtime MCP contract, live editor subsystem/function recovery, React component recovery, Snapshot bundle, and current/historical public web bundles; full original monorepo not recovered |
| P00-G04 Reproducible upstream build | PARTIAL_NOT_STARTED | Recovered Desktop source can be qualified independently; full product clean build remains unavailable without the complete original authoring-time source tree |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Continue two tracks in parallel:

1. **Recovery:** accept only new public/end-user-shipped evidence with genuine marginal value. Preserve hashes/provenance and never relabel runtime reconstruction as original authoring-time source.
2. **Implementation:** begin Lilac's compatibility foundation using the now-proven Desktop/MCP/editor-state surfaces. Promote the three reconstructed client contracts into tested Lilac-owned interfaces, then proceed through document model, deterministic transactions/history, renderer/canvas, import/export, and bidirectional code-sync programs.

The full Paper monorepo is no longer a prerequisite for beginning Lilac implementation, but it remains a missing artifact for any claim of complete original-source recovery.

## Integrity rule

Never fabricate source availability, ownership, build success, parity, review results, or Paper provenance. `PARTIAL_RECOVERY_PROVEN` is not equivalent to a complete Paper repository import; shipped runtime source recovery and `COMPATIBILITY_RECONSTRUCTABLE` contracts are not equivalent to recovered original authoring-time TypeScript files.
