# Lilac Master Plan

## Mission

Lilac is an AI-native, web-semantic design environment where humans, software agents, production code, and design systems operate on one shared model. Paper.design is an authorized foundation/donor, but Lilac must become an independently branded product with a stronger architecture for round-trip code synchronization, local/private operation, multi-agent work, visual review, and deterministic export.

## Non-negotiable principles

1. **Evidence before claims.** Every imported donor snapshot, build, test, parity claim, and release must bind to an exact revision and reproducible evidence.
2. **Preserve donor provenance.** Authorized use does not erase third-party notices, dependency licenses, or attribution requirements.
3. **Independent identity.** Remove Paper names, marks, endpoints, IDs, telemetry, service assumptions, and visual branding from the shipped Lilac product unless explicitly required for attribution.
4. **Web semantics first.** HTML/CSS concepts are the canonical bridge between canvas and production code.
5. **Round-trip safety.** Import/export is not enough. Lilac must preserve intent when code becomes design and design becomes code again.
6. **Local/private first.** Core creation, agent control, source inspection, and project persistence must work without a paid cloud dependency.
7. **Agents are collaborators, not hidden automation.** Agent mutations are attributable, reviewable, cancellable, and reversible.
8. **No destructive source normalization.** The first authorized-source intake is an immutable snapshot; transformation happens in later commits.

## Program structure

### P00 — Foundation and source intake

Goal: establish a truthful, auditable baseline.

Deliverables:
- repository bootstrap;
- donor and rights ledger;
- source import script with SHA-256 manifest;
- source intake runbook;
- baseline CI;
- exact upstream source snapshot when supplied.

Exit criteria:
- imported source revision is identifiable;
- manifest is deterministic;
- third-party license inventory has started;
- no branding or behavior changes are mixed into source intake.

### P01 — Upstream reproduction

Goal: make the authorized Paper snapshot build and run unchanged in a clean environment.

Work:
- identify runtime/toolchain versions;
- lock package manager and workspace topology;
- reproduce web/editor/desktop/MCP builds that exist in the donor snapshot;
- capture test inventory and baseline failures;
- map network dependencies, hosted services, auth, storage, analytics, and feature flags.

Exit criteria:
- clean checkout → documented build succeeds;
- baseline tests have an evidence record;
- runtime topology is documented;
- every external service is classified as required, optional, replaceable, or removable.

### P02 — Lilac identity and dependency isolation

Goal: convert the donor snapshot into an independently branded, self-owned product without changing core behavior.

Work:
- rename product/package/application identifiers;
- replace visual assets and user-facing Paper references;
- remove donor telemetry and proprietary service coupling unless specifically authorized and intentionally retained;
- introduce Lilac configuration and environment namespaces;
- preserve required legal notices and provenance records.

Exit criteria:
- no unintended Paper brand identifiers ship in binaries/UI/network calls;
- all application IDs and update channels are Lilac-owned;
- baseline behavior remains equivalent.

### P03 — Architecture extraction and hardening

Goal: turn inherited implementation into explicit Lilac subsystem boundaries.

Target boundaries:
- document model;
- canvas and viewport;
- selection/transform/snapping;
- layout and CSS semantics;
- text/vector/image/media;
- components/variants/slots;
- tokens/themes;
- renderer;
- persistence;
- history/undo;
- collaboration/presence;
- importers/exporters;
- code IR and round-trip synchronization;
- agent runtime + MCP;
- desktop bridge;
- security/sandboxing;
- plugin surface.

Exit criteria:
- subsystem ownership documented;
- cross-boundary APIs are typed and testable;
- high-risk implicit coupling has migration tasks.

### P04 — Paper capability parity

Goal: preserve the useful shipped capabilities of the donor baseline while intentionally rejecting dead or service-bound assumptions.

Use `docs/PARITY_MATRIX.md` as the canonical capability ledger. Each row must end in one of:
- PARITY_PROVEN;
- REPLACED_PROVEN;
- INTENTIONALLY_DROPPED with rationale;
- NOT_APPLICABLE.

Roadmap-only Paper features are references, not automatic parity requirements.

### P05 — Lilac differentiators

Goal: make Lilac materially stronger than a rebrand.

#### D1. Bidirectional code/design engine

- source adapters for React/JSX/TSX and CSS/Tailwind first;
- stable intermediate representation (IR);
- AST-aware patches instead of full-file regeneration;
- provenance from rendered element → source symbol → commit;
- conflict detection and three-way reconciliation;
- round-trip golden tests.

#### D2. Code components as native design primitives

- bind real repository components;
- typed props and slots;
- interactive states;
- responsive variants;
- source-linked previews;
- component contract drift detection.

#### D3. Multi-agent workspace

Roles can include:
- product designer;
- UX critic;
- accessibility reviewer;
- design-system guardian;
- frontend implementer;
- content/copy reviewer;
- visual-regression reviewer.

Every mutation includes actor, intent, tool, timestamp, affected nodes, and reversible transaction ID.

#### D4. Visual Git

- design snapshots mapped to source commits;
- visual diff at node/frame/page level;
- review comments anchored to stable node IDs;
- branch-aware design states;
- merge conflict visualization;
- PR-style acceptance gates.

#### D5. Decision assurance layer

For non-trivial agent-generated alternatives:
- generate multiple candidates;
- score deterministic constraints first;
- run accessibility and layout checks;
- compare against design-system invariants;
- preserve rationale/evidence;
- allow abstention when confidence is insufficient.

#### D6. Local/private mode

- local project persistence;
- local MCP endpoint;
- no mandatory hosted inference;
- bring-your-own model/provider adapters;
- offline editing;
- explicit network capability policy.

#### D7. Website/app intake

- URL/DOM import as editable web-semantic nodes;
- local app intake through browser instrumentation;
- asset capture with provenance;
- script stripping and sandboxing;
- source mapping when importing a repository-backed app.

### P06 — Product hardening

Quality gates:
- deterministic document serialization;
- undo/redo property tests;
- large-canvas performance budgets;
- accessibility checks for editor and generated output;
- sandbox escape tests;
- malicious HTML/CSS/SVG corpus;
- import/export differential tests;
- MCP authorization tests;
- dependency/SBOM and license scan;
- crash recovery;
- file migration/version compatibility.

### P07 — Release

Required artifacts:
- Windows/macOS/Linux desktop builds where supported;
- self-hosted/local web mode;
- MCP documentation;
- migration docs;
- security policy;
- SBOM and attribution bundle;
- signed release evidence;
- reproducible smoke test.

## Definition of genuinely complete

Lilac is not complete merely because the UI launches. Completion requires:

1. the authorized donor baseline is traceable;
2. the shipped product has independent identity;
3. required parity rows are proven or intentionally dispositioned;
4. differentiators D1–D7 have acceptance evidence;
5. security, accessibility, performance, persistence, recovery, and license gates pass;
6. a fresh user can install, create/edit, use an agent, connect a codebase, round-trip a component, and export without hidden paid infrastructure.
