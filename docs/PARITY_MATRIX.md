# Lilac Capability / Parity Matrix

Baseline date: 2026-09-30. Runtime evidence refreshed: 2026-10-03.

This matrix distinguishes **shipped Paper capabilities**, **Paper roadmap capabilities**, and **Lilac-native requirements**. Public references shape the initial map; shipped/runtime evidence may establish a baseline, but only Lilac implementation tests may establish Lilac parity.

Paper references:
- https://paper.design/
- https://paper.design/build-log
- https://paper.design/roadmap
- https://paper.design/docs/mcp
- https://paper.design/docs/tokens
- https://paper.design/docs/support

## Shipped/reference baseline

| Area | Capability | Reference state | Lilac disposition | Evidence state |
|---|---|---:|---|---|
| Canvas | Infinite/large design canvas, pan/zoom | shipped | preserve/improve | BASELINE_CAPTURED |
| Canvas | selection, resize, move, grouping, clipping | shipped | preserve | BASELINE_CAPTURED |
| Layout | real CSS-oriented layout semantics | shipped/core positioning | preserve | BASELINE_CAPTURED |
| Layout | constraints during parent resize | shipped | preserve | NOT TESTED |
| Typography | local fonts + OpenType features | shipped | preserve | BASELINE_CAPTURED |
| Visual effects | filters/backdrop filters | shipped | preserve | BASELINE_CAPTURED |
| Shaders | editable/runtime shader effects | shipped/public package | preserve as optional module | BASELINE_CAPTURED |
| Code export | React + CSS | shipped | preserve, then round-trip | BASELINE_CAPTURED |
| Code export | Tailwind | shipped | preserve, then native Tailwind sync | BASELINE_CAPTURED |
| Image export | PNG/image export | shipped | preserve | BASELINE_CAPTURED |
| Web intake | Snapshot extension → editable layers | shipped | replace/extend with importer framework | BASELINE_CAPTURED |
| MCP | local agent read/write | shipped | preserve with stronger policy/transactions | BASELINE_CAPTURED |
| Agent setup | in-app harness connection | shipped | preserve | BASELINE_CAPTURED |
| Data | live data through agents/MCP | shipped | preserve | BASELINE_CAPTURED |
| Desktop | desktop editor + local MCP | shipped | preserve/rebrand | BASELINE_CAPTURED |
| Tokens | CSS-variable-oriented design tokens | shipped | preserve/extend | BASELINE_CAPTURED |
| Performance | large-file pan/zoom/memory optimization | shipped work | establish Lilac budgets | NOT TESTED |

`BASELINE_CAPTURED` means the Paper reference surface is evidence-backed through exact shipped source, shipped bundles, public contracts, or user-authorized runtime inspection. It does **not** mean Lilac parity has been implemented or proven.

## Paper roadmap/reference items

These are design references, not automatic parity gates unless present in the authorized donor/runtime evidence.

| Capability | Public roadmap state on baseline date | Lilac target |
|---|---:|---|
| use real code components | in progress | required, expanded |
| native Tailwind integration | in progress | required |
| CSS Grid | planned | required |
| components with props/slots | coming soon | required |
| themes/modes | in progress | required |
| hosted assets | in progress | optional/self-hostable |
| script/prompt engine | planned | replace with governed plugin/agent runtime |
| canvas-aware assistant | roadmap | required via multi-agent runtime |
| remote MCP | coming soon | optional and policy-controlled |
| rich text | coming soon | required |
| scale tool | coming soon | useful, not architecture-critical |
| per-file permissions | coming soon | required for collaborative/remote mode |

## Lilac-only differentiators

| ID | Capability | Acceptance sketch |
|---|---|---|
| LILAC-D1 | AST-aware bidirectional code sync | round-trip fixtures with unrelated-code preservation |
| LILAC-D2 | repository code components as native primitives | typed props/slots/states bound to source symbols |
| LILAC-D3 | multi-agent transactions | attributable, cancellable, reversible agent changes |
| LILAC-D4 | visual Git | node/frame diffs linked to source commits/branches |
| LILAC-D5 | decision assurance | candidate comparison + deterministic gates + abstention |
| LILAC-D6 | local/private mode | core workflow passes with external network disabled |
| LILAC-D7 | local app + URL intake | editable semantic import with sanitization/provenance |
| LILAC-D8 | source-binding drift detection | detect component/token/source contract changes |
| LILAC-D9 | self-review loop | screenshot/render inspection before agent task completion |
| LILAC-D10 | capability security | explicit agent/plugin/network/filesystem scopes |

## Parity status vocabulary

- `NOT TESTED`
- `BASELINE_CAPTURED`
- `PARITY_IN_PROGRESS`
- `PARITY_PROVEN`
- `REPLACED_PROVEN`
- `INTENTIONALLY_DROPPED`
- `NOT_APPLICABLE`

No row may be marked proven from marketing/docs, source inspection, or runtime inspection alone. Proven states require Lilac-side executable acceptance evidence.
