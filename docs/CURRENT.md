# Lilac — Canonical Program State

Last updated: 2026-09-30

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE — bootstrap proven; source intake externally blocked

## Canonical facts

- Repository: `TheHalfMoon/Lilac`
- Product name: **Lilac**
- Paper.design is an authorized donor/source according to the project owner's explicit attestation.
- Bootstrap PR #1 merged at `d60ad17833ce658b7ba09b87c1865e700151dc53`.
- Post-merge CI run `36759529733` completed successfully on that exact `main` SHA.
- The complete Paper product source is **not present** in the GitHub sources currently connected to this repository.
- Public Paper repositories observed during bootstrap include `paper-design/shaders`, `paper-design/paper-mono`, `paper-design/agent-plugins`, `paper-design/opentype.js`, `paper-design/google-fonts-scripts`, `paper-design/liquid-logo`, and `paper-design/webmcp-agent-example`.
- `paper-design/paper-mono` is a font project, not the Paper application source.
- No claim of Paper application-source import is permitted until an exact source artifact is received and hashed.
- Source-intake blocker is tracked in issue #2.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | PROVEN | PR #1 merged; post-merge CI `36759529733` SUCCESS |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE | `docs/DONORS.md` + authorization record merged |
| P00-G03 Authorized Paper source intake | BLOCKED_EXTERNAL | Issue #2; exact source artifact/path or accessible repository required |
| P00-G04 Reproducible upstream build | NOT STARTED | Clean build/run evidence from imported revision |
| P00-G05 Transformation plan | PROVEN_BASELINE | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` merged |

## Next canonical action

Ingest the exact authorized Paper source with `scripts/import-authorized-paper.mjs`, record its revision and manifest, and create a source-intake-only PR without rebranding, formatting, dependency upgrades, or behavioral changes.

## Integrity rule

A blocked external input is not project completion. Never fabricate source availability, build success, parity, review results, or Paper provenance.
