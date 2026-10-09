# Ninerr — Canonical Program State

Last updated: 2026-10-09

## Program

**P08 — Deep qualification and dogfooding.** N0, Ninerr independence and migration (umbrella #190), is `CLOSED_CANONICAL`. The founder renamed the product to Ninerr on 2026-10-08 and set the order: N0, P08 deep qualification and dogfooding, P09 Ninerr UI and UX, P10 release candidate hardening, then the founder release gate (`docs/MASTER_PLAN.md`). v1.0.0 is not authorized.

Status: **P08 ACTIVE.** N0 closed on 2026-10-09, with every exit criterion verified (`docs/evidence/N0_CLOSE_2026-10-09.md`). Each N0 grain landed through its own PR with exact-head CI, Jev qualification and review, and its evidence is in the `N0_*` records under docs/evidence. N0 delivered:
- the identity census (G1);
- the persisted-data and host migrations with backward compatibility (G2), and the #185 write-back fix;
- the package scope, product, tooling, runtime and prose identity (G3);
- Ninerr's own MCP surface (G4);
- the retirement of all donor-product recovery tooling and records (G5);
- the coherence audit (G6);
- the A/B source-rights audit, the Apache-2.0 license, the notices and the Electron corresponding source (G7);
- the documentation (G8);
- the independence regression gate in CI, with a narrow, reviewed allowlist (G9);
- the repository rename to `TheHalfMoon/Ninerr`, with its redirects verified (G10);
- the repository cleanup: a contributing guide, issue and PR templates, the repository description and topics, and the public docs (G11).

P08 tests complete end-to-end journeys repeatedly and adds property and state-machine coverage, before any final UI design (P09).

## Canonical main

`97f3a37218bbe14fbf4fff335136b6be87bb8692`

This is the normal merge commit for PR #229, which made the agent registry and the codebase links refuse a newer version. It is the latest commit whose post-merge run was verified when this page was updated. Post-merge Foundation checks completed `SUCCESS` on that exact SHA (776/776 tests). A build-only release workflow run succeeded on `666632e`. #229 changes no file on the release path as `release.yml` defines it, and the Desktop run on `97f3a37` packaged and smoke-tested all three archives. The Desktop package runs for Linux x64, macOS arm64 and Windows x64 each succeeded, including the release-candidate journey.

## Before the v1 tag
1. **License.** Resolved: Ninerr is Apache-2.0 (`LICENSE`), after the A/B source-rights audit (`docs/evidence/N0_G7A_LICENSE_2026-10-09.md`).
2. **Private vulnerability reporting.** Resolved: it is enabled and verified (`SECURITY.md`).
3. **Publisher signing.** Open. This needs an Apple Developer ID with notarization credentials and a Windows code-signing certificate, as Actions secrets (#139).
4. **LGPL corresponding source.** The binding is done (`docs/provenance/ELECTRON_CORRESPONDING_SOURCE.json`), and the release workflow verifies it live. How a binary release offers that source is a founder release-gate decision (`docs/evidence/N0_G7B_ELECTRON_SOURCE_2026-10-09.md`).
5. **The tag.** Not authorized. No release tag is created until the founder release gate passes.

## Canonical facts
- Product: **Ninerr**, licensed under Apache-2.0. The repository is `TheHalfMoon/Ninerr`.
- Ninerr does not depend on any donor product or any donor's identity (`docs/evidence/N0_G6_COHERENCE_AUDIT_2026-10-09.md`). The audited register of every source is `docs/provenance/LICENSE_REGISTER.json`.
- The full suite fails some tests on Windows, which CI does not run (#192).

## The program before the rename
The state of every phase, grain and gate up to N0 is recorded unchanged in `docs/evidence/PROGRAM_STATE_2026-10-09.md`. There, grains 1 to 9, P03, P04, the P05 slices, P06 and PC are `CLOSED_CANONICAL`, P07 Release is active, and P00's gates have the states the record gives them.
