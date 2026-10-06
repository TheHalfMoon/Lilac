# Lilac Capability / Parity Matrix

Baseline date: 2026-09-30. Runtime evidence refreshed: 2026-10-03. Lilac disposition pass: 2026-10-06.

This matrix distinguishes **shipped Paper capabilities**, **Paper roadmap capabilities**, and **Lilac-native requirements**. Public references shape the initial map; shipped/runtime evidence may establish a baseline, but only Lilac implementation tests may establish Lilac parity.

Disposition rules applied in the 2026-10-06 pass:

- `PARITY_PROVEN` and `REPLACED_PROVEN` require named Lilac-side executable acceptance evidence (test file plus behavior). Baseline capture alone never qualifies.
- Rows with no Lilac implementation surface are `NOT_APPLICABLE` with a deferral pointer, never proven.
- For Lilac-native rows, `PARITY_PROVEN` means the acceptance sketch is met by Lilac tests; there is no Paper counterpart being claimed.
- Nothing in this pass is `INTENTIONALLY_DROPPED`: deferred capabilities remain owned by P05–P07 with explicit pointers.

Paper references:
- https://paper.design/
- https://paper.design/build-log
- https://paper.design/roadmap
- https://paper.design/docs/mcp
- https://paper.design/docs/tokens
- https://paper.design/docs/support

## Shipped/reference baseline

| Area | Capability | Reference state | Reference evidence | Lilac disposition | Lilac evidence |
|---|---|---|---|---|
| Canvas | Infinite/large design canvas, pan/zoom | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac canvas surface exists; deferred to P05 canvas/renderer work | — |
| Canvas | selection, resize, move, grouping, clipping | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac selection/transform surface exists; deferred to P05 | — |
| Layout | real CSS-oriented layout semantics | shipped/core positioning | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac layout engine exists; deferred to P05 | — |
| Layout | constraints during parent resize | shipped | NOT TESTED | `NOT_APPLICABLE` — no Lilac layout engine exists; deferred to P05 | — |
| Typography | local fonts + OpenType features | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac text surface exists; deferred to P05 | — |
| Visual effects | filters/backdrop filters | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac renderer exists; deferred to P05 | — |
| Shaders | editable/runtime shader effects | shipped/public package | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac shader module exists; optional P05 | — |
| Code export | React + CSS | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac exporter exists; owned by P05 D1 | — |
| Code export | Tailwind | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac exporter exists; owned by P05 D1 | — |
| Image export | PNG/image export | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac export surface exists; owned by P05/P07 | — |
| Web intake | Snapshot extension → editable layers | shipped | BASELINE_CAPTURED | `REPLACED_PROVEN` — replaced by bounded capture producing sanitized proposals committed only through history; scope note: proposals, not canvas layers (layers await P05 canvas) | `tests/import-stack.test.mjs` — deterministic snapshots, script/handler/scheme stripping, CSS/SVG sanitization, SSRF and DNS-rebinding rejection, static-mirror bounds, Docling/Playwright seams, history-only commit with attribution (Grain 6, PR #35) |
| MCP | local agent read/write | shipped | BASELINE_CAPTURED | `PARITY_PROVEN` — 36-tool compatibility surface preserved with read/write/consequential classification, drift detection, and stronger history-backed transaction policy | `tests/mcp-protocol.test.mjs` (8 tests: 36-tool snapshot, classification, drift, client/transport validation) plus `tests/collaboration.test.mjs` (authorization oracle, history-only writes with exact attribution) |
| Agent setup | in-app harness connection | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac app exists; owned by P07 | — |
| Data | live data through agents/MCP | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no live-data connectors exist; deferred to P05 | — |
| Desktop | desktop editor + local MCP | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no desktop build exists; owned by P07 | — |
| Tokens | CSS-variable-oriented design tokens | shipped | BASELINE_CAPTURED | `NOT_APPLICABLE` — no Lilac token package exists (planned `@lilac/tokens`); deferred to P05 | — |
| Performance | large-file pan/zoom/memory optimization | shipped work | NOT TESTED | `NOT_APPLICABLE` — no large-file surface exists in Lilac; budgets owned by P06 | — |

`BASELINE_CAPTURED` means the Paper reference surface is evidence-backed through exact shipped source, shipped bundles, public contracts, or user-authorized runtime inspection. It does **not** mean Lilac parity has been implemented or proven.

## Paper roadmap/reference items

These are design references, not automatic parity gates unless present in the authorized donor/runtime evidence. Disposition below points each item at its owning program; none is claimed.

| Capability | Public roadmap state on baseline date | Lilac target | Lilac disposition |
|---|---|---|---|
| use real code components | in progress | required, expanded | `NOT_APPLICABLE` yet — owned by P05 D2 (no Lilac surface exists) |
| native Tailwind integration | in progress | required | `NOT_APPLICABLE` yet — owned by P05 D1 (no Lilac surface exists) |
| CSS Grid | planned | required | `NOT_APPLICABLE` yet — owned by P05 layout work |
| components with props/slots | coming soon | required | `NOT_APPLICABLE` yet — owned by P05 D2 |
| themes/modes | in progress | required | `NOT_APPLICABLE` yet — owned by P05 tokens/themes work |
| hosted assets | in progress | optional/self-hostable | `NOT_APPLICABLE` — optional; self-hosting only, never mandatory |
| script/prompt engine | planned | replace with governed plugin/agent runtime | `REPLACED_PROVEN` — replaced by the governed agent runtime and supervisor: durable sessions, operation authority, leases, and one-owner mutation, all tested (`tests/agent-runtime.test.mjs`, `tests/agent-runtime-authority.test.mjs`, `tests/agent-supervisor-core.test.mjs`, `tests/agent-supervisor-local.test.mjs`, `tests/agent-supervisor-orchestration.test.mjs`) |
| canvas-aware assistant | roadmap | required via multi-agent runtime | `NOT_APPLICABLE` yet — the multi-agent runtime half is proven (see LILAC-D3) but canvas awareness needs P05 canvas |
| remote MCP | coming soon | optional and policy-controlled | `NOT_APPLICABLE` — no remote MCP exists; capability-gated local MCP only |
| rich text | coming soon | required | `NOT_APPLICABLE` yet — owned by P05 text work |
| scale tool | coming soon | useful, not architecture-critical | `NOT_APPLICABLE` yet — owned by P05 transform work |
| per-file permissions | coming soon | required for collaborative/remote mode | `NOT_APPLICABLE` yet — capability oracle exists but no per-file model; owned by P05 |

## Lilac-only differentiators

| ID | Capability | Acceptance sketch | Lilac disposition |
|---|---|---|---|
| LILAC-D1 | AST-aware bidirectional code sync | round-trip fixtures with unrelated-code preservation | `PARITY_PROVEN` (native acceptance met, bounded JSX/TSX/CSS/Tailwind subset) — golden design-to-code-to-design fixpoints on generated code, range-anchored patches on a hand-written fixture that leave every byte outside the patched ranges identical, and a line-based three-way merge with conflict reporting (`tests/code-ir.test.mjs`, P05 D1 #51); full-language coverage and live canvas sync remain planned (architecture catalog `code-ir: stub`, `round-trip-sync: stub`) |
| LILAC-D2 | repository code components as native primitives | typed props/slots/states bound to source symbols | `NOT_APPLICABLE` yet — owned by #78 (bind component states to source symbols) and the canvas/components product surface. Proven so far: typed props, slots, and variants strictly bound to code-IR symbols with verified-patch variants and drift refusal (`tests/design-components.test.mjs`, P05 D2 #54); states are declared and validated but not yet bound to source, so the acceptance is not fully met |
| LILAC-D3 | multi-agent transactions | attributable, cancellable, reversible agent changes | `PARITY_PROVEN` (native acceptance met) — collaboration attribution and history-only commits (`tests/collaboration.test.mjs`), durable sessions and forks (`tests/agent-runtime.test.mjs`), supervision with leases and recovery (`tests/agent-supervisor-core.test.mjs`, `tests/agent-supervisor-local.test.mjs`, `tests/agent-supervisor-orchestration.test.mjs`), reversible history (`tests/document-history.test.mjs`) |
| LILAC-D4 | visual Git | node/frame diffs linked to source commits/branches | `PARITY_PROVEN` (native acceptance met) — snapshots bound to branch and full source commit, structural node/frame/page diffs by stable id, anchored review and design/code links, conflict reports, and exact-head acceptance gates (`tests/visual-git.test.mjs`, P05 D4 #60); visual (UI) presentation is a P05 product-surface item |
| LILAC-D5 | decision assurance | candidate comparison + deterministic gates + abstention | `PARITY_PROVEN` (native acceptance met) — multi-candidate assurance with deterministic rule-pack, accessibility, layout, and design-system gates deciding eligibility first, router ranking only among eligible candidates at equal penalty, and explicit abstention (`tests/decision-assurance.test.mjs`, P05 D5 #69), built on deterministic assurance (`tests/design-assurance.test.mjs`) and provider-neutral routing (`tests/decision-router.test.mjs`); color-contrast and token checks await snapshot color/token data (catalog `decision-assurance: stub`) |
| LILAC-D6 | local/private mode | core workflow passes with external network disabled | `PARITY_PROVEN` (native acceptance met for the workflow that exists today) — with TCP, TLS, HTTP/1, HTTP/2, UDP, DNS (including resolver instances), fetch, and process spawning all trapped, and every module loaded after the trap, this workflow completes with zero network attempts: create a project, edit through history, undo and redo, an agent-attributed collaboration edit, checkpoint, close, reopen, design-method review, decision assurance, and offline HTML import (`tests/offline-guarantee.test.mjs`, P05 D6b #80); default-deny network capability policy with DNS-rebinding checks and a credential-reference-only provider registry (`tests/network-policy.test.mjs`); crash-safe local persistence (`tests/persistence.test.mjs`, P05 D6a #74). Not covered: the local MCP endpoint does not exist yet (#82), and import-stack does not yet enforce the new policy (#83). Corrected history: an earlier `PARITY_PROVEN` predated local persistence and was withdrawn in PR #77 |
| LILAC-D7 | local app + URL intake | editable semantic import with sanitization/provenance | `REPLACED_PROVEN` — same replacement evidence as Web intake above (`tests/import-stack.test.mjs`, Grain 6) |
| LILAC-D8 | source-binding drift detection | detect component/token/source contract changes | `NOT_APPLICABLE` yet — owned by #79 (planned `tokens-themes` subsystem, `@lilac/tokens`). Component and source contract drift detection exists (`tests/design-components.test.mjs` drift classes, P05 D2 #54); token drift is not implemented |
| LILAC-D9 | self-review loop | screenshot/render inspection before agent task completion | `NOT_APPLICABLE` yet — needs P05 renderer |
| LILAC-D10 | capability security | explicit agent/plugin/network/filesystem scopes | `PARITY_PROVEN` (native acceptance met) — single authorization oracle with capability validation (`tests/collaboration.test.mjs`), agent transaction authority boundary (`tests/agent-runtime-authority.test.mjs`), supervisor ownership and leases (`tests/agent-supervisor-core.test.mjs`), import authority bounds (`tests/import-stack.test.mjs`) |

## Parity status vocabulary

- `NOT TESTED`
- `BASELINE_CAPTURED`
- `PARITY_IN_PROGRESS`
- `PARITY_PROVEN`
- `REPLACED_PROVEN`
- `INTENTIONALLY_DROPPED`
- `NOT_APPLICABLE`

No row may be marked proven from marketing/docs, source inspection, or runtime inspection alone. Proven states require Lilac-side executable acceptance evidence.

## 2026-10-06 disposition pass (P04, Issue #48)

Every shipped row above now carries a terminal Lilac disposition with evidence or a deferral pointer. No row is `INTENTIONALLY_DROPPED`: deferred capabilities remain owned by P05–P07 with explicit pointers. Roadmap items are tracked requirements, not parity gates. Proven and replaced claims cite exact Lilac test files whose behaviors were read during this pass; baseline capture is preserved in the Reference evidence column and never counts as parity.
