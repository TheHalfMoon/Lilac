# Lilac Donor Integration Map

This document maps authorized donor projects to bounded Lilac subsystems. It is an implementation plan, not a license waiver and not a directive to copy whole repositories blindly.

## Integration priorities

| Donor | Primary Lilac role | Intake posture | Target subsystem |
|---|---|---|---|
| `kgoedecke/doop` | Paper-like multiplayer canvas, MCP collaboration, comments/activity, agent-visible editing | HIGH | canvas collaboration, MCP execution, comments, activity feed |
| `kunchenguid/firstmate` | multi-agent orchestration, isolated worktrees, supervision, restart-safe state | HIGH | agent orchestration and multi-agent workspace |
| `unreallabsai/unreal-agent` | durable async agent sessions, idempotent inputs, serializable operations, recovery/forks | HIGH | agent runtime kernel |
| `kunchenguid/no-mistakes` | isolated guarded validation and PR delivery pipeline | HIGH | visual/code review and delivery gates |
| `pbakaus/impeccable` | deterministic frontend/design detectors, critique/polish/harden workflows | HIGH | design decision assurance and quality engine |
| `bytedance/UI-TARS-desktop` | multimodal GUI/browser operator, event-stream architecture, local/remote computer control | HIGH | live-app intake, GUI agent, operator/event stream |
| `docling-project/docling` | local document parsing, PDF/layout/table/OCR/document model | HIGH | document/media importer |
| `firecrawl/firecrawl` | resilient web crawl/scrape/action patterns and structured extraction | MEDIUM-HIGH | website intake and crawl architecture |
| `AhmadIbrahiim/Website-downloader` | simple recursive offline website capture with asset rewriting | MEDIUM | offline website snapshot fallback |
| `classifier.dev` | calibrated classification/decision routing and long-context filtering | MEDIUM | decision assurance, routing, retrieval pruning |
| `caio0452/jev_search` | lightweight semantic directory/chunk search using decision models | MEDIUM | local/source retrieval reference |
| `Appllama/appllama-skills` | design research/build discipline and simulator-verified mobile UX patterns | MEDIUM | design-agent skills and mobile adaptation |
| `reinaldosimoes/design-resources` | curated resource taxonomy for fonts/icons/media/design systems | LOW-MEDIUM | resource discovery catalog; links/metadata rather than bulk asset copying |

## Architectural allocation

### 1. Canvas and collaboration

Use `doop` as the strongest external implementation reference/donor for multiplayer canvas behavior that Paper source recovery did not provide cleanly: presence, WebSocket collaboration, comments, activity, per-frame editing state, MCP-authenticated agent collaboration, and local self-hosting patterns.

Do not transplant Doop product identity or hosted-service assumptions. Any copied subsystem must be reduced to Lilac's document graph and transaction/history APIs rather than introducing a second canonical model.

### 2. Agent runtime

Combine complementary ideas rather than adopting one harness wholesale:

- `unreal-agent`: canonical persisted session/operation model, idempotency, recovery, forks, tool translation boundaries;
- `firstmate`: agent-fleet orchestration, worktree isolation, supervision, dispatch, restart reconciliation;
- Lilac: transaction attribution, canvas/node authority, capability policy, and MCP compatibility.

The result should be a Lilac-native agent runtime with one authoritative operation log and no hidden agent mutation path.

### 3. Review and decision assurance

Use:

- `no-mistakes` for guarded validation/delivery state machines and isolated worktree review;
- `impeccable` for deterministic design-quality detectors and critique/polish/harden flows;
- `classifier.dev` / Jev-style decisions for bounded routing, classification, and uncertainty-aware escalation.

Rules:

- deterministic checks run before model judgment;
- model decisions never silently override invariant failures;
- uncertain decisions may abstain/escalate;
- every automated fix remains reversible and attributable.

### 4. Website and live-app intake

Use a layered intake stack:

1. browser/runtime instrumentation for source-aware local apps;
2. Paper Snapshot-compatible DOM serialization already recovered/reconstructed;
3. Firecrawl-derived crawl/scrape/action architecture for JS-heavy public sites;
4. Website-downloader-derived recursive asset capture as a simple offline fallback;
5. UI-TARS-derived visual/browser operator only when DOM/network paths are insufficient.

All imported scripts are untrusted. Strip or sandbox executable content by default and preserve origin/provenance per captured asset.

### 5. Documents and media

Use Docling-derived parsing architecture for PDF, DOCX, PPTX, XLSX, HTML, images, OCR, tables, reading order, formulas, and document structure. Convert into a Lilac import IR rather than making Docling's document model canonical inside Lilac.

Heavy local models must remain optional; baseline document import must not require paid cloud services.

### 6. Design intelligence

Use Impeccable-derived deterministic detector patterns as the initial Lilac design-quality rule engine. Keep rules inspectable and separable from LLM critique.

Use Appllama skills as a methodology donor for design research, native/mobile interaction quality, motion review, anti-slop discipline, and simulator/preview verification. Paid Appllama MCP access must remain optional; Lilac cannot require it for core functionality.

Use `design-resources` as a curated discovery taxonomy. Individual linked assets retain their own licenses; the catalog does not grant blanket rights to third-party resources.

### 7. Retrieval and source discovery

`jev_search` is useful as a small reference for candidate-file prioritization, chunking, and decision-based filtering. It is explicitly marked by its upstream README as AI-generated and not production-ready, so Lilac should reuse ideas selectively and harden them with tests rather than adopt it as a production dependency.

Classifier/Jev-style classification may be an optional accelerator. Local deterministic or user-selected model paths must exist so core Lilac operation does not depend on a hosted classification service.

## Import sequence

### Grain A — agent/runtime foundation

1. Unreal Agent operation/session model study and bounded donor snapshot.
2. Firstmate supervision/worktree orchestration extraction.
3. Reconcile both into Lilac's existing `history`, `document-model`, and `mcp-protocol` packages.

### Grain B — collaboration and canvas parity

1. Doop multiplayer protocol and state boundaries.
2. Comments/activity/presence model.
3. Agent attribution integration with Lilac transactions.

### Grain C — intake stack

1. Docling document adapter.
2. Web capture adapter using recovered Paper-compatible snapshot semantics.
3. Firecrawl/Website-downloader patterns for crawl/assets.
4. UI-TARS visual fallback operator.

### Grain D — quality/decision engine

1. Impeccable deterministic rule engine.
2. No-mistakes guarded review lifecycle.
3. Optional Jev/classifier decision router.
4. Visual regression and accessibility gates.

### Grain E — design research/resources

1. Appllama skill patterns adapted into Lilac agent skills.
2. Design-resources taxonomy as a link/reference registry with per-resource licensing metadata.

## Acceptance rules for every grain

- exact donor revision recorded;
- original license/NOTICE copied where applicable;
- SHA-256 manifest for imported source subset;
- imported code isolated from Lilac-written code until reviewed;
- no donor telemetry/credentials/branding retained accidentally;
- tests demonstrate the bounded capability;
- Jev and Alibaba Open Code Review qualification before merge;
- normal merge commit only;
- exact-head CI and post-merge verification required.
