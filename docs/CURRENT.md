# Lilac — Canonical Program State

Last updated: 2026-10-06

## Program

**LILAC-P00 — Foundation, authorized-source intake, and staged product implementation**

Status: **ACTIVE** — Paper recovery is opportunistic and non-blocking. Grains 1–7 are `CLOSED_CANONICAL`; repository-side Graft context policy is canonical; Grain 8 Delivery Governance is the next implementation frontier.

## Canonical main

`723e7b067d95e3d600bf47c8b952adf4520d8c99`

This is the normal merge commit for PR #38 (Grain 7 Decision Router).

Post-merge CI run `37407426329` completed `SUCCESS` on that exact SHA (219/219 tests, 0 vulnerabilities).

## Canonical implementation chain

| Grain | Capability | State | Canonical evidence |
|---:|---|---|---|
| 1 | Design Assurance | CLOSED_CANONICAL | PR #19 implementation + PR #20 closeout; canonical closeout merge `8b444dbf96a4f064a8d0dd21ba19dc2b7d28cd5e` |
| 2 | Durable Agent Kernel | CLOSED_CANONICAL | PR #21 merged at `943a0727b9e15abbe7e47d8d7aa99adc6b0c3434` |
| 3 | Agent Event Protocol | CLOSED_CANONICAL | PR #24 merged at `47bd4f7f95e99b3e7f7f8c2700f87fb367288a73`; post-merge CI `37229773645` succeeded on the exact merge SHA |
| 4 | Agent Supervisor | CLOSED_CANONICAL | PR #31 merged at `9ab8b55eb319939c560646f640f444ed9a19916b`; post-merge CI `37313871378` succeeded |
| 5 | Local-first Collaboration | CLOSED_CANONICAL | PR #32 merged at `007e829fdc6e4a28f7fb5089277e6e535840f317`; post-merge CI `37327594078` succeeded |
| 6 | Import Stack | CLOSED_CANONICAL | PR #35 merged at `c3841a19e7d1d8c348e5ed114f101351725c6578` (qualified head `3955007ca055708bdb7efc0b4601cbd2df8bff6e`); post-merge CI `37405576580` succeeded |
| 7 | Decision Router | CLOSED_CANONICAL | PR #38 merged at `723e7b067d95e3d600bf47c8b952adf4520d8c99` (qualified head `9e25bd787b2e874120f6183beea1dfe07b1afba4`); post-merge CI `37407426329` succeeded |
| Tooling | Graft context/navigation policy | CANONICAL | PR #8 merged at `d6eb3be46e9d608b2071b80be0f6911ba5bf0c9b`; post-merge CI `37329841174` succeeded |

## Canonical facts

- Repository: `TheHalfMoon/Lilac`.
- Product name: **Lilac**.
- Paper.design remains an authorized donor/source according to the project owner's explicit attestation.
- The complete Paper private monorepo has not been recovered and must not be claimed as recovered.
- Public, shipped, and user-authorized local Paper evidence is sufficient for continued product implementation.
- Paper source recovery Issue #2 remains open for genuinely new marginal evidence only; it is not an implementation blocker.
- PR #27 preserved unique historical Paper recovery evidence and merged canonically at `06614e96227826b8324f723125076018a0f58247`.
- Stale Paper recovery PRs #9, #10, and #13 were closed as superseded only after their unique evidence was preserved canonically.
- Grain 1 provides deterministic local design assurance with Impeccable-backed adapters and Lilac-owned rule boundaries.
- Grain 2 provides durable replayable agent sessions, operation authority, idempotency, recovery/forks, and the document transaction boundary.
- Grain 3 provides the Lilac-owned typed event/replay protocol with deterministic sequencing, correlation, streaming/tool lifecycle, and handler isolation.
- Grain 4 provides local process/worktree supervision, one-owner mutation authority, leases, restart reconciliation, explicit lifecycle verbs, wake cursors, and bounded stale/wedge handling.
- Grain 5 provides local-first collaboration, a single authorization oracle, bounded presence, deterministic durable facts, comments, activity, agent attribution, reconnect/revocation semantics, and history-only document mutation.
- Graft `0.21.1` was qualified as a zero-cost local context/navigation layer. Its graph is local cache only, telemetry must remain disabled, and Graft is not correctness or qualification evidence.
- Jev + Alibaba Open Code Review remain qualification tools where applicable. Cubic, CodeRabbit, and Qodo are not qualification evidence.
- Normal merge commits remain mandatory; no rebase, force-push, or history rewriting is allowed.
- Core Lilac remains local-first/privacy-first with no mandatory paid cloud, model, API, or compute dependency.

## Program gates

| Gate | State |
|---|---|
| P00-G01 Repository bootstrap | PROVEN |
| P00-G02 Donor rights/provenance ledger | PROVEN_BASELINE |
| P00-G03 Authorized Paper source intake | PARTIAL_RECOVERY_PROVEN / OPPORTUNISTIC |
| P00-G04 Reproducible complete upstream Paper build | PARTIAL_NOT_AVAILABLE |
| P00-G05 Transformation plan | PROVEN_BASELINE |
| I01 Design Assurance Foundation | PROVEN |
| I02 Durable Agent Kernel | PROVEN |
| I03 Agent Event Protocol | PROVEN |
| I04 Agent Supervisor | PROVEN |
| I05 Collaboration | PROVEN |
| I06 Import Stack | PROVEN |
| I07 Decision Router | PROVEN |
| I08 Delivery Governance | ACTIVE_NEXT |
| I09 Design Method and Resources | BLOCKED_BY_I08 |

## Grain 6 — closed canonical

Grain 6 (Import Stack, `packages/import-stack`, Issue #34) is `CLOSED_CANONICAL` via PR #35, merged normally at `c3841a19e7d1d8c348e5ed114f101351725c6578` with post-merge CI `37405576580` green on the exact merge SHA. Exact-head qualification on `3955007ca055708bdb7efc0b4601cbd2df8bff6e` covered 204/204 tests, zero vulnerabilities, Jev 22/22 cells below threshold 0.70, Alibaba Open Code Review delegation SUCCESS (v1.12.9, 24 reviewable files), Graft blast-radius inspection, and manual review of all security-sensitive surfaces. Three import-boundary defects found during qualification (CSS continuation-split keywords, image-set fetch functions, fragment serialization breakouts) were repaired with forward commits and red-green tests. Full evidence is recorded on Issue #34.

The authority boundaries below held through implementation and remain in force for import-stack evolution:

Delivered scope (per `docs/DONOR_INTEGRATION_MAP.md` and Issue #34):

1. recovered Paper-compatible DOM/style snapshot semantics;
2. source-aware local app instrumentation;
3. isolated local Playwright capture for JavaScript-heavy pages;
4. optional local Docling adapter pinned to `docling-project/docling@0cd61e0050a9ef68e5e10495b87e41d31acd79c9`;
5. bounded static mirror fallback using selected lifecycle patterns from `AhmadIbrahiim/Website-downloader@130ad63d7163c19df64322556ca9c260eef353be`;
6. optional UI-TARS visual operator seam;
7. optional external Firecrawl connector/reference pinned to `firecrawl/firecrawl@4244638a7041bae8b99bdd42e3c44520f9e62da1` (AGPL, reference-only).

## Grain 7 — closed canonical

Grain 7 (Decision Router, `packages/decision-router`, Issue #37) is `CLOSED_CANONICAL` via PR #38, merged normally at `723e7b067d95e3d600bf47c8b952adf4520d8c99` with post-merge CI `37407426329` green on the exact merge SHA. Exact-head qualification on `9e25bd787b2e874120f6183beea1dfe07b1afba4` covered 219/219 tests, zero vulnerabilities, Jev 9/9 cells below threshold 0.70, Alibaba Open Code Review delegation SUCCESS (v1.12.9, 11 reviewable files), Graft blast-radius inspection, and manual review of the adapter contract, threshold/abstention semantics, batching, ledger idempotency, and dependency closure (zero new runtime dependencies). One elevated Jev cell drove a concrete hardening (bounded definition sizing before serialization with a nesting cap). Full evidence is recorded on Issue #37.

Delivered scope (per `docs/DONOR_INTEGRATION_MAP.md` and Issue #37): typed decision dimensions with label schemas; selected label plus confidence plus complete label-score distributions; bounded inputs and batching; provider-neutral adapter contract with strict output validation; deterministic prechecks that always outrank probabilistic output; explicit unsure-below threshold semantics with abstention; bounded manual-review routing; offline rule adapter; optional Jev adapter seam; idempotent request ledger; decision provenance records. Guidance donor `mrmps/classifier-dev@a17bf2b6353f6234af6e977a463da7cd1975b68e` (MIT); no SaaS, billing, gateway, or analytics code imported.

## Grain 8 — next canonical action

Grain 8 is **Delivery Governance** defined by `docs/DONOR_INTEGRATION_MAP.md`: Lilac's exact-head agent-authored source delivery and qualification layer, guided by `kunchenguid/no-mistakes@0616eb4911845e2ba04faa17186ecd2686d7d579`. Freeze a dedicated Grain 8 Issue/spec before implementation, branch from the exact canonical `main`, and close only after post-merge CI.

## Grain 6 authority boundaries

- Imported content is untrusted input.
- Import never bypasses `document-model` + `history` for canonical document mutation.
- Source provenance must survive capture and conversion.
- Executable page content is stripped or sandboxed by default.
- Local/private operation is the required baseline.
- Hosted crawlers, remote models, and paid providers are optional connectors only and never core prerequisites.
- Import adapters may create normalized proposals/IR, but they do not become a second document authority.

## Later sequence

Grain 8 and Grain 9 remain, then the broader Master Plan work:

1. Grain 8 — Delivery Governance for exact-head repository change qualification;
3. Grain 9 — Design Method and Resources;
4. continue broader Master Plan work: bidirectional code/design IR, native code components, Visual Git, parity disposition, product hardening, packaging, release, and reproducible smoke evidence.

## Integrity rule

Never fabricate source availability, donor ownership, build success, parity, review results, CI, Jev/OCR outcomes, or provenance. `PARTIAL_RECOVERY_PROVEN` is not a complete Paper source recovery claim, and behavioral/compatibility ports must not be represented as recovered original source text.
