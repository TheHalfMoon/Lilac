# Grain 5 collaboration implementation evidence — 2026-10-05

## Scope

This record describes the Grain 5 implementation candidate for Issue #26. It does not claim canonical closure; exact-head review, GitHub CI, merge, and post-merge CI remain governance gates.

Target package: `packages/collaboration`.

Canonical implementation base:

`9ab8b55eb319939c560646f640f444ed9a19916b`

That base is the canonical Grain 4 merge after Issue #25 reached `CLOSED_CANONICAL`.

## Paper compatibility evidence

Lilac's recovered Paper evidence records the collaboration behavior used as the primary compatibility source:

- `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md`
- `docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md`
- `docs/evidence/PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md`

Observed Paper surfaces include multiplayer connection/collaborator state, awareness/presence, comments and comment-thread behavior, agent activity, camera state, and transaction/agent attribution primitives. Grain 5 adapts those behavioral contracts to Lilac's typed local-first authorities rather than creating a second document model.

## Clean-room reference boundary

Additional behavioral reference:

- repository: `kgoedecke/doop`
- exact revision: `d99c8b157d5afd4192b356f89a2b19adc28c75a5`
- observed license: `AGPL-3.0-only`
- posture: **REFERENCE ONLY**
- raw donor code imported into Lilac: **NO**

Studied surfaces are frozen in `COLLABORATION_PROVENANCE` and match Issue #26, including realtime, viewport, access, comments, workspace authorization, MCP comment behavior, and activity-related surfaces.

No Doop product database/server stack, raw-HTML-frame canonical model, billing, telemetry, branding, hosted assumptions, or AGPL source code is imported. The implementation is independently written Lilac TypeScript from behavioral requirements and existing Lilac authority contracts.

## Implemented authority boundaries

- `document-model` + `history` remain the only document mutation authority.
- `@lilac/agent-runtime` remains the durable operation/session authority.
- `@lilac/agent-events` remains the typed event/replay authority.
- `@lilac/agent-supervisor` remains worker/runtime supervision authority.
- `@lilac/collaboration` authorizes, transports, attributes, persists collaboration facts, and manages ephemeral room state without duplicating those authorities.

Document-affecting collaboration writes use `commitTransaction` from `@lilac/history`; collaboration records only a deterministic transaction summary after the history commit succeeds.

## Protocol and local-first implementation

The candidate provides:

- provider-neutral user/agent actor identity with explicit access class and optional operation/task correlation;
- one document-specific authorization oracle shared across HTTP, realtime, MCP, and agent transports;
- separate lossy ephemeral presence and deterministic durable collaboration channels;
- finite cursor/viewport validation and bounded editing/status state;
- join-before-presence semantics, session generations, superseded-session refusal, reconnect snapshot/cursor recovery, and explicit connection outcomes;
- immediate revocation enforcement for protected realtime sessions;
- bounded ephemeral update rate and a 256-session local room ceiling;
- durable contiguous fact sequencing, duplicate-ID rejection, exact-order remote replay, and deterministic serialization;
- durable comments anchored to Lilac identities with bounded pagination and one-level thread semantics;
- explicit agent-work linkage requiring proof of operation, event, worker-task, and committed transaction identities;
- activity derived from durable collaboration facts rather than a separate mutable narrative store;
- deterministic local file persistence and restart recovery for durable collaboration state;
- no persistence of mouse cursor/presence as authoritative durable state;
- local connection signaling that distinguishes not-found, authentication expiry, authorization revocation, and update-ready build drift.

## Security and failure posture

- Unknown protocol fields and unsupported schema/capability values fail closed.
- Link grants cannot authorize `admin` or `durable-secret` capabilities.
- Document deletion returns terminal not-found behavior.
- Cross-document anchors and unproven node identities are rejected.
- Actor attribution cannot be substituted by a caller-supplied transaction actor.
- Agent-work correlation IDs require proof rather than trusting caller strings.
- Untrusted names/status/comment text remain data; no executable HTML is collaboration authority.
- Serialized log/state sizes, comment text/pages, editing ranges, room sessions, and ephemeral update rates are bounded.
- Local persistence hashes document IDs into filenames and rejects symbolic-link state files.
- No mandatory Yjs, Liveblocks, hosted realtime service, Postgres, model provider, paid API, telemetry, or cloud dependency is introduced.

## Local qualification before exact-head review

Focused Grain 5 suite:

- 26 tests passed;
- 0 failed;
- 0 skipped;
- covers authorization parity, revocation/deletion, join ordering, reconnect supersession, finite viewport enforcement, local follow/agent locate behavior, comments/thread semantics, explicit agent-work proof, history-only document mutation, durable sequencing, rate/session bounds, pagination, protocol drift rejection, local persistence, and restart recovery.

Repository `npm run check`:

- 171 tests passed;
- 0 failed;
- 0 skipped or canceled.

Dependency audit:

- `npm audit --audit-level=low`: 0 vulnerabilities.

Manual sensitive-pattern review found no embedded credential/API-key material. Matches were capability names such as `durable-secret`, test task/operation identifiers, and ordinary protocol metadata only.

## Remaining qualification gates

Before merge, still required on one exact candidate head:

- Jev exact-head qualification with zero blocking findings/tool errors;
- Alibaba Open Code Review exact-head qualification where supported;
- exact-head GitHub CI;
- normal merge commit only with exact-head protection;
- post-merge CI on canonical `main`;
- Issue #26 closeout only after canonical post-merge evidence.

Cubic, CodeRabbit, Qodo, and similar generated reviewer outputs are not qualification evidence.
