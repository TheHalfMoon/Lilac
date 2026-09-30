# Lilac — Canonical Program State

Last updated: 2026-09-30

## Program

**LILAC-P00 — Foundation and authorized-source intake**

Status: ACTIVE

## Canonical facts

- Repository: `TheHalfMoon/Lilac`
- Product name: **Lilac**
- Paper.design is an authorized donor/source according to the project owner's explicit attestation.
- The complete Paper product source is **not present** in the GitHub sources currently connected to this repository.
- Public Paper repositories observed during bootstrap include `paper-design/shaders`, `paper-design/paper-mono`, `paper-design/agent-plugins`, `paper-design/opentype.js`, `paper-design/google-fonts-scripts`, `paper-design/liquid-logo`, and `paper-design/webmcp-agent-example`.
- `paper-design/paper-mono` is a font project, not the Paper application source.
- No claim of Paper application-source import is permitted until an exact source artifact is received and hashed.

## Active gates

| Gate | State | Exit evidence |
|---|---|---|
| P00-G01 Repository bootstrap | IN PROGRESS | Bootstrap PR merged and post-merge CI green |
| P00-G02 Donor rights/provenance ledger | READY | `docs/DONORS.md` + authorization record |
| P00-G03 Authorized Paper source intake | BLOCKED_EXTERNAL | Exact source artifact/path or accessible repository |
| P00-G04 Reproducible upstream build | NOT STARTED | Clean build/run evidence from imported revision |
| P00-G05 Transformation plan | READY | `docs/MASTER_PLAN.md` and `docs/ARCHITECTURE.md` |

## Next canonical action

Merge the bootstrap program after CI. Then ingest the exact authorized Paper source with `scripts/import-authorized-paper.mjs`, record its revision and manifest, and create the first source-intake PR without rebranding or behavioral changes.

## Integrity rule

A blocked external input is not project completion. Never fabricate source availability, build success, parity, review results, or Paper provenance.
