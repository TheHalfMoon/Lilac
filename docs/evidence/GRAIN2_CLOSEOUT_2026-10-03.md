# Grain 2 Canonical Closeout — 2026-10-03

Grain 2, the Durable Lilac Agent Kernel, is `CLOSED_CANONICAL`.

## Canonical implementation

- Issue: #16 — closed completed.
- Implementation PR: #21 — normal merge.
- Qualified PR head: `8e99bd079dbc3e59dad4fbe1c445f64201ffc8a2`.
- Canonical merge SHA: `943a0727b9e15abbe7e47d8d7aa99adc6b0c3434`.
- Exact-head PR CI: `37144809927` — SUCCESS.
- Post-merge CI: `37144857504` — SUCCESS on the canonical merge SHA.
- Local test suite: 59 passed, 0 failed.
- `git diff --check`: PASS.
- npm workspace install reported 0 vulnerabilities.

## Review qualification

- Jev change review used six changed runtime source files plus three changed test files as context.
- Jev threshold: `0.7`; threshold signals: 0; findings: 0; highest observed cell: `0.54`.
- Alibaba Open Code Review delegate mode identified 11 reviewable files in the final implementation range and resolved JavaScript/TypeScript and package rules; manual inspection found no blocking issue.
- Cubic, CodeRabbit, Qodo, and similar services are not qualification evidence.

## Proven capability

The canonical `@lilac/agent-runtime` now provides:

- append-only, replayable durable sessions;
- deterministic caller-ID idempotency and conflict handling;
- newline-committed canonical logs and recovery;
- immutable-parent forks with inherited operations made inert;
- versioned operation envelopes and validated lifecycle transitions;
- atomic tool-call-status plus operation initialization;
- cancellation, failure, and unfinished-operation recovery semantics;
- synchronous tool translation with no hidden provider I/O;
- actor, intent, capability, tool, source, node, and transaction attribution;
- document mutation binding exclusively through `@lilac/history`;
- hardened canonical JSON and malformed-log handling.

## Provenance boundary

The semantic donor is `unreallabsai/unreal-agent@1b9f778453f411c029b39b85102aaefb95e7e48d` under MIT. Lilac implements a separately written TypeScript semantic port; it does not claim the Go harness or provider/runtime stack as Lilac source.

## Successor

The next authorized implementation grain is Issue #22: typed Lilac Agent Event Protocol from the pinned UI-TARS taxonomy. Paper recovery Issue #2 remains opportunistic and is not an implementation blocker.