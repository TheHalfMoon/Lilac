# Unreal Agent Grain 2 Semantic Port — 2026-10-03

## Scope

This evidence record covers Lilac Grain 2 / Issue #16: the durable Lilac agent kernel implemented in `packages/agent-runtime`.

## Pinned donor

- Repository: `unreallabsai/unreal-agent`
- Revision: `1b9f778453f411c029b39b85102aaefb95e7e48d`
- License: MIT
- Integration posture: bounded semantic port into Lilac-native TypeScript; no wholesale Go harness import.

The pinned revision was inspected directly. High-value reference files included:

- `harness/sessionstore/sessionstore.go`
- `harness/sessionstore/localfile/state.go`
- `harness/sessionstore/localfile/store.go`
- `harness/sessionstore/localfile/codec.go`
- `harness/inbox/inbox.go`
- `harness/inbox/local.go`
- `harness/operation/operation.go`
- `harness/operation/local_manager.go`
- `harness/tool/tool.go`

## Semantics ported

Lilac ports the following bounded behavior:

- versioned append-only session records with contiguous item sequence numbers;
- caller-supplied input identities and deterministic duplicate handling;
- newline-committed durable log serialization and replay;
- resume state derived from durable history rather than hidden runtime state;
- immutable-parent session forks with inherited operations made inert;
- versioned serializable operation envelopes;
- explicit operation status transitions and terminal-state regression protection;
- atomic first tool-call-status plus operation registration;
- immutable operation type/version after initialization;
- durable cancellation and failure checkpoints;
- recovery of unfinished operations and terminal states not yet represented in tool-call history;
- synchronous tool-call translation that only records inert operation requests.

## Lilac-specific authority extensions

Every operation carries explicit authority metadata:

- `actorId`;
- `intent`;
- `capabilityId`;
- `toolId`;
- affected node identities;
- affected source identities;
- a Lilac `transactionId` once a document mutation is actually committed.

New operations cannot start pre-bound to a transaction. The transaction-binding checkpoint is intentionally excluded from the package public API. `commitDocumentOperation` is the public binding path and delegates the actual document mutation to `@lilac/history`; the agent runtime itself does not implement a parallel canvas mutation path.

## Deliberate Lilac deviations

- Reusing an input ID with identical content is a deterministic no-op; reusing it with different content raises `IdempotencyConflictError`. This is stricter than silently dropping all same-ID submissions.
- Canonical JSON normalization sorts object keys, rejects non-finite values, cycles, accessors, class instances, sparse arrays, and excessive nesting, and treats `__proto__` only as data.
- New document-affecting operations must begin with `transactionId: null`; only a successful Lilac history commit may bind the transaction ID.
- No Go runtime primitives, provider clients, remote-job handlers, SSH/tmux execution, donor branding, or donor telemetry are imported.

## Qualification

Implementation head qualified locally before this evidence-only commit:

`d75e4323b57f7ba26fa296566b94048fe9b95a61`

Results:

- `npm run check`: **59 passed, 0 failed**;
- `git diff --check origin/main...HEAD`: PASS;
- npm workspace install reported 0 vulnerabilities;
- Jev change-review used 6 changed source files plus 3 changed test files as context and produced no threshold signals and no findings;
- the highest Jev cell was below the `0.7` follow-up threshold;
- Alibaba Open Code Review delegate mode identified 10 reviewable code/package files and resolved JavaScript/TypeScript and package rules for manual inspection;
- manual review against those rules found no blocking correctness, security, reliability, dependency, or maintainability issue.

GitHub exact-head CI and post-merge CI are still required before Issue #16 can be closed canonical.

## Integrity boundary

This record does not claim the Lilac TypeScript implementation is original Unreal Agent source or a byte-for-byte port. It is a separately implemented semantic port informed by the pinned MIT-licensed donor behavior and extended with Lilac-specific authority and document-history constraints.
