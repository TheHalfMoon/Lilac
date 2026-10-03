# UI-TARS Grain 3 Adaptation Evidence — 2026-10-03

## Scope

Grain 3 implements Lilac's typed agent event protocol as a bounded adaptation of event-stream concepts studied from UI-TARS Desktop / Tarko. It does not import the UI-TARS application, model runtime, remote operator, browser automation stack, branding, telemetry, or provider-specific execution runtime.

## Pinned donor

- Repository: `bytedance/UI-TARS-desktop`
- Revision: `2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a`
- License observed at the pinned revision: Apache License 2.0
- Integration posture: bounded adaptation

## Exact studied surfaces

| Upstream path | Blob SHA | Material behavior studied |
|---|---|---|
| `multimodal/tarko/agent-interface/src/agent-event-stream.ts` | `f8d37a00adaadcdd9f6514407040713b0e746518` | typed event union, streaming assistant/tool-call events, tool results, run lifecycle, environment input, plans, final answers, processor interface |
| `multimodal/tarko/agent/src/agent/event-stream.ts` | `ce023ed4345a93989d2ae4e1243cc440bb794c34` | in-memory event stream, subscriptions, filtered reads, subscriber failure isolation, bounded retention |
| `multimodal/tarko/agent-ui/src/common/state/actions/eventProcessors/EventHandlerRegistry.ts` | `3be12c7b9719126641d1e71fdcd79bdd1db3a1e0` | handler registry and multi-handler lookup |
| `multimodal/tarko/agent-ui/src/common/state/actions/eventProcessors/index.ts` | `3a5cd500c34258dd2bbfa39765ff3a8e950ad146` | parallel handler execution and per-handler exception isolation |
| `LICENSE` | `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64` | Apache License 2.0 text |

The upstream core mapping contains 17 built-in event categories spanning user/assistant content, assistant streaming, streaming tool-call deltas, tool invocation/results, system/run lifecycle, environment inputs, plan lifecycle, and final-answer events.

## Lilac-owned adaptation

`@lilac/agent-events` deliberately strengthens the protocol beyond the studied donor behavior:

- event ID, sequence, run ID, session ID, timestamp, and correlation IDs are caller-supplied;
- no hidden `uuid` generation or `Date.now()` is used by the protocol core;
- sequence is contiguous and monotonic per run;
- run lifecycle is explicit and replay-validated;
- assistant streaming uses explicit start/delta/final states and verifies final content against accumulated deltas;
- tool calls use explicit start/argument-delta/final/terminal-result states and verify final arguments against accumulated JSON deltas;
- result/error/cancel events require a finalized tool call;
- successful run completion requires assistant/tool/plan state to be settled;
- operation ID and Lilac transaction ID correlations are validated and cannot be rebound inconsistently;
- correlation fields are restricted to event kinds for which they are meaningful;
- environment inputs carry bounded references and metadata instead of arbitrary embedded blobs;
- event and log byte/count limits are explicit;
- envelope and payload schemas are closed-world: unknown fields fail closed;
- replay reconstructs canonical run/message/tool/plan state from the event history;
- event querying supports bounded filtering/pagination by identity and correlation fields;
- event handlers receive deeply frozen snapshots;
- handler filters are runtime-validated against the supported event taxonomy;
- handler failure is reported per handler and cannot prevent unrelated handlers from receiving the committed event.

## Authority boundary

This package is observational/protocol infrastructure. It does not import Lilac document mutation functions and exposes no canvas mutation path. `@lilac/agent-runtime` operation IDs and transaction IDs are correlation values only. Canonical document changes remain governed by `document-model` + `history` through the Grain 2 transaction boundary.

## Safety boundary

- Maximum serialized event size: 64 KiB.
- Maximum streaming delta size: 16 KiB UTF-8.
- Maximum environment references per event: 32.
- Maximum plan steps in a plan snapshot: 128.
- Maximum retained event count per event log: 10,000.
- Maximum serialized event-log size: 16 MiB.
- JSON safety inherits the canonical Grain 2 JSON boundary, including cycle, accessor, class-instance, sparse-array, non-finite-number, and nesting-depth rejection.

## CI qualification

Implementation code head `f104b6c89510d48b87e7e4d358c263aa23c4990e` completed GitHub Actions CI run `37149859264` successfully.

- `npm ci --ignore-scripts`: PASS.
- npm audit result during install: 0 vulnerabilities.
- `npm run check`: PASS.
- Node test suite: 76 passed, 0 failed, 0 skipped, 0 canceled.
- The suite includes 17 Grain 3 protocol tests plus all canonical Lilac regression tests.

The exact-head CI run verified the package workspace lock, syntax checks, deterministic event/log serialization, lifecycle/correlation failure paths, streaming consistency, operation/transaction binding rules, bounded environment references, filtered pagination, and handler isolation.

## Review qualification state

A full PR-diff manual review was performed against the same JavaScript/TypeScript rules normally resolved by Alibaba Open Code Review. That review found one nested-ternary code-quality violation in tool terminal-state selection; it was repaired before implementation head `f104b6c89510d48b87e7e4d358c263aa23c4990e`. No additional blocking issue was found in the reviewed Grain 3 diff.

This manual review is **not** represented as an Alibaba Open Code Review execution. The Alibaba OCR CLI and Jev exact-diff reviewer remain pending because the authorized local Desktop Commander execution channel is paused at its monthly usage limit. No alternate credentials or review results are fabricated.

Current status: `CI_QUALIFIED_REVIEW_GATES_PENDING`.

The PR must remain draft and unmerged until Jev and Alibaba Open Code Review are actually executed on the final exact head (or the project owner explicitly changes that governance requirement). After those gates pass, final exact-head CI, normal merge, and post-merge CI are still required before Issue #22 can close.

Generated reviewer services such as Cubic, CodeRabbit, and Qodo are not qualification evidence.
