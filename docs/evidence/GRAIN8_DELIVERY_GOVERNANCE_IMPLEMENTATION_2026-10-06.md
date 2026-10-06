# Grain 8 - Delivery Governance implementation evidence

Date: 2026-10-06

Issue: #40

## Scope

Grain 8 implements Lilac-owned exact-head source delivery and qualification infrastructure. It inspects, records, and gates agent-authored changes; it never mutates canonical documents, never executes shell strings, and never rewrites history.

Target package:

`packages/delivery-governance`

## Donor revisions and boundaries

### no-mistakes

- repository: `kunchenguid/no-mistakes`
- revision: `0616eb4911845e2ba04faa17186ecd2686d7d579`
- observed license: MIT
- posture: governance semantics only

Studied surfaces:

- `skills/no-mistakes/SKILL.md`
- `internal/gate/gate.go`
- `internal/gate/reconcile.go`
- `internal/custody/refs.go`
- `internal/evidence`
- `.no-mistakes.yaml`

Adapted ideas: isolated validation worktrees with pinned heads, forward-only delivery after green evidence, create-only evidence anchors where conflicts fail closed, parked human decisions for blocking review findings, targeted validation, ref reconciliation, and rerun-after-fix discipline.

Not imported: the Go daemon, git proxy, hooks, database, billing, or forge machinery. No non-permissive code is involved. Lilac-specific qualification, invalidation, and ask-user semantics are project-owned.

## Authority properties

- Governance gates delivery; it holds no document-mutation authority and performs no history rewriting.
- No subprocess or shell execution exists anywhere in the package; worktree identity is accepted as typed evidence shaped by the Grain 4 supervisor boundary.
- Evidence writes are confined outside registered disposable worktree roots, refuse symlinks, and are create-only.
- Finding and label text is data, never commands.

## Determinism and invalidation

- Identical inputs serialize identically; records sort deterministically.
- Caller supplies timestamps and identities; no hidden clocks or random identifiers in core logic.
- Evidence qualifies exactly one candidate head; any mutation, head movement, or base movement invalidates it automatically.
- Repairs carry parent qualification ancestry and start with empty evidence until fresh runs complete.

## Qualification

Qualification evidence is added to the PR/Issue only after exact-head GitHub CI, Alibaba Open Code Review delegation, and Jev review complete. Cubic, CodeRabbit, and Qodo are not qualification evidence.
