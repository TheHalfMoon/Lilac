# Grain 7 - Decision Router implementation evidence

Date: 2026-10-06

Issue: #37

## Scope

Grain 7 implements a Lilac-owned provider-neutral decision router. It produces typed decisions with confidence, full label-score distributions, explicit abstention, and uncertain-item review routing. It never mutates canonical document state and requires no provider, model download, hosted inference, or paid API.

Target package:

`packages/decision-router`

## Donor revisions and boundaries

### classifier-dev (classifier.dev)

- repository: `mrmps/classifier-dev`
- revision: `a17bf2b6353f6234af6e977a463da7cd1975b68e`
- observed license: MIT
- posture: schema and behavior guidance only

Studied surfaces:

- `src/dimensions.ts`
- `src/jev.ts`
- `src/mcp.ts`

Adapted ideas: named decision dimensions with 2-100 distinct labels and instructions; definition bounds; per-item-per-dimension cells; result shape of selected label plus confidence plus complete label-score distribution plus model identity; token-budget batching with bounded concurrency; an unsure-below threshold (default 0.7) that routes low-confidence items to review instead of deciding.

Not imported: billing, quotas, Durable Objects, hosted gateway fallbacks, analytics engines, SaaS transports, and frontend code. Lilac-specific authority, determinism, idempotency, precheck precedence, and abstention semantics are project-owned.

## Authority properties

- The router emits decisions and review routings only; it holds no document-mutation authority.
- Deterministic prechecks always outrank probabilistic adapter output and can force a label or force abstention with a reason.
- Confidence below threshold never becomes a positive decision; the cell abstains and enters the bounded review queue.
- Unknown or unsupported inputs fail closed or abstain.
- Adapters classify cells through a typed contract and are validated strictly: in-schema labels, finite [0, 1] confidence and scores, complete per-label distributions.
- The optional Jev adapter reports adapter-unavailable unless explicitly configured; it never auto-downloads and never requires network when unconfigured.
- The deterministic local rule adapter works fully offline and keeps the core useful with zero providers.
- Label instructions are treated as data and cannot escalate router authority.

## Determinism and idempotency

- Identical request plus deterministic adapter plus policy serializes identically; decisions sort by cell identity.
- Caller supplies request identities and timestamps; no hidden clocks or random identifiers in core logic.
- Duplicate request IDs are idempotent only for byte-identical intent and input identity; conflicting reuse raises a typed conflict.

## Qualification

Qualification evidence is added to the PR/Issue only after exact-head GitHub CI, Alibaba Open Code Review delegation, and Jev review complete. Cubic, CodeRabbit, and Qodo are not qualification evidence.
