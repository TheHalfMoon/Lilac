# Grain 1 Canonical Closeout — 2026-10-03

Grain 1, deterministic Lilac Design Assurance, is `CLOSED_CANONICAL`.

## Canonical implementation

- Issue: #17 — closed completed.
- Implementation PR: #19 — normal merge.
- Qualified PR head: `09c82c31e5ac7ebd9e76fb3bcac730fe628dcce8`.
- Canonical merge SHA: `240a20f0ef131c614139ab452e7e5c7cead84524`.
- Exact-head PR CI: `37140203005` — SUCCESS.
- Post-merge CI: `37140267250` — SUCCESS on the canonical merge SHA.
- Clean local dependency install: `npm ci --ignore-scripts` — PASS.
- Local test suite: 39 passed, 0 failed.

## Review qualification

- Jev exact-head review: PASS at threshold `0.7`; highest reviewed probability was `0.32` for source-adapter coverage gap.
- Alibaba Open Code Review delegate mode resolved JavaScript, package, and workflow rules for the exact implementation range; manual inspection found no blocking issue.
- Cubic, CodeRabbit, Qodo, and similar services are not qualification evidence.

## Provenance boundary

The studied source revision `pbakaus/impeccable@e103efe779e2dd01274dabae83531fef00bf2563` records `ENGINE_VERSION=0.1.11`. The actually published `impeccable@4.1.0` package used by Lilac pins its platform detector dependency to `0.1.5`. These are intentionally recorded as separate source and runtime facts.

## Successor

The next authorized implementation grain is Issue #16: Durable Lilac Agent Kernel from Unreal Agent semantics. Firstmate multi-worker/worktree supervision remains deferred until that single-session durable kernel is canonical.
