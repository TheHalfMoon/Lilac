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
- assistant streaming uses explicit start/delta/final states;
- tool calls use explicit start/argument-delta/final/terminal-result states;
- result/error/cancel events require a finalized tool call;
- operation ID and Lilac transaction ID correlations are validated and cannot be rebound inconsistently;
- environment inputs carry bounded references and metadata instead of arbitrary embedded blobs;
- event and log byte/count limits are explicit;
- envelope and payload schemas are closed-world: unknown fields fail closed;
- replay reconstructs canonical run/message/tool/plan state from the event history;
- event querying supports bounded filtering/pagination by identity and correlation fields;
- event handlers receive deeply frozen snapshots;
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

## Qualification status

Implementation qualification is intentionally not claimed in this evidence record until the final exact head has completed the required test, Jev, Alibaba Open Code Review, exact-head CI, normal-merge, and post-merge gates. Generated reviewer services such as Cubic, CodeRabbit, and Qodo are not qualification evidence.
