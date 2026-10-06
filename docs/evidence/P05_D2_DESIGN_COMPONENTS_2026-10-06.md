# P05 D2 - Code components implementation evidence

Date: 2026-10-06

Issue: #54

## Scope

Code components as native design primitives over the D1 IR: repository component binding (including definition-to-output matching in the JSX parser), typed props/slots/states, responsive variants applied only through verified patches, source-linked previews, contract drift detection, safe update behavior that refuses drifted targets, and design-system membership.

Target package:

`packages/design-components` (depends only on the `@lilac/code-ir` workspace)

Plus a bounded forward extension to `packages/code-ir/src/jsx.ts`: exported function and arrow components bind to the root element they render. D1 tests still pass unchanged in count and behavior.

## Authority properties

- Contracts describe and validate; updates flow only through D1 verified range-anchored patches.
- Drift never auto-heals; it blocks updates and reports every drift class.
- Previews are the live code read back through D1 round-trip machinery with source ranges; never flattened screenshots.
- Contract metadata is data, never commands.

## Determinism

- Identical IR plus contract plus variant applies identically; only targeted props change.
- No clocks or random identifiers in core logic.
- Oversized contracts, systems, and registries fail closed.

## Qualification

Qualification evidence is added to the PR/Issue only after exact-head GitHub CI, Alibaba Open Code Review delegation, and Jev review complete. Cubic, CodeRabbit, and Qodo are not qualification evidence.
