# Lilac — Canonical Program State

Last updated: 2026-10-08

## Program

**LILAC-P00 — Foundation, authorized-source intake, and staged product implementation**

Status: **ACTIVE** — Paper recovery is opportunistic and non-blocking. Grains 1–9 are `CLOSED_CANONICAL`; P03 architecture ownership and P04 parity disposition are complete; repository-side Graft context policy is canonical; P05 differentiators D1–D7 have delivered slices; all 11 P06 Product Hardening gates are `CLOSED_CANONICAL` (umbrella #100, closed); the scope-independent P07 artifacts have landed; all 17 PC Product Completion gates are `CLOSED_CANONICAL` and the phase is closed (umbrella #146); the program is in P07 Release.

## Canonical main

`8b5a74f3c333811b7af70cc8b3bd91a10cad18db`

This is the normal merge commit for PR #184 (PC11b, a connected codebase through the editor and the release-candidate journey), which closed PC11 (#182) and with it the last work of the PC Product Completion phase (umbrella #146).

Post-merge Foundation checks completed `SUCCESS` on that exact SHA (721/721 tests), and the Desktop package runs for Linux x64, macOS arm64 and Windows x64 each passed the release-candidate journey (18/18).

## Post-grain program state

- P03 architecture ownership: complete via PR #47, Issue #46 closed. `packages/architecture` maps every required subsystem to exactly one owner with machine-checked validation; missing subsystems are declared as planned, not implemented.
- P04 parity disposition: complete via PR #49, Issue #48 closed. Every `docs/PARITY_MATRIX.md` row carries a terminal disposition with evidence or a deferral pointer; nothing is intentionally dropped.
- P05 D1 code/design IR slice: complete via PR #52, Issue #51 closed. `packages/code-ir` provides bounded JSX/TSX, CSS, and Tailwind adapters, range-anchored patches, hunk-based three-way reconciliation, and golden round-trip fixpoints with zero new runtime dependencies.
- P05 D2 native design components: complete via PR #55, Issue #54 closed. `packages/design-components` provides contracts with typed props/slots/states/variants, strict binding of props and slots to D1 symbols (states are declared but not yet source-bound; #78), verified-patch variants with drift refusal, source-linked previews, drift detection, and system membership with only the `@ninerr/code-ir` workspace dependency.
- P05 D3 multi-agent workspace: complete via PR #58, Issue #57 closed. `packages/agent-workspace` provides the program role registry with capability scopes, role assignment, out-of-scope rejection, an append-only action ledger with full attribution, cancellation, and reversal marking with zero new runtime dependencies.
- P05 D4 Visual Git: complete via PR #62, Issue #60 closed. `packages/visual-git` provides design snapshots bound to branch and source commit, stable identity and tree validation, structural diffs, anchored review comments and design/code links, three-way conflict reports (node-level plus structural cycle, nesting, depth, and size conflicts; never a merged snapshot), exact-head acceptance gates, and provenance records with zero runtime dependencies. Qualification drove four forward repairs (merge-structure conflicts, getter/proxy and array-species input forgery, merge limits, hidden-text characters). Parked panel follow-ups: #64.
- Canonical serializer defect: fixed via PR #66 (merge `569dca2`), Issue #61 closed. All package canonical serializers emit parseable key-sorted JSON, guarded by a shared parse-back test. Derived identity digests changed; none were persisted, so no migration was needed.
- P03 catalog drift: fixed via PR #67 (merge `0815425`), Issue #63 closed. The catalog reflects D1-D4 (`code-ir`, `round-trip-sync`, `components` as stub slices; `agent-workspace`, `visual-git`, `architecture-ownership` implemented), and CI now fails if any workspace package lacks a delivered owner or the known-package list drifts.
- P05 D5 decision assurance: complete via PR #70 (merge `63de513`), Issue #69 closed. `packages/decision-assurance` (workspace deps `@ninerr/design-method`, `@ninerr/decision-router` only) runs deterministic rule-pack, accessibility, layout, and design-system checks first, lets an optional router adapter order only eligible candidates of equal penalty, abstains explicitly (insufficient candidates, none eligible, adapter failure, leading candidate abstained or weak, tie), and records rationale and evidence; it never mutates documents. Catalog status `stub`: color-contrast and token-conformance checks wait for snapshots that carry color and token data. Qualification drove two repair cycles (adapter isolation against prototype pollution and result getters, bounded router input).
- Decision-router adapter isolation: fixed via PR #72 (merge `121c91d`), Issue #71 closed. The router reads adapter identity once, hands adapters cloned cells and policy, clones outcomes once, and re-issues every adapter throw with a bounded, host-independent reason.
- P05 D6a local project persistence: complete via PR #75 (merge `83c195e`), Issue #74 closed. `packages/persistence` (workspace deps `@ninerr/document-model`, `@ninerr/history` only) stores projects under `<root>/.lilac` with content-addressed objects, a SHA-256 hash-chained append-only journal of history transactions, atomic writes, atomic project creation, crash recovery (unterminated tails recovered; all other damage fails closed), a nonce-bound single-writer lock with recorded stale-lock override, manifest migration, and a journal pin (device, inode, size, and a SHA-256 of the content this writer validated and appended; ctime until the #88 repair, PR #91) checked before every append. Document state is only produced by replaying history transactions. Catalog status `stub` (agent-state persistence planned). Qualification drove three repair cycles plus one fix from exact-head Linux CI (inode reuse); residual risks are recorded in the evidence file.
- Parity matrix refresh: PR #77 (merge `bbc3f69`). LILAC-D1, D4, D5 cite delivered P05 evidence; LILAC-D2 and D8 stay pending with tracked owners (#78 component states source binding, #79 tokens subsystem); LILAC-D6 was withdrawn from an unsupported earlier PARITY_PROVEN.
- P05 D6b network policy and offline guarantee: complete via PR #81 (merge `c95acf6`), Issue #80 closed. `packages/network-policy` (no dependencies) is the single owner of address classification (moved from import-stack and tightened: unspecified addresses denied everywhere, deprecated IPv6 forms forbidden), provides a default-deny capability policy (offline / local-only / allowlist grants) with pre-DNS and post-DNS decisions honored only when issued by the policy, a credential-reference-only provider registry, and offline readiness. `tests/offline-guarantee.test.mjs` proves the core workflow (create, edit, undo/redo, agent-attributed collaboration edit, save, reopen, method review, decision assurance, offline import) makes zero network attempts with every network and process primitive trapped; LILAC-D6 is PARITY_PROVEN on that basis. Not yet: the local MCP endpoint (#82; catalog `mcp-surface` corrected to stub) and import-stack enforcement through the new policy (#83).
- P05 D7a intake: complete via PR #87 (merge `1d3f4a9`), Issue #85 closed. `packages/intake` (workspace deps `@ninerr/import-stack`, `@ninerr/network-policy`, `@ninerr/persistence`, `@ninerr/history`) adds a deterministic pre-commit review of Grain 6 proposals (counts, sanitization summary, severity-ordered bounded diagnostics, source-binding coverage, commit verdict), markup-only web semantics recorded as `OBSERVED` evidence with their source (HTML-AAM native mappings with landmark scoping, ARIA role-token precedence, bounded accessible names), a single-snapshot commit into a persisted project through `ProjectStore.commit`, and a network gate that maps `import.fetch` decisions to import-stack policies without loosening them. The offline-guarantee test now includes intake. Qualification drove three delta repair cycles; parked items are in #89.
- Persistence journal content pin: fixed via PR #91 (merge `af80efc`), Issue #88 closed. The in-session pin had compared ctime, which missed same-size in-place rewrites inside one filesystem timestamp tick (milliseconds, not the nanoseconds the D6a evidence first stated; reopen caught them by the hash chain). The store now keeps a SHA-256 of the bytes it validated at open and appended since, and verifies it through the write descriptor before every append; metadata-only changes no longer poison the store. The D6a evidence residuals are corrected (verify-to-write window up to about 341 ms at the 256 MiB cap; per-append cost grows with the journal until rotation exists).
- Import-stack enforcement through the network policy: complete via PR #93 (merge `b10494f`), Issue #83 closed. Import requests may carry a `networkPolicy`; every import contact (entry, mirror pages and assets, redirects, Playwright subrequests and final URLs, mirror manifest re-validation) needs an allowed `import.fetch` decision and an `evaluateResolved` pass on the addresses used, in addition to the Grain 6 `ImportPolicy`. Without a policy the default offline policy applies, so network-mode imports fail closed; the policy is read only from an own property, so a polluted prototype cannot grant access. Cross-origin CSS references are skipped without contact. Proposals and ledger records do not embed the policy. Parked follow-ups: #94. Process note: #83 was auto-closed at merge by the commit subject "Close #83 ...", before post-merge CI finished; CI then succeeded and the closed state stands. This is recorded on the issue.
- Import-stack removal counts and diagnostics: complete via PR #96 (merge `5ad4fab`), Issue #86 closed. Every forbidden element that does not survive as itself is counted once in the security summary (forms, `<meta>`, and `<link>` elements that do not become stylesheet resources now count in `dangerousElementsRemoved`). `<form>` stays neutralized into a `<div>` that keeps its children. Forms, links, and meta get bounded per-class diagnostics (`form-element-neutralized`, `forbidden-element-removed`). Review delta 1 also strips the form-authority attributes (`form`, `formmethod`, `formtarget`, `formenctype`, `formnovalidate`, plus `action`/`formaction`) on import, rejects them in proposal validation, and makes the `<link>` attribute lookup prototype-safe. Qualification ran in a cloud session without Jev or pstack: CI, OCR (rule groups applied by the host agent, re-resolved locally with the pinned 1.12.9), and a fresh-context judge panel ran; no Jev cells exist for this PR. Parked follow-ups: #94.
- P06 product hardening: all 11 gates are `CLOSED_CANONICAL` (umbrella #100). Each grain's PR head carries successful OCR delegation (`delegate-review`), Jev Exact-Head Qualification, and Foundation checks runs, and each merge commit's post-merge Foundation checks succeeded; ps-review panel results are recorded on each grain's issue and PR.

| # | Gate | Grains (issue → PR, merge, post-merge CI) | Evidence |
|---:|---|---|---|
| 1 | Deterministic document serialization | G1a #101 → #102 `5139458` (433/433); G1b #103 → #104 `e3074ac` (435/435) | issues #101, #103 |
| 2 | Undo/redo property tests | G2 #105 → #106 `dc40e9c` (438/438) | issue #105 |
| 3 | Large-canvas performance budgets | G3 #107 → #109 `92505b6` (446/446) | issue #107; renderer budget dispositioned until a renderer exists; #108 |
| 4 | Accessibility checks for editor and generated output | G4 #110 → #111 `f4aafd8` (462/462) | issue #110; editor UI dispositioned until it exists |
| 5 | Sandbox escape tests | G5a #112 → #113 `35c5272` (469/469); G5b #115 → #116 `462bf7a` (483/483); G5c #119 → #120 `15c6158` (541/541); G5d #114 → #122 `b0e16d9` (555/555) | issues and PRs listed |
| 6 | Malicious HTML/CSS/SVG corpus | G6 #117 → #118 `d0cdc7f` (532/532) | `tests/fixtures/malicious/` |
| 7 | Import/export differential tests | G7a #123 → #125 `d45c2bb` (568/568); G7b #126 → #127 `8e509d7` (588/588) | #132 parked |
| 8 | MCP authorization tests | G8 #128 → #129 `b320820` (575/575) | obligations on the future server recorded on #82 |
| 9 | Dependency/SBOM and license scan | G9 #130 → #131 `9160be2` (595/595) | `scripts/sbom.mjs`; #135 parked; project license was `NOASSERTION` until N0-G7a2 declared Apache-2.0 |
| 10 | Crash recovery | G10 #133 → #134 `94d6af7` (606/606) | `docs/evidence/P06_G10_CRASH_RECOVERY_2026-10-07.md` |
| 11 | File migration/version compatibility | G11 #136 → #137 `c73c48e` (615/615) | `docs/evidence/P06_G11_VERSION_COMPATIBILITY_2026-10-07.md` |

- Tooling during P06: CI surfaces Jev, OCR, and test-total evidence as check-run annotations (PR #99, merge `550baae`) and the names of failing tests (T1, PR #124, merge `0acf81c`), so exact-head evidence can be read from check-run annotations.
- P07 Release (umbrella #139): **ACTIVE**. Every required artifact in `docs/MASTER_PLAN.md` is delivered. The release waits on the owner's decisions below, and on the repository grains that two of them unlock.

| # | P07 artifact | State | Evidence |
|---|---|---|---|
| 1 | Windows/macOS/Linux desktop builds where supported | DELIVERED | PC9b #177 (`be0b6a4`) packages them; P07d #187 → #188 (`df894bc`, 726/726) makes them release outputs, built and journey-tested on each platform's runner, attested on a tag. Not yet publisher-signed (prerequisite 3) |
| 2 | Self-hosted/local web mode | DELIVERED | PC7 #167 (`b46cd1c`), `npm start`; its release form is the tagged source (`docs/RELEASE.md`, P07d) |
| 3 | MCP documentation | DELIVERED | #140 → #141 (`9bca91b`, 620/620), `docs/MCP.md` |
| 4 | Migration docs | DELIVERED | #140 → #141 (`9bca91b`), `docs/MIGRATION.md` |
| 5 | Security policy | DELIVERED | #140 → #141 (`9bca91b`), `SECURITY.md`. Private vulnerability reporting is still off (prerequisite 2) |
| 6 | SBOM and attribution bundle | DELIVERED | #144 → #145 (`e702f58`, 630/630), `scripts/release-bundle.mjs`. The project license was `NOASSERTION` until N0-G7a declared Apache-2.0 |
| 7 | Signed release evidence | DELIVERED | #144 → #145 (`e702f58`); P07d (`df894bc`) signs the desktop archives too and makes a draft release. It signs on the first pushed `v*` tag |
| 8 | Reproducible smoke test | DELIVERED | #142 → #143 (`285df27`, 625/625), `npm run smoke` |

  Owner prerequisites before the v1 tag (each needs an owner decision or credential; items 1 and 4 then need a repository grain before the tag):
  1. **License.** Confirm that the Paper authorization permits public distribution and sublicensing of Lilac's Paper-compatible interfaces and behaviour, or say what must be isolated (#148). Then the PC-L2 grain declares Apache-2.0, regenerates the SBOM, bundle and notices, and brings `SECURITY.md`'s supported-versions section up to the release.
  2. **Private vulnerability reporting.** Enable it in the repository's security settings (`SECURITY.md` names it as the preferred channel, with a fallback until then).
  3. **Publisher signing.** An Apple Developer ID with notarization credentials and a Windows code-signing certificate, as Actions secrets (#139).
  4. **LGPL corresponding source.** The archives redistribute Electron's LGPL-2.1 components (FFmpeg as `libffmpeg`, and Blink). Their corresponding source is Electron v44.7.0's own source, with its patches applied to Chromium at the pinned revision (plus Lilac's fuse settings), not plain Chromium. Choose how each release provides it: mirrored with the release, or a written offer. A repository grain then implements the choice in the release workflow and the notices.
  5. **The tag.** Pushing `v1.0.0` is the release decision; the workflow then signs every file and makes a draft release, which the owner publishes.
- Founder decisions (2026-10-07, recorded on #146):
  - **Scope.** Lilac ships as a usable product. Desktop builds and local web mode are required, so the PC Product Completion phase was added before P07 closes.
  - **License.** The target is Apache-2.0, applied only after an evidence-based compatibility audit.
  - **Vulnerability reporting.** Enabling GitHub private vulnerability reporting is a required repository-administration action before release.
  - **Tag.** No v1 tag until the product is usable and every release gate is green.
- PC Product Completion: **CLOSED_CANONICAL** (umbrella #146, closed 2026-10-08 on main `8b5a74f`, post-merge 721/721 and the release-candidate journey 18/18 on Linux x64, macOS arm64 and Windows x64). Its 17 acceptance gates are in `docs/MASTER_PLAN.md`; the grain plan is below.

| # | PC gate | State |
|---:|---|---|
| 1 | Editor application shell | CLOSED_CANONICAL |
| 2 | Canvas and rendering surface | CLOSED_CANONICAL |
| 3 | Document interaction and editing | CLOSED_CANONICAL |
| 4 | Persistence and reopen workflow | CLOSED_CANONICAL |
| 5 | Desktop bridge | CLOSED_CANONICAL |
| 6 | Local web mode | CLOSED_CANONICAL |
| 7 | MCP server and authorization integration | CLOSED_CANONICAL |
| 8 | MCP and agent mutations visible live on the canvas | CLOSED_CANONICAL |
| 9 | Mutation attribution, history and undo/redo through the real UI | CLOSED_CANONICAL |
| 10 | Import → edit → save → reopen through the UI | CLOSED_CANONICAL |
| 11 | Design/code workflow through the product | CLOSED_CANONICAL |
| 12 | Accessibility qualification | CLOSED_CANONICAL |
| 13 | Large-document canvas and render performance qualification | CLOSED_CANONICAL |
| 14 | Crash and recovery behaviour through the actual app surface | CLOSED_CANONICAL |
| 15 | Supported desktop packaging | CLOSED_CANONICAL |
| 16 | Offline/local-first smoke flow through the product surface | CLOSED_CANONICAL |
| 17 | A release-candidate end-to-end test | CLOSED_CANONICAL |

  Closed PC gates, by grain. Each PR head carried successful OCR delegation, Jev Exact-Head Qualification and Foundation checks, and each merge's post-merge Foundation checks succeeded:
  - PC1 #151 (`53c452f`), PC2 #153 (`3066033`), PC3 #156 (`9b33cee`), PC4 #158 and #159 (`47e602a`, `25ca79e`): gates 1, 2, 3, 4 and 9.
  - PC5 #161 and #162 (`ea37472`, `c4e834d`): gates 7 and 8 (#82).
  - PC6a #164 (`b03ed74`) and PC6b #165 (`dc67d01`): gates 10 and 11.
  - PC7 #167 (`b46cd1c`): gates 6 and 16.
  - PC8 (#168): PC8a #169 (`5f05fa4`), gate 12; PC8b #170 (`ff08a1f`), gate 13; PC8c #171 (`7123c0e`), gate 14.
  - Evidence for each is in `docs/evidence/` (PC4_*, PC5_*, PC6A_*, PC6B_*, PC7_*, PC8A_*, PC8B_*, PC8C_*).
  - PC9 (#174): PC9a #175 (`7732a1a`), gate 5, the desktop bridge; PC9b #177 (`be0b6a4`), gate 15, desktop packaging for Linux x64, macOS arm64 and Windows x64 with a packaged-app smoke test on each runner. Evidence: `docs/evidence/PC9A_DESKTOP_BRIDGE_2026-10-08.md`, `docs/evidence/PC9B_DESKTOP_PACKAGING_2026-10-08.md`.
  - PC10 (#178): the release-candidate journey through the packaged desktop app on Linux x64, macOS arm64 and Windows x64, gate 17. Since PC11 (#182), "connect a codebase" is a connected local folder: the person brings components in with their source and writes edits back to their files after reviewing a diff. Evidence: `docs/evidence/PC10_RELEASE_JOURNEY_2026-10-08.md`.
  - PC11 (#182, for #181): a connected codebase. PC11a #183 (`a66b67e`) is the host (a folder link, a bounded and confined scan, bring-in with source binding, and a three-way, previewed, atomic write-back). PC11b #184 (`8b5a74f`) is the editor's Codebase section and the journey's steps 4a and 4b. Evidence: `docs/evidence/PC11A_CODEBASE_HOST_2026-10-08.md` and `docs/evidence/PC11B_CODEBASE_EDITOR_2026-10-08.md`.
  - All 17 PC gates are closed, the catalog records each delivered surface, and the "Definition of genuinely complete" journey runs through the packaged app (install from the archive, create and edit, use an agent, connect a codebase, round-trip a component, export and reopen, with no connection off the computer from the browser side, and the loopback-only host PC7 showed makes none either). The phase is closed on #146.

  Grain plan. A grain may advance a gate, but only the grain named as closing it may set it `CLOSED_CANONICAL`, after end-to-end evidence through the product surface:
  1. PC1: studio host, loopback project API and change stream (advances 4)
  2. PC2: renderer and the web-semantic props convention (advances 2)
  3. PC3: canvas interaction, covering viewport, selection and transform (closes 2; advances 3)
  4. PC4: editor shell, with panels, history, attribution, undo/redo and recovery reporting (closes 1, 3, 4, 9)
  5. PC5: MCP server and stdio relay (#82), with live agent edits (closes 7, 8)
  6. PC6: import and design/code workflows in the product (closes 10, 11)
  7. PC7: local web mode and the offline product smoke (closes 6, 16)
  8. PC8: accessibility, performance and crash/recovery qualification (closes 12, 13, 14)
  9. PC9: desktop shell and packaging (closes 5, 15)
  10. PC10: release-candidate end-to-end (closes 17)
  11. PC11: a connected codebase, through the host, the editor and the journey (advances 17)
  12. PC-L: Apache-2.0 license and provenance audit, then adoption (P07 prerequisite)
- Open, non-blocking: #64 (review-panel hardening follow-ups, including a shared hidden-text and input-hygiene policy across packages), #78, #79, #89, #94, #108, #132, #135, #154, #172, #176, #179, #185, #2. Issue #121 ("cirq.quantum") is unrelated to the program.

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
| P06 Product hardening (11 gates) | CLOSED_CANONICAL |
| PC Product completion (17 gates) | CLOSED_CANONICAL |
| P07 Release | ACTIVE |

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
8. P05 D6 - Local/private mode (complete for what exists today: D6a persistence, D6b network policy and offline guarantee; import-stack enforcement #83 complete; local MCP endpoint #82 open);
9. P05 D7 - Website/app intake product experience (D7a review, semantics, commit, and network gate complete; #83 and #86 complete);
10. P06 - Product hardening (complete; all 11 gates closed, #100);
11. PC - Product completion (usable editor, canvas, renderer, MCP server, web mode, desktop);
12. P07 - Release program with signed evidence and clean-machine verification.

## Integrity rule

Never fabricate source availability, donor ownership, build success, parity, review results, CI, Jev/OCR outcomes, or provenance. `PARTIAL_RECOVERY_PROVEN` is not a complete Paper source recovery claim, and behavioral/compatibility ports must not be represented as recovered original source text.
