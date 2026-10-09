# Ninerr — Canonical Program State

Last updated: 2026-10-09

## Program

**N0 — Ninerr independence and migration** (umbrella #190). The founder renamed the product to Ninerr on 2026-10-08 and set the order: N0, P08 deep qualification and dogfooding, P09 Ninerr UI and UX, P10 release candidate hardening, then the founder release gate (`docs/MASTER_PLAN.md`). v1.0.0 is not authorized.

Status: **N0 ACTIVE.** Each N0 grain landed through its own PR with exact-head CI, Jev qualification and review, and its evidence is in the `N0_*` records under docs/evidence. Delivered so far:
- the identity census (G1);
- the persisted-data and host migrations with backward compatibility (G2), and the #185 write-back fix;
- the package scope, product, tooling, runtime and prose identity (G3);
- Ninerr's own MCP surface (G4);
- the retirement of all Paper recovery tooling and records (G5);
- the coherence audit (G6);
- the A/B source-rights audit, the Apache-2.0 license, the notices and the Electron corresponding source (G7);
- the documentation (G8).

The independence gate (G9) and the repository rename (G10) remain.

## Canonical main

`679429f0c1e33c1fd382745bcfea99607f034977`

This is the normal merge commit for PR #220, which fixed a race in the local runtime test. It is the latest commit whose post-merge run was verified when this page was updated. Post-merge Foundation checks completed `SUCCESS` on that exact SHA (769/769 tests). The Desktop package runs for Linux x64, macOS arm64 and Windows x64 each succeeded, including the release-candidate journey.

## Before the v1 tag
1. **License.** Resolved: Ninerr is Apache-2.0 (`LICENSE`), after the A/B source-rights audit (`docs/evidence/N0_G7A_LICENSE_2026-10-09.md`).
2. **Private vulnerability reporting.** Resolved: it is enabled and verified (`SECURITY.md`).
3. **Publisher signing.** Open. This needs an Apple Developer ID with notarization credentials and a Windows code-signing certificate, as Actions secrets (#139).
4. **LGPL corresponding source.** The binding is done (`docs/provenance/ELECTRON_CORRESPONDING_SOURCE.json`), and the release workflow verifies it live. How a binary release offers that source is a founder release-gate decision (`docs/evidence/N0_G7B_ELECTRON_SOURCE_2026-10-09.md`).
5. **The tag.** Not authorized. No release tag is created until the founder release gate passes.

## Canonical facts
- Product: **Ninerr**, licensed under Apache-2.0. The repository is `TheHalfMoon/Lilac` until N0-G10 renames it.
- Ninerr does not depend on Paper or on any donor's identity (`docs/evidence/N0_G6_COHERENCE_AUDIT_2026-10-09.md`). The audited register of every source is `docs/provenance/LICENSE_REGISTER.json`.
- The full suite fails some tests on Windows, which CI does not run (#192).

## The program before the rename
The state of every phase, grain and gate up to N0 is recorded unchanged in `docs/evidence/PROGRAM_STATE_2026-10-09.md`. There, grains 1 to 9, P03, P04, the P05 slices, P06 and PC are `CLOSED_CANONICAL`, P07 Release is active, and P00's gates have the states the record gives them.
