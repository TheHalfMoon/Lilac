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
- The complete Paper private monorepo is **not** available through the connected GitHub source.
- Private GitHub access is no longer a hard prerequisite for progress: publicly downloadable and end-user-shipped artifacts expose substantial exact first-party source and compatibility evidence.
- Current Desktop 0.5.14 packages expose exact `@paper/desktop` TypeScript source. Cross-platform Linux/macOS comparison confirms the same current source surface with platform packaging differences.
- Nine historical Desktop versions from 0.1.10 through 0.5.14 were recovered from public release artifacts. The lineage contains 87 unique first-party Desktop source paths, with 36 paths changing across versions.
- Historical Desktop builds shipped up to 1,458 source maps. A parsed historical corpus includes embedded `sourcesContent`, including verified source from internal monorepo packages such as `models`, `assets`, `cli`, and `client-desktop-types`.
- Paper Snapshot 0.4.4 was recovered from the official Chrome CRX distribution endpoint; its shipped bundle contains 3 JavaScript files totaling 243,920 bytes.
- The current public Paper web editor exposes production and lazy-loaded JavaScript chunks including MCP, code import, Figma parsing, HTML export, media, image resolution, PDF, gradient, and worker surfaces. Current web `.map` probes do not return valid source maps.
- Public archive history adds historical web bundles but has not yielded valid web-editor source maps in the observed corpus.
- Public Paper repositories remain separate independently licensed sources and must retain their own license/NOTICE obligations.
- Raw proprietary Paper source recovered from shipped artifacts is not committed to the public Lilac repository. Public evidence records contain hashes, paths, counts, and architectural findings only.
- Detailed recovery evidence: `docs/evidence/PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`.
- Source-intake tracking issue remains #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN | Exact current/historical Desktop source, historical source-map content, Snapshot bundle, current/historical public web bundles; full monorepo not recovered |
| P00-G04 Reproducible upstream build | PARTIAL_NOT_STARTED | Recovered Desktop source can be qualified independently; full product clean build still unavailable without the complete source tree |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Continue two tracks in parallel:

1. **Recovery:** finish the public/shipped artifact census, preserve immutable hashes/provenance, classify any newly recovered exact source, and never conflate bundled code with original source.
2. **Implementation:** begin Lilac's independent, attributable implementation from the proven Desktop/MCP/contracts/document behavior surface, with deterministic transactions and tests, while keeping recovered proprietary source outside the public repository unless publication rights are separately established.

The full Paper monorepo is no longer a prerequisite for beginning Lilac implementation, but it remains a missing artifact for any claim of complete original-source recovery.

## Integrity rule

Never fabricate source availability, ownership, build success, parity, review results, or Paper provenance. `PARTIAL_RECOVERY_PROVEN` is not equivalent to a complete Paper repository import.
