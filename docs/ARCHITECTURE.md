# Lilac Target Architecture

This document defines the target boundaries. The authorized Paper source intake may use different names and structure; P03 maps inherited code into these contracts incrementally rather than forcing a rewrite.

## Product surfaces

```text
apps/
  studio-web/        browser editor
  desktop/           native shell and local integrations
  mcp/               local/remote agent protocol host
  collab-server/     optional self-hosted collaboration service
  docs/              product/developer documentation

packages/
  document-model/    canonical versioned design graph
  document-codec/    deterministic serialization + migrations
  renderer/          HTML/CSS/SVG/media rendering
  canvas/            viewport, selection, transforms, snapping
  layout/            CSS layout semantics and constraints
  text/              rich text and typography model
  assets/            image/font/media asset graph
  components/        props, variants, slots, states
  tokens/            CSS variables, themes, design tokens
  history/           transactions, undo/redo, checkpoints
  persistence/       local and server storage adapters
  collaboration/     CRDT/operation transport abstraction
  code-ir/           canonical bridge between design and source ASTs
  code-adapters/     React/CSS/Tailwind/etc. adapters
  code-sync/         three-way reconciliation and patch generation
  importers/         DOM/URL/repository intake
  exporters/         code/image/video/document exports
  agents/            agent transactions, roles, attribution, policies
  mcp-protocol/      Lilac MCP tools/resources
  plugins/           capability/plugin contracts
  security/          sandbox, sanitization, capability policy
  visual-diff/       image/node/layout diff engine
  test-fixtures/     canonical round-trip and adversarial fixtures
```

## Canonical document graph

Every editable object has a stable ID and versioned typed node representation. Rendering must never be the only source of truth.

Minimum concepts:
- document;
- page;
- frame;
- group;
- element;
- text;
- vector;
- image/media;
- code-component instance;
- component definition;
- token/theme reference;
- interaction/state;
- asset reference;
- source binding.

Node mutations occur only through transactions. Transactions are the common unit for undo/redo, collaboration, agent attribution, visual history, and audit.

## Rendering contract

The renderer consumes the canonical graph and produces web semantics. The model stores intent; the renderer decides concrete DOM/CSS representation.

Rules:
- stable node → DOM identity mapping;
- no renderer-only state that cannot be serialized;
- explicit sandbox boundary for imported or generated markup;
- deterministic layout test fixtures;
- browser-engine differences documented where exact parity is impossible.

## Code synchronization

The core loop is:

```text
repository source
  → parser/AST adapter
  → Lilac Code IR
  → design graph/source bindings
  → visual edits
  → graph diff
  → Code IR patch
  → AST-aware source patch
  → formatter/typecheck/tests
  → accepted repository change
```

A generated patch must preserve unrelated source formatting, comments, imports, and semantics wherever the adapter can prove a safe transformation. Unsafe transformations must produce a conflict/abstention instead of silently rewriting a file.

## Agent runtime

Agents never mutate storage directly.

```text
agent/MCP client
  → auth + capability policy
  → intent/tool call
  → validation
  → transaction
  → document mutation
  → attribution + history
  → render/diff
```

Required controls:
- per-project permissions;
- read/write/tool capability scopes;
- cancellable operations;
- mutation size limits;
- explicit external-network permission;
- transaction provenance;
- rollback.

## Persistence

Persistence is adapter-based.

Local mode should support durable, zero-service project storage. Desktop may use a local database/filesystem; browser mode may use browser-native durable storage. Collaboration may add an optional server database, but local editing must not depend on it.

Document files include:
- schema version;
- content graph;
- asset references;
- source bindings;
- optional history checkpoints;
- integrity metadata.

## Collaboration

Do not choose a CRDT library until the donor baseline is inspected. The contract must support:
- concurrent node edits;
- presence/cursors;
- offline queue/reconnect;
- conflict visibility;
- actor attribution;
- server-optional local mode.

## Studio host

The PC phase adds one Node studio host (`@lilac/studio-host`). It composes persistence, history, collaboration and network-policy, and is the single writer of an open project. It serves the editor and a loopback-only API (127.0.0.1, a per-launch token, Host and Origin checks), and it hosts the MCP endpoint and its stdio relay. Hosting MCP here keeps the persistence single-writer lock intact.

Local web mode runs the host directly. The desktop shell starts the same host and owns its lifecycle, which is how the shell's "local MCP lifecycle" below is met.

## Desktop boundary

The desktop shell owns privileged operations:
- local filesystem/repository access;
- local MCP lifecycle;
- browser/webview bridge;
- local fonts;
- secure credential storage;
- native menus/shortcuts;
- update mechanism.

Web content must not receive unrestricted native capabilities.

## Security zones

1. Trusted Lilac application code.
2. Imported/generated document content.
3. Third-party plugin code.
4. Agent clients.
5. Local filesystem/repositories.
6. External network/services.

Every crossing requires an explicit interface and capability decision. Imported HTML, SVG, CSS, and remote assets are treated as untrusted.

## Architecture acceptance tests

- deterministic serialization fixture;
- 10,000-node edit/render benchmark;
- undo/redo transaction property test;
- malicious import fixture suite;
- design → code → design round-trip fixtures;
- agent transaction attribution test;
- offline persistence/recovery test;
- source patch non-interference test;
- collaboration convergence test once collaboration implementation is selected.
