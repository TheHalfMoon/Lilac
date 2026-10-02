# Lilac — Canonical Program State

Last updated: 2026-10-02

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE — substantial exact/shipped-source recovery proven; runtime reconstruction surface materially expanded; complete private monorepo still unavailable

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
- Private GitHub access is no longer a hard prerequisite for product progress: publicly downloadable, end-user-shipped, locally cached, and live-runtime artifacts expose substantial exact first-party source and high-confidence compatibility contracts.
- Current Desktop 0.5.14 packages expose exact `@paper/desktop` TypeScript source. The installed ASAR was independently parsed on the authorized host; its source/config/test selection contains 101 files totaling 467,976 bytes and is bound to ASAR SHA-256 `11469b844be7ace5dd8b4bb234f12e8c8f609b172db78c4ef776a3a9890200f1`.
- The expanded public Desktop corpus spans **21 observed builds**, from early 0.1.x/0.2.x/0.3.x/0.4.x releases through every recovered 0.5.0–0.5.14 release in the lineage.
- The Desktop lineage contains **87 unique first-party source paths**; **46 paths have multiple distinct content hashes** across releases.
- Source maps are present through Paper Desktop **0.5.9** and disappear at the observed `0.5.9 → 0.5.10` boundary: 0.5.9 ships 1,450 maps; 0.5.10 ships zero.
- Historical source maps include embedded `sourcesContent`. Separately verified exact internal-package recovery covers **16 TypeScript files plus `cli/package.json`** across `models`, `assets`, `cli`, and `client-desktop-types`.
- Three high-value internal declaration/source targets remain unrecovered as exact original text: `assets/src/types.ts`, `models/src/mcp/mcp-types.ts`, and `client-desktop-types/src/desktop-bridge.ts`.
- Those three remaining client-side contracts are `COMPATIBILITY_RECONSTRUCTABLE`: their observable value domains, public schemas, bridge methods, IPC behavior, call sites, and live runtime surfaces are independently constrained by recovered Desktop source, web bundles, public MCP configuration, and shipped runtime behavior.
- The 12-version gap-filling workflow `Paper Public History Census` run `36785630738` completed **SUCCESS** on exact head `f7763bbbdfa1955e7f3fd3c28dcf63e0739e8134`; all 12 matrix jobs downloaded, checksum-verified, extracted, inventoried, and uploaded metadata-only evidence successfully.
- Paper Snapshot 0.4.4 was recovered from the official Chrome CRX distribution endpoint; its shipped bundle contains 3 JavaScript files totaling 243,920 bytes.
- A separate public MIT project, `vcashwin/paper-snapshot`, provides a readable TypeScript implementation of a Paper-compatible DOM capture/serialization pipeline. It is tracked as an independent external donor/reference, not as official Paper source.
- Paper Desktop 0.5.14 ships a native Go CLI whose runtime/build metadata proves module `github.com/paper-design/paper/cli` and current source paths `cmd/paper.go`, `internal/config.go`, `internal/relay.go`, plus platform-specific connection-reset files. Windows and Linux binaries were independently inspected; Linux recovery run `36788666557` succeeded.
- The current Go CLI consumes the public Paper Desktop MCP configuration endpoint `https://app.paper.design/mcp/desktop/config.json`.
- Public MCP census run `36788494280` succeeded and proves the endpoint returns **35 tool definitions** matching the 35 handlers independently recovered from the production `MCPHandlers` bundle.
- The official public `paper-design/agent-plugins` MCPB is config-only; its executable is the external Paper CLI installed by Desktop, so it does not contain a hidden CLI source payload.
- Live Electron/CDP inspection on 2026-10-02 proved a newer production web build than the 2026-09-30 build previously recorded. Current identifiers include `main-DapzG1bW.js`, `MCPHandlers-9Afu-vcb.js`, and `code-import-C_93ZgW5.js`.
- The live renderer exposed 64 MCP-related function bodies totaling 38,948 characters, 71 React component/function bodies totaling 65,017 characters, a central editor state graph with approximately 68 subsystems, 67 subsystem class bodies totaling 221,324 characters, and 870 subsystem method bodies totaling 101,651 characters.
- The editor-state graph directly exposes camera, selection, tree/layer/page state, node mutation utilities, undo/redo, snapping/hit testing, text/vector/draw tools, collaboration/multiplayer, comments, agents, fonts, images, tokens, libraries, Tailwind/theme, culling/LOD, panels, guides, and layout-handle surfaces.
- The live node wrapper class (`odt`) exposes approximately 27.6 KB of production JavaScript for node geometry/style/text/component operations. The node property container (`BY`) and property-handler classes expose constraints, dimensions, margin, position, rotation, transform, fill, border, corner radius, filters, shadows, opacity, outline, and related behavior.
- App-level runtime extraction exposes class surfaces for authentication, updates, metering, team/resources, authenticated fetch, user/profile state, navigation progress, Figma connection, file collection, and socket collection; authentication/session values are excluded from repository evidence.
- Static AST analysis of the current recovered web assets extracted **468 unique JavaScript class bodies totaling 1,001,676 bytes** from nine class-bearing assets with zero parse errors. This includes third-party classes and must not be interpreted as 468 Paper-owned classes.
- Local Chromium disk-cache forensics recovered three 2026-09-30 assets no longer served by their old hashed CDN URLs: `main-BsW7aFPG.js` (4,026,586 bytes; SHA-256 `c83afe159ec44491eeb6884137922b4b045b4355aa1a5ece200121a7f29291b6`), `MCPHandlers-CJrIJGpp.js` (189,854 bytes; SHA-256 `df7d10b1a8c2f2ba2c5d88c2a87b25a91b0508aa6b8103ac13c043b4d7447efb`), and `appBar-BBzFbwbN.js` (7,832 bytes; SHA-256 `bb9567766c807a8439de51dd32b6ccde0e4546151f302d4390b9e5609fb942a7`). Cached response metadata proves JavaScript content and Brotli encoding.
- With those cache bodies restored, the 2026-09-30 web corpus yields **517 unique class bodies totaling 1,033,400 bytes**, with zero parse errors. Cross-build method-signature matching proves extensive semantic continuity despite minifier identifier churn.
- A private local recovery corpus now contains a SHA-256 manifest covering **2,461 files / 57,211,972 bytes**, including exact Desktop source, current and historical web bundles, runtime/class/state evidence, AST class extracts, and formatting-only readable derivatives. Raw recovered Paper material is intentionally not committed to this public repository.
- Current web `.map` probes still do not return valid source maps. Live/runtime/AST recovery improves reconstructability but does not recreate original TypeScript filenames, comments, module boundaries, private tests, or Git history.
- Public Paper repositories remain separate independently licensed sources and must retain their own license/NOTICE obligations.
- Detailed recovery evidence:
  - `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`
  - `docs/evidence/PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md`
  - `docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md`
  - `docs/evidence/PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md`
  - `docs/evidence/PAPER_PUBLIC_MCP_CONFIG_CENSUS_2026-10-01.json`
  - `docs/evidence/PAPER_LINUX_CLI_CENSUS_2026-10-01.json`
- Source-intake tracking issue remains #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged and maintained |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN | Exact current/historical Desktop source, 21-build lineage, historical source-map content, verified internal package fragments, current native CLI metadata, public MCP schemas, Snapshot bundle, two web-build generations including CDN-removed cache recovery, live EditorState/runtime classes, and node/property model evidence; full original monorepo not recovered |
| P00-G04 Reproducible upstream build | PARTIAL_NOT_STARTED | Recovered Desktop source can be qualified independently; full product clean build remains unavailable without the complete original source tree |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Continue two tracks in parallel:

1. **Recovery:** accept only evidence with genuine marginal value. Non-elevated public/shipped/cache/live-runtime paths are now substantially exhausted. Elevated Windows VSS/restore/deleted-file forensics may be attempted only through an explicitly authorized administrator session; never bypass UAC or access controls. Other authorized devices may add historical artifacts if they come online.
2. **Implementation:** start Lilac's independent compatibility foundation from the proven document/MCP/Desktop/runtime surfaces. Implement the reconstructed compatibility contracts with explicit provenance labels and tests, then proceed into the document model, deterministic transactions/history, renderer/canvas, and code-sync programs.

The full Paper monorepo is no longer a prerequisite for beginning Lilac implementation, but it remains a missing artifact for any claim of complete original-source recovery.

## Integrity rule

Never fabricate source availability, ownership, build success, parity, review results, or Paper provenance. `PARTIAL_RECOVERY_PROVEN` is not equivalent to a complete Paper repository import. `RECOVERED_RUNTIME_CLASS_SOURCE` is production JavaScript evidence, not original TypeScript/TSX source. `COMPATIBILITY_RECONSTRUCTABLE` is not equivalent to recovered original source text.
