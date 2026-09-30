# Lilac Capability / Parity Matrix

Baseline date: 2026-09-30.

This matrix distinguishes **shipped Paper capabilities**, **Paper roadmap capabilities**, and **Lilac-native requirements**. Public references are used only to shape the initial map; exact donor-source behavior must be verified after source intake.

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
| Canvas | Infinite/large design canvas, pan/zoom | shipped | preserve/improve | NOT TESTED |
| Canvas | selection, resize, move, grouping, clipping | shipped | preserve | NOT TESTED |
| Layout | real CSS-oriented layout semantics | shipped/core positioning | preserve | NOT TESTED |
| Layout | constraints during parent resize | shipped | preserve | NOT TESTED |
| Typography | local fonts + OpenType features | shipped | preserve | NOT TESTED |
| Visual effects | filters/backdrop filters | shipped | preserve | NOT TESTED |
| Shaders | editable/runtime shader effects | shipped/public package | preserve as optional module | NOT TESTED |
| Code export | React + CSS | shipped | preserve, then round-trip | NOT TESTED |
| Code export | Tailwind | shipped | preserve, then native Tailwind sync | NOT TESTED |
| Image export | PNG/image export | shipped | preserve | NOT TESTED |
| Web intake | Snapshot extension → editable layers | shipped | replace/extend with importer framework | NOT TESTED |
| MCP | local agent read/write | shipped | preserve with stronger policy/transactions | NOT TESTED |
| Agent setup | in-app harness connection | shipped | preserve | NOT TESTED |
| Data | live data through agents/MCP | shipped | preserve | NOT TESTED |
| Desktop | desktop editor + local MCP | shipped | preserve/rebrand | NOT TESTED |
| Tokens | CSS-variable-oriented design tokens | shipped | preserve/extend | NOT TESTED |
| Performance | large-file pan/zoom/memory optimization | shipped work | establish Lilac budgets | NOT TESTED |

## Paper roadmap/reference items

These are design references, not automatic parity gates unless present in the authorized donor source.

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

No row may be marked proven from marketing/docs alone.
