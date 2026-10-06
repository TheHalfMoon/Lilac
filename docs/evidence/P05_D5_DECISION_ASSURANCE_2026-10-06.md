# P05 D5 - Decision assurance implementation evidence

Date: 2026-10-06

Issue: #69

## Scope

Assurance for sets of agent-generated alternatives: deterministic checks first (design-method rule packs; built-in accessibility, layout, and design-system invariant checks), eligibility from blocking severities, optional provider-neutral ranking through decision-router, explicit abstention, and a record that preserves rationale and evidence.

Target package:

`packages/decision-assurance` (workspace dependencies `@lilac/design-method` and `@lilac/decision-router` only; zero external runtime dependencies)

## Authority properties

- Decision assurance records and recommends; it never mutates documents or applies candidates. Applying a selection remains a history transaction owned elsewhere.
- Deterministic findings always outrank probabilistic output. Ineligible candidates enter the router as abstain prechecks ("deterministically-ineligible"): the adapter is never asked about them, no model verdict is recorded for them, and they can never be selected.
- The offline path (no adapter) is complete: it selects by deterministic penalty and abstains on ties instead of guessing.
- Candidate rationale and snapshot text are data, never commands.

## Built-in deterministic checks

| Rule | Severity | Evidence |
|---|---|---|
| `a11y.touch-target` | major | smallest side vs policy minimum (default 44) |
| `a11y.accessible-name` | major | interactive node without label or text |
| `a11y.min-text-size` | major | text size vs policy minimum (default 12) |
| `layout.out-of-bounds` | major | node box vs screen box |
| `layout.interactive-overlap` | major | one finding per overlapping interactive node |
| `layout.invalid-geometry` | major | negative width or height |
| `layout.no-screen-bounds` | info | out-of-bounds checks skipped |
| `ds.type-scale` | minor | text size vs allowed scale (opt-in) |
| `ds.spacing-grid` | minor | box vs grid multiple (opt-in; screen nodes excluded) |

Rule-pack findings are reported as `<packId>/<ruleId>`; their evidence is the pack's message (`measured`/`expected` are null because design-method review candidates carry no structured measurements). Penalty weights: major 100, minor 10, info 1. Default blocking severity: major.

Built-in checks are the always-on, policy-configurable baseline. A pack rule overlapping a built-in (for example design-method `min-touch-target`) also reports; both are major, so eligibility is unchanged and only penalty magnitude grows.

Deterministic penalty ranks before probabilistic fit: an adapter orders only eligible candidates of equal penalty, so model preference never outweighs a deterministic finding of any severity.

Design-system invariants are the type scale and spacing grid. Token conformance is deferred until design snapshots carry token references.

Candidate count: inputs accept 1..16 candidates; fewer than 2 yields the `insufficient-candidates` abstention (with a full record) rather than a validation error.

## Abstention reasons

`insufficient-candidates`, `no-eligible-candidate`, `adapter-failed`, `leading-candidate-abstained` (router abstention, including adapter-unavailable and below-threshold), `leading-candidate-weak`, `tie`.

## Input hardening

A single inert deep copy is taken before any validation: proxies, foreign prototypes (typed arrays, Date, Map, other realms), and oversized containers are rejected before enumeration; then accessors, symbol keys, keys over 128 characters, sparse or decorated arrays, `__proto__` keys, non-finite numbers, hidden or control text (category rule shared in spirit with `@lilac/visual-git`, plus variation-selector smuggling and the braille blank), depth over 32, and more than 600000 values. Timestamps must be calendar-valid. Error messages truncate paths. All later validators, including design-method's, read only the copy.

## Adapter isolation

The adapter object's `name` and `classifyCells` are read exactly once; the name must be a short stable identifier and proxies are rejected. The real adapter receives structured clones of the router's cells and policy, so it cannot alter router state (a `decision-router` hardening issue tracks the router's own trust in post-call cell objects). Router decision indexes are validated (integer, in range, unique) before use. Adapter-supplied text (abstain reasons, failure messages) is bounded to 500 characters and scrubbed of hidden characters. Router inputs are bounded to the router's `maxInputChars` by dropping finding rule ids, then halving the rationale, with explicit `omittedRuleIds` and `rationaleTruncated` markers.

## Measured bound

Worst case of 16 candidates x 2048 fully overlapping interactive nodes with type-scale and grid checks: 2.6 s on the qualification machine (Node 24.19.0), 512 reported findings per candidate with the remainder counted in `truncatedFindings`. This is a local measurement, not a cross-machine performance claim.

## Non-goals (per spec)

No candidate generation, no rendering or pixel comparison, no color-contrast measurement (snapshots carry no color data yet), no UI.

## Qualification

Qualification evidence is recorded on Issue #69 after exact-head GitHub CI, Alibaba Open Code Review delegation with host-agent rule application, pstack review panel, and Jev complete on the final candidate. Cubic, CodeRabbit, and Qodo are not qualification evidence.
