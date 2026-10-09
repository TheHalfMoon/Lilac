# Ninerr Master Plan

## Mission

Ninerr is an AI-native, web-semantic design environment where humans, software agents, production code, and design systems operate on one shared model. It is one coherent, independently identifiable product with a stronger architecture for round-trip code synchronization, local/private operation, multi-agent work, visual review, and deterministic export.

## Non-negotiable principles

1. **Evidence before claims.** Every imported donor snapshot, build, test, parity claim, and release must bind to an exact revision and reproducible evidence.
2. **Preserve donor provenance.** Authorized use does not erase third-party notices, dependency licenses, or attribution requirements.
3. **Independent identity.** No donor's names, marks, endpoints, IDs, telemetry, service assumptions or visual branding ship in Ninerr unless an obligation requires attribution.
4. **Web semantics first.** HTML/CSS concepts are the canonical bridge between canvas and production code.
5. **Round-trip safety.** Import/export is not enough. Ninerr must preserve intent when code becomes design and design becomes code again.
6. **Local/private first.** Core creation, agent control, source inspection, and project persistence must work without a paid cloud dependency.
7. **Agents are collaborators, not hidden automation.** Agent mutations are attributable, reviewable, cancellable, and reversible.
8. **No destructive source normalization.** The first authorized-source intake is an immutable snapshot; transformation happens in later commits. (No authorized-source intake ever received source, and N0-G5 retired the intake.)

## Current program

The founder set the order on 2026-10-08, when the product was renamed to Ninerr:
1. **N0: Ninerr independence and migration.** This covers the identity census and migration; backward compatibility for projects and setups from before the rename; independence from every donor's identity; the Apache-2.0 license with its source-rights audit; the Electron corresponding source; the documentation; the CI identity gate; and the repository rename. Issue #190 tracks it, and each grain's evidence is in `docs/evidence/N0_*`.
2. **P08: deep qualification and dogfooding.**
3. **P09: Ninerr UI and UX.**
4. **P10: release candidate hardening.**
5. **The founder release gate,** then v1.0.0.

v1.0.0 is not authorized. No release tag is created, and nothing is published, until the founder release gate passes.

## Definition of genuinely complete

Ninerr is not complete merely because the UI launches. Completion requires:

1. the authorized donor baseline is traceable;
2. the shipped product has independent identity;
3. required parity rows are proven or intentionally dispositioned (the rows are in the parity matrix, retired in N0-G8b to `docs/evidence/PARITY_MATRIX_2026-10-06.md`; the architecture catalog in `packages/architecture` records each subsystem's status);
4. differentiators D1–D7 have acceptance evidence;
5. security, accessibility, performance, persistence, recovery, and license gates pass;
6. a fresh user can install, create/edit, use an agent, connect a codebase, round-trip a component, and export without hidden paid infrastructure.

## The program before the rename
Phases P00 to P07 and PC were planned and delivered before the rename. They are recorded unchanged in `docs/evidence/MASTER_PLAN_2026-10-09.md`. Their quality gates and release artifacts are the ones this program inherits.
