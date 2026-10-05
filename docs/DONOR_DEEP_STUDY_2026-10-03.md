# Lilac Donor Deep Study — 2026-10-03

## Purpose

This study replaces broad donor enthusiasm with bounded engineering decisions. It evaluates each authorized source for architecture fit, runtime footprint, maintainability, licensing/provenance risk, local-first compatibility, and overlap with Lilac's existing `document-model`, `history`, and `mcp-protocol` authority.

The decision vocabulary is:

- **INTEGRATE** — consume a bounded upstream component or interface directly, preserving notices and pinning an exact revision.
- **PORT** — reimplement proven semantics in Lilac-native code while preserving provenance and behavioral tests.
- **ADAPT** — use selected algorithms, state machines, schemas, or workflows behind a Lilac-owned interface.
- **OPTIONAL ADAPTER** — support the donor as an opt-in external capability; core Lilac must work without it.
- **REFERENCE ONLY** — use architecture and observable behavior to guide an independent implementation; do not import public-license code into Lilac core.
- **REJECT FROM CORE** — useful project, but its product/runtime surface should not become a Lilac dependency.

## Canonical constraints

1. Lilac's typed document graph and reversible transaction/history layer remain the only canvas mutation authority.
2. Core creation, editing, persistence, design checks, and local agents cannot require a paid cloud service.
3. Deterministic checks precede probabilistic/model judgment.
4. Donor branding, telemetry, billing, hosted-service assumptions, credentials, and unrelated product UX are not imported.
5. Every copied subset must pin a revision, preserve applicable license/NOTICE text, record a file manifest, and pass independent tests/review.
6. Owner authorization is recorded separately. Public license obligations and third-party contributor rights are still preserved; an owner statement is not treated as a blanket waiver of rights held by unrelated contributors.

## Final decision matrix

| Source | Studied revision | Public license observed | Final posture | What Lilac should take |
|---|---|---|---|---|
| `pbakaus/impeccable` | `e103efe779e2dd01274dabae83531fef00bf2563` | Apache-2.0 | **INTEGRATE + ADAPT** | deterministic design engine, Rust/WASM browser/static/source checks, rule-pack architecture, visual/comp verification seams |
| `unreallabsai/unreal-agent` | `1b9f778453f411c029b39b85102aaefb95e7e48d` | MIT | **PORT** | versioned durable sessions, idempotent inputs, append-only history, operation lifecycle, recovery/fork semantics, pure tool translation boundary |
| `kunchenguid/firstmate` | `1f3e769616fdf9f31f85f4c3e6a9f71606634238` | MIT | **PORT + ADAPT** | supervisor state machine, worktree isolation, event-driven wake queue, liveness/wedge detection, restart reconciliation, backend abstraction |
| `bytedance/UI-TARS-desktop` | `2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a` | Apache-2.0 | **ADAPT + OPTIONAL ADAPTER** | typed agent event stream, handler registry, stream adapters, DOM/visual/hybrid operator interface, event inspector |
| `docling-project/docling` | `0cd61e0050a9ef68e5e10495b87e41d31acd79c9` | MIT | **OPTIONAL LOCAL ADAPTER** | structured PDF/document conversion, layout/tables/reading order/OCR via lossless adapter into Lilac import IR |
| `kunchenguid/no-mistakes` | `0616eb4911845e2ba04faa17186ecd2686d7d579` | MIT | **ADAPT FOR DEVELOPMENT** | finding schema, guarded gate state machine, exact-head repair proof, isolated worktree validation, rerun-after-fix discipline |
| `mrmps/classifier-dev` / classifier.dev | `a17bf2b6353f6234af6e977a463da7cd1975b68e` | MIT | **ADAPT + OPTIONAL PROVIDER** | dimension schema, confidence/per-label score contract, batching/limits, uncertainty routing; hosted service optional only |
| `Appllama/appllama-skills` | `dd5caaec3d5d50ad7fc0324da238119c6b7c3707` | MIT | **ADAPT AS RULES/METHOD** | mobile/native UX heuristics, navigation grammar, anti-slop rules, motion/performance review; paid MCP never required |
| `AhmadIbrahiim/Website-downloader` | `130ad63d7163c19df64322556ca9c260eef353be` | MIT | **ADAPT SMALL FALLBACK** | per-job isolation, quota/timeout/cancel, safe cleanup, shell-free `wget` invocation; not the primary importer |
| `reinaldosimoes/design-resources` | `43fe2b5d801e34c21e22b5639711f7e250a798e5` | CC0-1.0 | **ADAPT DATA ONLY** | curated resource taxonomy/provider registry; never infer that linked external assets inherit CC0 |
| `kgoedecke/doop` | `d99c8b157d5afd4192b356f89a2b19adc28c75a5` | AGPL-3.0-only | **REFERENCE ONLY BY DEFAULT** | multiplayer/presence/comments/activity/MCP agent UX and local-first collaboration behavior as a clean-room behavioral specification |
| `firecrawl/firecrawl` | `4244638a7041bae8b99bdd42e3c44520f9e62da1` | AGPL-3.0 | **REFERENCE + OPTIONAL CONNECTOR** | capture engine selection/fallback, isolated Playwright service patterns, crawl/action job semantics; no queue/proxy/cloud platform in core |
| `caio0452/jev_search` | `ea073f6db48f5bff73ae4b9f2240d2d302fb9dc1` | no root license observed | **REFERENCE ONLY** | criteria grammar, two-phase candidate prioritization, chunking/progressive result ideas; reimplement and test independently |

## 1. Impeccable — highest-value direct design donor

Impeccable is not merely an agent prompt pack. Its core is an Apache-2.0 Rust workspace with a deterministic engine and a stable contract. The workspace separates foundation types, rule logic, text scanning, static HTML, browser/CDP scanning, live mode, visual comparison, WASM exports, and deterministic bundling.

The strongest fit is its rule-pack architecture. Built-in checks run across source text, static HTML, and browser DOM; downstream rule packs can add text, element, page, and static-document checks without shadowing built-ins. The same logic can run natively or through WASM. This matches Lilac D5 directly: deterministic constraints first, AI judgment second.

### Bring

- a pinned integration with the detector engine rather than the many harness-specific generated skill copies;
- source/static HTML/browser-DOM check interfaces;
- WASM/browser bundle path for in-canvas auditing;
- namespaced Lilac rule packs for document graph, tokens, accessibility, responsiveness, source-binding, and component invariants;
- visual/comp verification primitives where they outperform Lilac's future native implementation;
- oracle-style compatibility tests for observable detector behavior.

### Do not bring

- every provider/harness skill directory;
- Impeccable product branding or installer UX;
- stylistic commands as product authority;
- rules that conflict with an explicit Lilac/project design system without an override mechanism.

## 2. Unreal Agent — canonical semantics for durable agent sessions

The Go harness cleanly separates persisted session history, tool translation, operations, context building, and execution. The session store uses ordered append-only items (`fork`, `input`, `turn`, `model_response`, `tool_call_status`), exposes replay/resume state, and records operation snapshots with tool-call status. Durable operations are versioned and have explicit states including ready, awaiting, canceling, completed, failed, and canceled.

### Bring by porting to Lilac-native TypeScript

- versioned event/session records;
- caller-supplied idempotency keys and deterministic duplicate handling;
- append-only sequence history with replay-derived current state;
- fork records that preserve immutable parent history;
- versioned serializable operation envelopes;
- explicit operation state-transition validation;
- atomic tool-call-status + operation submission;
- pure synchronous tool-call translation that performs no hidden I/O;
- recovery of unfinished operations and terminal states missing from conversation history.

### Lilac-specific extensions

Every document-affecting operation must also carry `actorId`, intent, capability, affected node/source identities, and a Lilac transaction ID. Agent sessions may request mutations; only `document-model` + `history` commit them.

## 3. Firstmate — supervision layer, not the session kernel

Firstmate's strongest contribution is operational supervision rather than its shell distribution. It separates endpoint liveness from useful queue-consumption liveness, uses event-driven wakes instead of continuous model polling, stores durable wake/recovery state, isolates workers in worktrees, and is deliberately conservative about declaring an agent dead because a false-dead verdict can create duplicate workers against the same worktree.

### Bring after Unreal-style kernel exists

- supervisor lifecycle states;
- worker leases and one-worker-per-worktree ownership;
- event-driven wake queue;
- declared waits/holds vs genuine wedge classification;
- bounded stale escalation;
- restart reconciliation from durable state;
- backend adapter contract for local process/worktree first, with terminal/remote backends optional later.

### Do not bring initially

- nautical vocabulary/UI;
- social Relay integrations;
- secondmate/SSH distribution;
- tmux/Herdr/Zellij/cmux/Orca-specific UI assumptions;
- large shell-script control plane as Lilac's internal runtime.

## 4. UI-TARS / Agent TARS — event protocol and optional operator

The useful core is the typed event-stream model. Events cover user/assistant messages, streaming content, streaming tool-call deltas, tool invocation/results, run lifecycle, environment inputs, plans, and final answers. Events have IDs/timestamps and support real-time streaming plus stored processing. Its UI uses a handler registry and isolates handler failures so one processor does not destroy the stream.

### Bring

- Lilac-owned typed event union inspired by this taxonomy;
- message correlation IDs for streaming/final states;
- tool-call delta events for large arguments;
- environment-input events for screenshots/codebase/viewport context without pretending they are user messages;
- event handler registry and event inspector/debug view;
- operator interface supporting DOM-first, visual-first, and hybrid actions.

### Keep optional

The actual UI-TARS model, remote computer/browser operators, and heavy multimodal runtime. Lilac's local core must not require a specific GUI model or remote service.

## 5. Docling — document intelligence sidecar

Docling is a mature MIT local document-processing system with a unified document representation and strong PDF layout, tables, reading order, formulas, images, OCR, and many office/media formats. Reimplementing it inside a TypeScript canvas would be expensive and inferior.

### Bring as an adapter, not a fork

- a local sidecar/CLI adapter pinned to supported Docling versions;
- lossless JSON input/output boundary;
- conversion from Docling structure into a Lilac import IR, then transactions into the document graph;
- provenance linking imported nodes back to page/region/source file;
- optional OCR/VLM/audio/video features behind explicit capability flags.

Core editing and file opening must continue to work when Python/models are unavailable.

## 6. No-Mistakes — project delivery governance

No-Mistakes should improve how Lilac itself is developed and how future repository-connected agent work is delivered. Its high-value ideas are isolated worktree validation, structured findings, explicit human/agent resolution states, repair revalidation, and proof that a CI repair is based on the reviewed head before publishing it.

### Bring

- finding/result schema;
- gate state machine: review → tests → docs → lint/static checks → publish → PR → CI;
- exact-head and repair ancestry proofs;
- rerun the relevant gate after an automated fix;
- evidence stored outside disposable worker worktrees;
- explicit `ask-user` state for policy/intent decisions.

This is not a dependency of the shipped canvas renderer.

## 7. Classifier.dev / Jev — decision contract, optional hosted execution

The MIT source exposes useful multi-dimension schemas: each dimension has named labels and optional instructions; result cells contain selected label, confidence, per-label probability scores, and model identity. It validates dimensionality, label uniqueness, text size, and batch/context limits.

### Bring

- a provider-neutral `DecisionDimension` / `DecisionResult` contract;
- multi-dimension batching;
- confidence plus full score distribution;
- explicit thresholds, abstention, and uncertain-item review routing;
- deterministic prefilters before classifier calls;
- Jev/Classifier as an optional adapter and as independent qualification tooling.

### Do not bring

- billing, hosted account logic, market/persona product, Cloudflare service assumptions;
- a mandatory network dependency for design decisions.

## 8. Appllama skills — encode the method, not the service

The most useful content is a design-review methodology: research before drawing, extract patterns rather than pixels, native control/navigation semantics, semantic colors, anti-template rules, motion purpose/frequency gates, reduce-motion support, performance verification, and complete loading/empty/error state cycles.

### Bring

Translate stable, testable rules into Lilac/Impeccable rule packs and agent checklists. Keep subjective guidance as explainable recommendations rather than hard invariants.

The Appllama MCP may be an optional user-connected research source; it is never required for core Lilac and its screenshots/assets are not copied into Lilac datasets without separate rights.

## 9. Website-downloader — small static mirror fallback

The current MIT implementation contains several useful operational safeguards: per-job directories, quotas, timeouts, cancellation, `execFile` instead of a shell, http/https-only input, filesystem-based success checks, and guarded cleanup.

### Bring

Only the lifecycle/security pattern for a local static-mirror fallback. Add stronger protections before production: private/link-local IP blocking, redirect revalidation, output MIME/size policy, sandboxing, concurrency limits, and provenance manifests.

Do not use recursive `wget` as Lilac's primary semantic importer.

## 10. Design-resources — provider catalog only

The repository is CC0, but it is primarily a curated list of external services/resources. The list's license does not transfer rights from the linked font/icon/photo/video providers.

### Bring

A normalized provider registry: category, URL, capability, offline/online status, pricing/free flags where known, and separately verified license metadata. Asset acquisition remains provider-specific and user-directed.

## 11. Doop — high-value clean-room collaboration specification

Doop is the closest public Paper-like product in this set: HTML frames, WebSocket presence, live agent editing over MCP, comments/activity, private canvases, and local PGlite/Postgres options. Its public code is AGPL-3.0-only and the repository includes multiple contributors and a large product/server surface.

### Use as reference by default

Study and test the behavior of:

- presence and per-frame editing indicators;
- agent identity/status and streaming mutations;
- comments/activity attribution;
- access-controlled WebSocket subscriptions;
- local-first collaboration/storage choices;
- MCP authentication and user/agent attribution.

Implement these against Lilac's graph/transaction model rather than adopting Doop's raw-HTML-frame model or wholesale database/server stack.

Direct code import requires a separately documented rights decision covering the specific code/contributors and AGPL implications. Until then, no AGPL Doop code enters Lilac core.

## 12. Firecrawl — web-capture architecture, not Lilac's platform

Firecrawl demonstrates robust capture fallback architecture: browser rendering via a Playwright service, fetch/browser engine selection, crawling/action jobs, output normalization, and scalable queue deployment. That platform is much heavier than Lilac needs and the public repository is AGPL-3.0.

### Reference architecture

Lilac web intake should be smaller and local-first:

1. source-aware local browser instrumentation when possible;
2. Paper-compatible DOM/style snapshot capture;
3. isolated local Playwright capture for JS-heavy pages;
4. static fetch / bounded `wget` mirror fallback;
5. optional external Firecrawl connector when a user explicitly configures it.

Do not import Firecrawl's proxy/queue/Redis/RabbitMQ/Kubernetes/cloud platform into core Lilac.

## 13. jev_search — ideas only

The upstream README explicitly says the project is AI-generated and should not be used in production. No root license file was observed during this study. The implementation is nevertheless useful as a compact demonstration of criteria parsing, file prioritization, chunking, parallel evaluation, and progressive output.

### Bring by independent reimplementation

- boolean criteria grammar (`AND`, `OR`, parentheses, quoted phrases);
- two-stage candidate prioritization;
- deterministic chunking and bounded concurrency;
- progressive ranked results.

Do not ship the upstream Python/OpenRouter implementation as a production dependency.

## Revised implementation order

### Grain 1 — Design Assurance Foundation

Integrate Impeccable behind `packages/design-assurance`, establish a Lilac rule-pack boundary, and prove deterministic checks over source/static HTML/browser snapshots. This moves quality enforcement ahead of later agent automation.

### Grain 2 — Durable Agent Kernel

Port Unreal Agent session/operation semantics into `packages/agent-runtime`. No multi-worker supervision yet.

### Grain 3 — Agent Event Protocol

Add Lilac's typed event stream, borrowing the useful UI-TARS taxonomy while binding every mutation event to durable operation/session identities.

### Grain 4 — Agent Supervisor

Add Firstmate-derived worker/worktree supervision and recovery on top of the already-proven kernel.

### Grain 5 — Collaboration

Build Lilac-native presence/comments/activity/live-agent editing using Paper evidence plus clean-room Doop behavioral study. The document graph remains canonical.

### Grain 6 — Import Stack

Implement local DOM snapshot + Playwright capture, then Docling local adapter, bounded static mirroring, and optional UI-TARS/Firecrawl adapters.

### Grain 7 — Decision Router

Add provider-neutral dimension/confidence/abstention contracts; deterministic rules remain first. Jev/classifier is one optional provider.

### Grain 8 — Delivery Governance

Apply No-Mistakes-derived exact-head/repair/gate rules to Lilac agent-driven source changes and project CI.

### Grain 9 — Design Method/Resources

Encode Appllama-derived native/mobile rules and the design-resources catalog after the deterministic assurance engine can host them.

## Explicit rejections

Lilac will not import as core dependencies:

- Doop's full AGPL server/database/product stack;
- Firecrawl's full AGPL scraping/cloud orchestration platform;
- Jev-search's production implementation;
- Firstmate's entire shell/harness distribution;
- No-Mistakes' TUI/git proxy as a shipped editor dependency;
- UI-TARS' full model/remote-operator stack;
- Docling's ML stack into the core desktop bundle;
- Classifier.dev billing/account/market service;
- Appllama paid MCP as a core requirement;
- external design-resource assets merely because their links appear in a CC0 catalog.

## Definition of successful donor use

A donor has been successfully used only when Lilac gains the targeted capability with lower complexity than wholesale adoption, the capability remains independently testable, local/private mode remains viable, provenance is exact, and Lilac retains one coherent document/history/agent authority model.
