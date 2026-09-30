# Lilac — Canonical Program State

Last updated: 2026-10-01

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE — bootstrap proven; substantial shipped-source recovery proven; full monorepo still incomplete

## Canonical facts

- Repository: `TheHalfMoon/Lilac`
- Product name: **Lilac**
- Paper.design is an authorized donor/source according to the project owner's explicit attestation.
- Bootstrap PR #1 merged at `d60ad17833ce658b7ba09b87c1865e700151dc53`.
- Paper Desktop 0.5.14 recovery evidence was merged in PR #4 at canonical `main` SHA `a469c151a38c4129406ee0e9639a6e2a1511267f`.
- Public/shipped recovery census PR #5 merged at canonical `main` SHA `2685a526d714ff2fe5b5cb2e602dea38d0b8a8cd`; post-merge CI run `36784889241` succeeded on that exact SHA.
- The complete Paper private monorepo is **not** available through the connected GitHub source.
- Private GitHub access is no longer a hard prerequisite for progress: publicly downloadable and end-user-shipped artifacts expose substantial exact first-party source and compatibility evidence.
- Current Desktop 0.5.14 packages expose exact `@paper/desktop` TypeScript source. Cross-platform Linux/macOS comparison confirms the same current source surface with platform packaging differences.
- The expanded public Desktop corpus now spans **21 observed builds**, from early 0.1.x/0.2.x/0.3.x/0.4.x releases through every recovered 0.5.0–0.5.14 release in the lineage.
- The Desktop lineage contains **87 unique first-party source paths**; **46 paths have multiple distinct content hashes** across releases.
- Source maps are present through Paper Desktop **0.5.9** and disappear at the observed `0.5.9 → 0.5.10` boundary: 0.5.9 ships 1,450 maps; 0.5.10 ships zero.
- Historical source maps include embedded `sourcesContent`. Separately verified exact internal-package recovery now covers **16 TypeScript files plus `cli/package.json`** across `models`, `assets`, `cli`, and `client-desktop-types`.
- Three high-value internal targets remain unrecovered as exact source: `assets/src/types.ts`, `models/src/mcp/mcp-types.ts`, and `client-desktop-types/src/desktop-bridge.ts`.
- The 12-version gap-filling workflow `Paper Public History Census` run `36785630738` completed **SUCCESS** on exact head `f7763bbbdfa1955e7f3fd3c28dcf63e0739e8134`; all 12 matrix jobs downloaded, checksum-verified, extracted, inventoried, and uploaded metadata-only evidence successfully.
- Paper Snapshot 0.4.4 was recovered from the official Chrome CRX distribution endpoint; its shipped bundle contains 3 JavaScript files totaling 243,920 bytes.
- The current public Paper web editor exposes production and lazy-loaded JavaScript chunks including MCP, code import, Figma parsing, HTML export, media, image resolution, PDF, gradient, and worker surfaces. Current web `.map` probes do not return valid source maps.
- Public archive history adds historical web bundles but has not yielded valid web-editor source maps in the observed corpus.
- A separate public MIT project, `vcashwin/paper-snapshot`, provides a readable TypeScript implementation of a Paper-compatible DOM capture/serialization pipeline. It is tracked as an independent external donor/reference, not as official Paper source.
- Public Paper repositories remain separate independently licensed sources and must retain their own license/NOTICE obligations.
- Raw proprietary Paper source recovered from shipped artifacts is not committed to the public Lilac repository. Public evidence records contain hashes, paths, counts, and architectural findings only.
- Detailed recovery evidence:
  - `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`
  - `docs/evidence/PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md`
- Source-intake tracking issue remains #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged and maintained |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN | Exact current/historical Desktop source, 21-build lineage, historical source-map content, verified internal package fragments, Snapshot bundle, current/historical public web bundles; full monorepo not recovered |
| P00-G04 Reproducible upstream build | PARTIAL_NOT_STARTED | Recovered Desktop source can be qualified independently; full product clean build still unavailable without the complete source tree |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Continue two tracks in parallel:

1. **Recovery:** extend public/shipped artifact discovery where it has evidence value, preserve immutable hashes/provenance, classify any newly recovered exact source, and never conflate bundled code with original source.
2. **Implementation:** begin Lilac's independent, attributable implementation from the proven Desktop/MCP/contracts/document behavior surface, including the MIT Paper-compatible snapshot pipeline as an optional donor/reference, with deterministic transactions and tests.

The full Paper monorepo is no longer a prerequisite for beginning Lilac implementation, but it remains a missing artifact for any claim of complete original-source recovery.

## Integrity rule

Never fabricate source availability, ownership, build success, parity, review results, or Paper provenance. `PARTIAL_RECOVERY_PROVEN` is not equivalent to a complete Paper repository import.
