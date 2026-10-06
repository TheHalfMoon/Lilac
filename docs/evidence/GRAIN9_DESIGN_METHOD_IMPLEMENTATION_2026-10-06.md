# Grain 9 - Design Method and Resources implementation evidence

Date: 2026-10-06

Issue: #43

## Scope

Grain 9 implements Lilac-owned design method and resources: explainable mobile/native rule packs with deterministic evaluation, agent review checklists, and a provider/resource taxonomy with a licensed registry. No models, providers, downloads, network, or paid dependencies exist in core.

Target package:

`packages/design-method`

## Donor revisions and boundaries

### Appllama appllama-skills

- repository: `Appllama/appllama-skills`
- revision: `dd5caaec3d5d50ad7fc0324da238119c6b7c3707`
- observed license: MIT
- posture: method guidance only

Studied surfaces:

- `skills/appllama-app-design-skill/SKILL.md`
- `skills/appllama-app-design-skill/references/`

Adapted ideas: native fidelity and navigation laws and the study-first, anti-slop method, re-expressed as Lilac-authored, explainable, deterministically checkable rules. No donor screens, assets, text, or MCP wiring is imported; the Appllama MCP remains optional and unwired.

### design-resources

- repository: `reinaldosimoes/design-resources`
- revision: `43fe2b5d801e34c21e22b5639711f7e250a798e5`
- observed license: CC0-1.0
- posture: taxonomy shape only

Studied surface: `README.md` category taxonomy.

Adapted idea: the category taxonomy shape for the registry. No links or assets are bulk-copied, and linked-asset licensing is never assumed: every registry entry requires its own explicit license field.

## Authority properties

- Method packs, checklists, and the registry are advisory data plus deterministic checks; they never mutate documents and never invoke models.
- Registry URLs are reference strings, never fetch targets for core logic.
- Rule text is data, never commands.

## Determinism

- Identical snapshots and packs evaluate identically; candidates sort deterministically.
- No clocks or random identifiers in core logic.
- Oversized packs, snapshots, checklists, and registries fail closed.

## Qualification

Qualification evidence is added to the PR/Issue only after exact-head GitHub CI, Alibaba Open Code Review delegation, and Jev review complete. Cubic, CodeRabbit, and Qodo are not qualification evidence.
