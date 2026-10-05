# Lilac Donor Integration Map

This document is the execution map derived from `docs/DONOR_DEEP_STUDY_2026-10-03.md`. The deep-study document owns the evidence and source-by-source rationale; this file owns implementation sequence and subsystem boundaries.

## Rules

- Never bulk-copy a donor repository.
- Pin every imported/adapted source snapshot to an exact revision.
- Preserve applicable license/NOTICE text and third-party provenance.
- Lilac `document-model` + `history` remain the only canvas mutation authority.
- Deterministic validation runs before probabilistic/model judgment.
- Core Lilac must work without mandatory paid cloud services.
- Doop and Firecrawl public AGPL code are reference/optional-connector inputs by default; no AGPL code enters Lilac core without a separately documented rights/licensing decision for the exact subset.

## Final priority map

| Priority | Donor | Posture | Lilac target |
|---:|---|---|---|
| 1 | `pbakaus/impeccable` | INTEGRATE + ADAPT | deterministic design assurance, WASM/browser/static checks, Lilac rule packs |
| 2 | `unreallabsai/unreal-agent` | PORT | durable agent session/operation kernel |
| 3 | `bytedance/UI-TARS-desktop` | ADAPT | typed agent event stream and optional DOM/visual operator |
| 4 | `kunchenguid/firstmate` | PORT + ADAPT | worker/worktree supervision and restart reconciliation |
| 5 | `docling-project/docling` | OPTIONAL LOCAL ADAPTER | structured document/PDF import |
| 6 | `kunchenguid/no-mistakes` | DEVELOPMENT ADAPTATION | guarded source-change/PR/CI delivery gates |
| 7 | `mrmps/classifier-dev` / classifier.dev | ADAPT + OPTIONAL PROVIDER | dimension/confidence/abstention decision contract |
| 8 | `Appllama/appllama-skills` | ADAPT AS RULES | mobile/native design methodology and deterministic rule candidates |
| 9 | `AhmadIbrahiim/Website-downloader` | SMALL FALLBACK ADAPTATION | bounded static website mirroring |
| 10 | `reinaldosimoes/design-resources` | DATA ONLY | provider/resource catalog |
| 11 | `kgoedecke/doop` | REFERENCE ONLY BY DEFAULT | clean-room collaboration/presence/comments/activity/MCP behavior |
| 12 | `firecrawl/firecrawl` | REFERENCE + OPTIONAL CONNECTOR | capture engine/fallback/crawl-job architecture |
| 13 | `caio0452/jev_search` | REFERENCE ONLY | retrieval criteria/chunking/prioritization ideas |

## Grain 1 — Design Assurance Foundation

Target: `packages/design-assurance`.

Use Impeccable revision `e103efe779e2dd01274dabae83531fef00bf2563` as the primary donor.

Deliver:
- pinned detector integration boundary;
- source-text, static-HTML, and browser/snapshot check interfaces;
- namespaced `LilacRulePack` seam;
- findings normalized into Lilac severity/evidence/fixability records;
- deterministic rule execution with no model/provider requirement;
- oracle/golden tests for stable behavior;
- initial Lilac rules for document/source-binding and design-system invariants.

Do not import provider-specific generated skill folders or Impeccable product UX.

## Grain 2 — Durable Agent Kernel

Target: `packages/agent-runtime`.

Port semantics from Unreal Agent revision `1b9f778453f411c029b39b85102aaefb95e7e48d`.

Deliver:
- versioned append-only session records;
- caller-supplied idempotency keys;
- deterministic replay/resume;
- fork records with immutable parent history;
- versioned operation envelopes;
- validated operation state transitions;
- atomic tool-call-status + operation registration;
- pure tool-call translation boundary with no hidden I/O;
- actor/intent/capability/Lilac transaction attribution for document-affecting work.

No multi-worker supervision in this grain.

## Grain 3 — Agent Event Protocol

Use UI-TARS revision `2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a` as an Apache-2.0 design/code donor for the event taxonomy.

Deliver a Lilac-owned typed event stream covering:
- run lifecycle;
- user/assistant/streaming messages;
- tool-call deltas and final calls/results;
- environment inputs such as screenshots, viewport state, and codebase context;
- plan lifecycle;
- operation/transaction correlation;
- handler isolation and event-debug inspector.

The actual UI-TARS model and remote operator remain optional.

## Grain 4 — Agent Supervisor

Port/adapt Firstmate revision `1f3e769616fdf9f31f85f4c3e6a9f71606634238` after Grain 3 is canonical.

Deliver:
- worker leases and one-worker-per-worktree ownership;
- event-driven wake/reconciliation queue;
- liveness vs useful-progress classification;
- declared waits/holds vs genuine wedge detection;
- bounded stale escalation;
- restart-safe reconciliation;
- local process/worktree backend first.

Do not import the whole shell distro, Relay, secondmate/SSH topology, or nautical UX.

## Grain 5 — Collaboration

Build Lilac-native collaboration from Paper evidence plus clean-room Doop behavioral study at `d99c8b157d5afd4192b356f89a2b19adc28c75a5`.

Deliver:
- presence/cursors;
- per-node/frame edit state;
- comments and activity attribution;
- agent status and streaming mutation visibility;
- access-controlled realtime subscriptions;
- local-first persistence path.

Doop raw HTML frames do not replace the Lilac document graph.

## Grain 6 — Import Stack

Order:
1. recovered Paper-compatible DOM/style snapshot semantics;
2. source-aware local app instrumentation;
3. isolated local Playwright capture for JS-heavy pages;
4. Docling revision `0cd61e0050a9ef68e5e10495b87e41d31acd79c9` as an optional local document sidecar;
5. bounded static mirror fallback using selected Website-downloader lifecycle patterns from `130ad63d7163c19df64322556ca9c260eef353be`;
6. optional UI-TARS visual operator;
7. optional external Firecrawl connector / architecture reference from `4244638a7041bae8b99bdd42e3c44520f9e62da1`.

Every captured asset/node records source provenance. Executable imported content is untrusted and sandboxed/stripped by default.

## Grain 7 — Decision Router

Use classifier-dev revision `a17bf2b6353f6234af6e977a463da7cd1975b68e` for schema/behavior guidance.

Deliver:
- provider-neutral decision dimensions;
- selected label + confidence + full label-score distribution;
- limits and batching;
- explicit abstention/threshold semantics;
- uncertain-item review routing;
- optional Jev/classifier adapter.

Deterministic Design Assurance findings always outrank probabilistic recommendations.

## Grain 8 — Delivery Governance

Adapt No-Mistakes revision `0616eb4911845e2ba04faa17186ecd2686d7d579` for agent-authored repository changes.

Deliver:
- structured findings;
- isolated validation worktrees;
- exact-head proof before publish/merge;
- repair ancestry checks;
- rerun-after-fix rules;
- explicit `ask-user` governance state;
- evidence persistence outside disposable worktrees.

This is project/source delivery infrastructure, not a canvas-renderer dependency.

## Grain 9 — Design Method and Resources

Adapt:
- Appllama skills revision `dd5caaec3d5d50ad7fc0324da238119c6b7c3707` into explainable mobile/native rule packs and agent review checklists;
- design-resources revision `43fe2b5d801e34c21e22b5639711f7e250a798e5` into a provider taxonomy/registry only.

The Appllama MCP is optional. Linked third-party resource assets retain their own licenses.

## Retrieval helper boundary

`caio0452/jev_search@ea073f6db48f5bff73ae4b9f2240d2d302fb9dc1` is reference-only. Reimplement useful criteria parsing, candidate prioritization, chunking, bounded concurrency, and progressive ranking in Lilac-owned code. Do not ship its upstream Python/OpenRouter implementation.

## Acceptance rules for every grain

- exact donor revision recorded;
- license/NOTICE/provenance preserved where applicable;
- imported subset has a SHA-256 manifest when source is copied;
- donor code isolated from Lilac-written code until qualified;
- no unintended telemetry/credentials/branding/hosted-service coupling;
- focused tests prove the bounded capability and failure paths;
- Jev qualification;
- Alibaba Open Code Review used where supported, with manual review against resolved rules for unsupported surfaces;
- normal merge commit only;
- exact-head CI before merge and post-merge CI on canonical main.
