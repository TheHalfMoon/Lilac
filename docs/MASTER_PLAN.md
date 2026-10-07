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

### PC — Product completion

Goal: turn the P03–P06 core into a usable Lilac product before the P07 release closes. This phase reuses the existing packages and composes them. It is not an architectural restart. Founder decision, 2026-10-07: desktop builds and local web mode are required, not dispositioned. The first v1 tag waits for this phase and for every P07 gate.

Foundations it must reuse, and must not rebuild:
- `document-model`, `history`;
- `persistence`;
- `collaboration` (attribution, access oracle, presence);
- `agent-runtime`, `agent-events`, `agent-workspace`;
- `mcp-protocol` (classification and `requireMCPToolCall`);
- `network-policy` (local-only decisions);
- `import-stack` and `intake`;
- `code-ir`, `design-components`;
- `design-assurance` (`auditAccessibility`);
- `visual-git`;
- `scripts/smoke.mjs`, `scripts/release-bundle.mjs`.

Shape:
- **Studio host.** One Node studio host composes those packages. It serves a loopback-only HTTP API (127.0.0.1, a per-launch token, Host and Origin checks, a network-policy local-only decision) and a change stream.
- **Web editor.** Built from the host's static modules and the canvas/renderer packages.
- **Same host everywhere.** Local web mode runs the host directly. The desktop app is a thin, context-isolated shell around the same host. The MCP server runs inside the host, so the persistence single-writer lock is respected, and a stdio relay is provided for MCP clients.
- **Renderer.** It emits web semantics into a sandboxed frame, with a stable node→DOM identity and no renderer-only document state.
- **Edits.** Every edit, whether from a person or an agent, is a history transaction committed through the project store, with collaboration attribution.

New third-party dependencies need an allowlisted license and an entry in `THIRD_PARTY_NOTICES.md`. They are added only where a grain shows they are needed. Browser end-to-end tests use `playwright-core` (Apache-2.0, no dependencies), driving the Chromium already present on CI runners.

Acceptance gates. Each needs real implementation and end-to-end evidence through the product surface:
1. Editor application shell: open or create a project; layers, inspector and history panels; keyboard operable.
2. Canvas and rendering surface: pan, zoom, selection, hit testing, and incremental re-render from `affectedNodeIds`.
3. Document interaction and editing: insert, move, resize, restyle, text edit and delete, all as history transactions.
4. Persistence and reopen workflow, including stale-lock and recovery reporting in the UI.
5. Desktop bridge: a context-isolated shell with a minimal preload and denied navigation and permissions.
6. Local web mode: one command serves the editor locally with no network access beyond loopback.
7. MCP server and authorization integration (#82): stdio relay and loopback HTTP, every call through `requireMCPToolCall`, and the confirmation flow for consequential tools. This discharges the server obligations P06 G8 recorded on #82.
8. MCP and agent mutations visible live on the canvas.
9. Mutation attribution, history and undo/redo through the real UI.
10. Import → edit → save → reopen through the UI.
11. Design/code workflow through the product: export JSX through `code-ir`, and bring code into the design.
12. Accessibility qualification of the editor UI and its generated output: `auditAccessibility` finds nothing in the editor chrome or in exported output, every editor action is keyboard operable, and the rest is judged against WCAG 2.2 AA. This closes P06 G4's editor-UI disposition.
13. Large-document canvas and render performance qualification, including the architecture's 10,000-node edit/render benchmark. In headless Chromium on CI, the first render of a 10,000-node document takes at most 2 s, and a single-node edit is re-rendered within 100 ms at p95. This closes the renderer budget P06 G3 deferred (#108).
14. Crash and recovery behaviour through the actual app surface.
15. Supported desktop packaging (Windows, macOS and Linux where supported) with a smoke test of the packaged app. Supported means Linux x64, macOS arm64 and Windows x64, each built on its GitHub-hosted runner. Code signing and notarization need owner-provided certificates and are recorded separately.
16. Offline/local-first smoke flow through the product surface.
17. A release-candidate end-to-end test covering the whole user journey.

Exit: every gate `CLOSED_CANONICAL` with exact-head evidence, the catalog updated for each surface delivered, and the "Definition of genuinely complete" journey demonstrated through the product.

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
