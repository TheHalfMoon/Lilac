# Impeccable Grain 1 Integration Evidence — 2026-10-03

## Scope

This record binds Lilac Grain 1 to the exact public Impeccable source and runtime used for deterministic design assurance.

- Upstream repository: `pbakaus/impeccable`
- Studied revision: `e103efe779e2dd01274dabae83531fef00bf2563`
- Public license observed at that revision: Apache-2.0
- npm package: `impeccable@4.1.0`
- source snapshot `ENGINE_VERSION`: `0.1.11`
- published `impeccable@4.1.0` native detector dependency: `0.1.5`
- Lilac issue: #17

No Impeccable product branding, agent-harness generated skill trees, hosted services, or unrelated runtime subsystems are copied into Lilac.

## Why the npm runtime is the integration boundary

At the pinned revision, Impeccable's package exposes a small Node launcher and platform-specific optional packages containing the native Rust detector binary. The detector runtime itself is implemented by the Cargo workspace. The upstream documentation states that `crates/foundation` defines the finding and rule-pack contracts, `crates/core` holds pure rule logic, `crates/html` handles static HTML, and `crates/browser` performs browser/CDP snapshot-based scanning.

Lilac therefore depends on the published `impeccable@4.1.0` package instead of vendoring the Rust monorepo. The studied source revision has already advanced its workspace `ENGINE_VERSION` to `0.1.11`, while the published npm package still pins platform binaries at `0.1.5`. Lilac records both facts separately and does not claim that the npm binary is byte-identical to the later source snapshot. Runtime behavior is qualified against the actually installed `0.1.5` binary.

## Proven upstream contracts used by Lilac

### Findings

The pinned upstream `Finding` shape serializes these core fields in order:

- `antipattern`
- `name`
- `description`
- `severity`
- `category`
- `file`
- `line`
- `snippet`
- optional `advisory`
- optional extra keys

Lilac normalizes this into a stable project-owned finding contract with:

- namespaced `ruleId` (`impeccable/<upstream-id>`)
- `severity` (`error`, `warning`, `info`)
- original upstream severity
- evidence
- location
- fixability
- provenance pinned to the exact upstream revision and package versions

### CLI exit and JSON behavior

A local probe against `impeccable@4.1.0` confirmed:

- `detect --json` writes a JSON array to stdout;
- exit `0` means the scan completed with no primary findings;
- exit `2` means the scan completed with primary findings;
- the published runtime reports the same finding fields described by the pinned source contract.

Lilac treats exit `0` and `2` as successful scans. Any other exit is a detector failure.

### Rule packs

The pinned upstream source provides a namespaced downstream rule-pack model and refuses collisions with built-in rule IDs. Lilac mirrors this safety property in its own JS boundary:

- `impeccable/*` is reserved for upstream findings;
- Lilac and future plugins use separate namespaces;
- duplicate full rule IDs are rejected;
- local rules run through the same deterministic normalization, policy, sorting, and deduplication path.

Lilac does not claim that its JavaScript rule-pack object is the original Rust `RulePack` trait. It is a project-owned compatibility boundary derived from the public behavior and architecture.

## Safety and determinism decisions

- Source/static adapters write only to a private temporary directory and delete it in `finally`.
- Temporary paths are replaced by the caller's virtual path before results leave the adapter.
- Upstream scans always use `--no-config`, so a user's unrelated `.impeccable` config, ignores, or `DESIGN.md` cannot silently change Lilac's deterministic result.
- No shell is used when spawning the detector.
- Inline text, snapshot size, snapshot element count, detector output size, and detector runtime have explicit limits.
- Browser scans accept only absolute HTTP(S) URLs, reject credentials, and reject localhost/private-network targets unless the caller explicitly sets `allowPrivateNetwork: true`.
- Static HTML is scanned as file data. Scripts in supplied HTML are not executed by Lilac.
- The serialized browser-snapshot adapter is an explicit seam: it accepts pinned-engine findings or a caller-provided `scanSnapshot` implementation, then applies the same normalization and Lilac rule packs. Lilac does not falsely claim the npm CLI exposes a direct serialized-snapshot command.

## Initial Lilac invariants

Grain 1 introduces project-owned deterministic checks for two canonical surfaces.

### Source binding

A `source-binding` document node:

- must have a non-empty `props.sourceId`;
- must resolve `sourceId` when `document.metadata.sources` is present;
- must have a non-empty `props.targetNodeId` resolving to another existing node;
- may have `props.range`, which must contain safe integer offsets with `0 <= start <= end`.

### Design-system token consistency

When declared, `document.metadata.designSystem.tokens` must be a plain object. Every `token-reference` node must contain a non-empty `props.tokenId` and resolve it against that registry.

These are marked structural invariants. Policy cannot disable them or lower their severity. An explicit waiver remains visible in output and requires `acknowledgeInvariant: true` plus a reason.

## Dependency and redistribution posture

Lilac does not commit Impeccable's native binary or Rust source. The dependency is resolved from npm at the exact package version and carries its own Apache-2.0 license. `THIRD_PARTY_NOTICES.md` records the upstream attribution and pin.

If Lilac later distributes bundled Impeccable object code, the release packaging must retain the Apache-2.0 license and applicable notices.

## Qualification targets

Grain 1 is complete only after all of the following are proven on one exact PR head:

- syntax checks;
- all existing Lilac tests;
- design-assurance unit tests;
- real local `impeccable@4.1.0` static-HTML smoke test;
- deterministic repeated-result test;
- policy/invariant tests;
- malformed input tests;
- Jev qualification;
- Alibaba Open Code Review qualification or a documented unsupported-surface fallback;
- exact-head GitHub CI;
- normal merge commit;
- post-merge CI on canonical `main`.
