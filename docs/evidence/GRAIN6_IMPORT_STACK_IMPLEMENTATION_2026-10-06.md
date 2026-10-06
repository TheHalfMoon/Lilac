# Grain 6 — Import Stack implementation evidence

Date: 2026-10-06

Issue: #34

## Scope

Grain 6 implements a Lilac-owned local-first import stack whose adapters produce untrusted, deterministic proposals. Canonical document mutation remains exclusive to `@lilac/history`.

Target package:

`packages/import-stack`

## Paper compatibility evidence

Paper behavior compatibility is grounded in the already-canonical recovery records:

- `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md`
- `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md`
- `docs/evidence/PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md`

Those records show shipped/runtime HTML-to-design behavior, computed-style and resource surfaces, Tailwind/style state, image/resource handling, and source compatibility evidence. Grain 6 does not claim unrecovered Paper private TypeScript/TSX as available.

## Donor revisions and boundaries

### Docling

- repository: `docling-project/docling`
- revision: `0cd61e0050a9ef68e5e10495b87e41d31acd79c9`
- observed license: MIT
- posture: optional local adapter only

Studied surfaces include the converter, HTML/PDF backends, base document types, document model, and pipeline abstractions. Lilac invokes a preinstalled local `docling` CLI only through a fixed argument profile, strips the environment to a small allowlist, forces offline Hugging Face/Transformers behavior, disables remote services and external plugins, applies input/output/page/time limits, and never auto-installs Docling or models.

### Website-downloader

- repository: `AhmadIbrahiim/Website-downloader`
- revision: `130ad63d7163c19df64322556ca9c260eef353be`
- observed license: MIT
- posture: bounded lifecycle adaptation

Studied surfaces:

- `wget/index.js`
- `archiver/index.js`
- `socket/socket.js`
- `README.md`

Lilac adapts only lifecycle ideas: HTTP(S)-only targets, isolated per-job directories, quotas, timeout/cancellation, same-origin/no-parent capture, guarded cleanup, exact filesystem evidence, and deterministic asset manifests. Lilac does not import the donor Express/socket product or require `wget`.

### Firecrawl

- repository: `firecrawl/firecrawl`
- revision: `4244638a7041bae8b99bdd42e3c44520f9e62da1`
- observed license: AGPL-3.0
- posture: reference and optional external connector only

No Firecrawl AGPL source code is imported into Lilac core. No Firecrawl service, Redis, Postgres, hosted crawler, or paid API is mandatory.

### Parse5

- package: `parse5@8.0.1`
- observed license: MIT
- dependency: `entities@8.0.0` (BSD-2-Clause)

Parse5 is the bounded local HTML parser. Lilac owns sanitization, authority limits, deterministic IDs, source provenance, proposal validation, and history commit boundaries.

## Security and authority properties

The implementation:

- treats imported HTML, CSS, SVG, URLs, document converter output, source text, and remote bytes as untrusted data;
- strips scripts, privileged embeds, inline event handlers, form navigation authority, dangerous URL schemes, active SVG animation/foreign-object surfaces, and `srcset`;
- normalizes CSS escapes/comments before detecting `@import`, `url()`, `expression()`, binding, and legacy behavior authority;
- rejects secret-bearing query parameters before navigation or provenance persistence;
- separates `offline`, `local-app`, and `remote` network modes;
- rejects private, loopback, link-local, carrier-grade NAT, documentation, multicast, and other reserved addresses in remote mode;
- revalidates resolved addresses at capture boundaries to mitigate DNS rebinding;
- blocks browser downloads, service workers, permissions, and WebSockets in the optional Playwright adapter;
- keeps Playwright optional and never installs it automatically;
- keeps Docling optional, local, offline, bounded, and non-authoritative;
- canonicalizes repository/file roots and rejects symlink/path escape;
- hashes assets and artifacts with SHA-256 over exact bytes;
- serializes deterministic proposal/request state;
- makes request-ID reuse idempotent only for identical intent/input identity;
- keeps static mirror recursion same-origin and page traversal within the entry path scope by default;
- applies resource-count, byte, redirect, depth, timeout, and diagnostic bounds;
- removes failed mirror sandboxes using guarded work-root cleanup;
- keeps successful mirror output explicit and disposable;
- allows document mutation only through `commitImportProposal`, which calls `@lilac/history` with an explicit base revision and import attribution.

## Optional connector seams

`ExternalCrawlerConnector` and `VisualImportOperator` are capability-neutral interfaces only. Firecrawl and UI-TARS remain optional external implementations; neither is a Grain 6 core dependency.

## Addendum 2026-10-07: project network policy enforcement (#83)

Import requests may carry `networkPolicy` (`@lilac/network-policy`). `validateNavigationUrl` now also requires an allowed `import.fetch` decision, and `validateResolvedAddresses` also requires `evaluateResolved` on that decision for the addresses actually used. This covers entry URLs, queued mirror pages and assets, redirects, Playwright subrequests and final URLs, and mirror manifest re-validation. Both policies must allow a contact (intersection): `ImportPolicy` keeps every Grain 6 refusal, and a grant's `allowPrivateNetwork` does not widen remote mode. A request without `networkPolicy` uses the default offline policy, so network-mode imports fail closed. All import-stack contacts use `import.fetch`; `asset.fetch` stays reserved. Proposals and ledger records do not embed the network policy. The Grain 6 network tests were re-run with explicit grants (`tests/import-stack.test.mjs`), and `tests/import-network-policy.test.mjs` adds the enforcement cases.

## Qualification

Qualification evidence is added to the PR/Issue only after exact-head GitHub CI, Alibaba Open Code Review delegation, and Jev review complete. Cubic, CodeRabbit, and Qodo are not qualification evidence.
