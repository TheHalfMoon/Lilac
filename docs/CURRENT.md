# Lilac — Canonical Program State

Last updated: 2026-10-06

## Program

**LILAC-P00 — Foundation, authorized-source intake, and staged product implementation**

Status: **ACTIVE** — Paper recovery is opportunistic and non-blocking. Grains 1–9 are `CLOSED_CANONICAL`; P03 architecture ownership and P04 parity disposition are complete; repository-side Graft context policy is canonical; the program continues with the P05 product differentiators.

## Canonical main

`83c195e59ab04d6d2dcc1fe1378101c2faf2635a`

This is the normal merge commit for PR #75 (P05 D6a local project persistence, Issue #74).

Post-merge CI run `37524902541` completed `SUCCESS` on that exact SHA (362/362 tests).

## Post-grain program state

- P03 architecture ownership: complete via PR #47, Issue #46 closed. `packages/architecture` maps every required subsystem to exactly one owner with machine-checked validation; missing subsystems are declared as planned, not implemented.
- P04 parity disposition: complete via PR #49, Issue #48 closed. Every `docs/PARITY_MATRIX.md` row carries a terminal disposition with evidence or a deferral pointer; nothing is intentionally dropped.
- P05 D1 code/design IR slice: complete via PR #52, Issue #51 closed. `packages/code-ir` provides bounded JSX/TSX, CSS, and Tailwind adapters, range-anchored patches, hunk-based three-way reconciliation, and golden round-trip fixpoints with zero new runtime dependencies.
- P05 D2 native design components: complete via PR #55, Issue #54 closed. `packages/design-components` provides contracts with typed props/slots/states/variants, strict binding to D1 symbols, verified-patch variants with drift refusal, source-linked previews, drift detection, and system membership with only the `@lilac/code-ir` workspace dependency.
- P05 D3 multi-agent workspace: complete via PR #58, Issue #57 closed. `packages/agent-workspace` provides the program role registry with capability scopes, role assignment, out-of-scope rejection, an append-only action ledger with full attribution, cancellation, and reversal marking with zero new runtime dependencies.
- P05 D4 Visual Git: complete via PR #62, Issue #60 closed. `packages/visual-git` provides design snapshots bound to branch and source commit, stable identity and tree validation, structural diffs, anchored review comments and design/code links, three-way conflict reports (node-level plus structural cycle, nesting, depth, and size conflicts; never a merged snapshot), exact-head acceptance gates, and provenance records with zero runtime dependencies. Qualification drove four forward repairs (merge-structure conflicts, getter/proxy and array-species input forgery, merge limits, hidden-text characters). Parked panel follow-ups: #64.
- Canonical serializer defect: fixed via PR #66 (merge `569dca2`), Issue #61 closed. All package canonical serializers emit parseable key-sorted JSON, guarded by a shared parse-back test. Derived identity digests changed; none were persisted, so no migration was needed.
- P03 catalog drift: fixed via PR #67 (merge `0815425`), Issue #63 closed. The catalog reflects D1-D4 (`code-ir`, `round-trip-sync`, `components` as stub slices; `agent-workspace`, `visual-git`, `architecture-ownership` implemented), and CI now fails if any workspace package lacks a delivered owner or the known-package list drifts.
- P05 D5 decision assurance: complete via PR #70 (merge `63de513`), Issue #69 closed. `packages/decision-assurance` (workspace deps `@lilac/design-method`, `@lilac/decision-router` only) runs deterministic rule-pack, accessibility, layout, and design-system checks first, lets an optional router adapter order only eligible candidates of equal penalty, abstains explicitly (insufficient candidates, none eligible, adapter failure, leading candidate abstained or weak, tie), and records rationale and evidence; it never mutates documents. Catalog status `stub`: color-contrast and token-conformance checks wait for snapshots that carry color and token data. Qualification drove two repair cycles (adapter isolation against prototype pollution and result getters, bounded router input).
- Decision-router adapter isolation: fixed via PR #72 (merge `121c91d`), Issue #71 closed. The router reads adapter identity once, hands adapters cloned cells and policy, clones outcomes once, and re-issues every adapter throw with a bounded, host-independent reason.
- P05 D6a local project persistence: complete via PR #75 (merge `83c195e`), Issue #74 closed. `packages/persistence` (workspace deps `@lilac/document-model`, `@lilac/history` only) stores projects under `<root>/.lilac` with content-addressed objects, a SHA-256 hash-chained append-only journal of history transactions, atomic writes, atomic project creation, crash recovery (unterminated tails recovered; all other damage fails closed), a nonce-bound single-writer lock with recorded stale-lock override, manifest migration, and a journal pin (device, inode, ctime) checked before every append. Document state is only produced by replaying history transactions. Catalog status `stub` (agent-state persistence planned). Qualification drove three repair cycles plus one fix from exact-head Linux CI (inode reuse); residual risks are recorded in the evidence file.
- Next: P05 D6b (explicit network capability policy, bring-your-own provider registry, offline guarantees).
- Open, non-blocking: #64 (review-panel hardening follow-ups, including a shared hidden-text and input-hygiene policy across packages).

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
| 8 | Delivery Governance | CLOSED_CANONICAL | PR #41 merged at `cf8dee827e79f175b79e61504dbc03c063fc2c17` (qualified head `8cf830779e85c8f1bd50603d1a417422956168e5`); post-merge CI `37409833005` succeeded |
| 9 | Design Method and Resources | CLOSED_CANONICAL | PR #44 merged at `6c5031509b798a20cd57e7b693dc586eaccbbaeb` (qualified head `8db81443cceba301a7e0c2d894507dbd3e572e47`); post-merge CI `37411386981` succeeded |
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
- The Open Code Review CI workflow runs `ocr delegate` (preview + resolved rule groups, no LLM); it produces no findings by itself. Qualification records the host agent applying those rule groups to every reviewable file.
- pstack is `phthomas/pstack` v2.3.1 (`faa4e9f`) at `~/.tooling/pstack`: a SKILL.md skill pack, not a CLI. Its review step is `ps-review` (fresh-context judge panel over the exact diff, security judge on trigger surfaces, delta re-reviews capped at 3 cycles). First used as qualification evidence on P05 D4.
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
| I08 Delivery Governance | PROVEN |
| I09 Design Method and Resources | PROVEN |

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

## Grain 8 — closed canonical

Grain 8 (Delivery Governance, `packages/delivery-governance`, Issue #40) is `CLOSED_CANONICAL` via PR #41, merged normally at `cf8dee827e79f175b79e61504dbc03c063fc2c17` with post-merge CI `37409833005` green on the exact merge SHA. Exact-head qualification on `8cf830779e85c8f1bd50603d1a417422956168e5` covered 232/232 tests, zero vulnerabilities, Jev 9/9 cells below threshold 0.70, Alibaba Open Code Review delegation SUCCESS (v1.12.9, 11 reviewable files), Graft blast-radius inspection, and manual review of findings, gates, repair ancestry, ask-user lifecycle, CI model, movement guards, merge-strategy guard, and dependency closure (zero new runtime dependencies). Elevated Jev cells drove three concrete repairs with red-green proofs (ancestor-resolved destination confinement, disposable-root resolution including not-yet-existing roots, and a pinned single-root evidence store redesign); one intermediate CI run caught a real clean-machine-only confinement gap masked locally by a leftover directory. Full evidence is recorded on Issue #40.

Delivered scope (per `docs/DONOR_INTEGRATION_MAP.md` and Issue #40): structured findings; worktree identity verification records shaped by the Grain 4 supervisor boundary; exact-head proof; base/head movement protection; CI qualification model; repair ancestry with rerun-after-fix; explicit ask-user state; evidence bundles confined to one pre-registered store root outside disposable worktrees; merge-strategy guard (normal merge only); qualification invalidation on mutation. Guidance donor `kunchenguid/no-mistakes@0616eb4911845e2ba04faa17186ecd2686d7d579` (MIT); no daemon, proxy, hooks, database, billing, or forge machinery imported.

## Grain 9 — closed canonical

Grain 9 (Design Method and Resources, `packages/design-method`, Issue #43) is `CLOSED_CANONICAL` via PR #44, merged normally at `6c5031509b798a20cd57e7b693dc586eaccbbaeb` with post-merge CI `37411386981` green on the exact merge SHA. Exact-head qualification on `8db81443cceba301a7e0c2d894507dbd3e572e47` covered 241/241 tests, zero vulnerabilities, Jev 9/9 cells below threshold 0.70 with no repairs required, Alibaba Open Code Review delegation SUCCESS (v1.12.9, 11 reviewable files), Graft blast-radius inspection, and manual review of rule-pack validation, snapshot evaluation, checklist binding, registry licensing, and dependency closure (zero new runtime dependencies). Full evidence is recorded on Issue #43.

Delivered scope (per `docs/DONOR_INTEGRATION_MAP.md` and Issue #43): Lilac-authored mobile/native rule packs with deterministic snapshot evaluation producing rule- and node-referenced review candidates; agent review checklists bound to rule IDs; a versioned provider/resource taxonomy with a registry requiring explicit per-entry licensing. Guidance donors `Appllama/appllama-skills@dd5caaec3d5d50ad7fc0324da238119c6b7c3707` (MIT) and `reinaldosimoes/design-resources@43fe2b5d801e34c21e22b5639711f7e250a798e5` (CC0-1.0); no screens, assets, links, MCP wiring, models, or paid services imported.

## Next program frontier

All staged grains 1–9 are closed. The program continues with the broader Master Plan work:

## Grain 6 authority boundaries

- Imported content is untrusted input.
- Import never bypasses `document-model` + `history` for canonical document mutation.
- Source provenance must survive capture and conversion.
- Executable page content is stripped or sandboxed by default.
- Local/private operation is the required baseline.
- Hosted crawlers, remote models, and paid providers are optional connectors only and never core prerequisites.
- Import adapters may create normalized proposals/IR, but they do not become a second document authority.

## Later sequence

The remaining product program, in working order:

1. P03 — Architecture completion (explicit typed subsystem ownership);
2. P04 — Paper capability parity disposition;
3. P05 D1 - Bidirectional code/design engine (round-trip React/JSX/TSX, CSS, Tailwind with AST-aware patches);
4. P05 D2 - Code components as native design primitives;
5. P05 D3 - Multi-agent workspace product surface;
6. P05 D4 - Visual Git (complete; #61 and #63 also closed);
7. P05 D5 - Decision assurance (complete; #71 router hardening also closed);
8. P05 D6 - Local/private mode (D6a persistence complete; D6b network policy, providers, and offline guarantees next);
9. P05 D7 - Website/app intake product experience;
10. P06 - Product hardening;
11. P07 - Release program with signed evidence and clean-machine verification.

## Integrity rule

Never fabricate source availability, donor ownership, build success, parity, review results, CI, Jev/OCR outcomes, or provenance. `PARTIAL_RECOVERY_PROVEN` is not a complete Paper source recovery claim, and behavioral/compatibility ports must not be represented as recovered original source text.
