# Ninerr

Ninerr is a local-first design workspace for interfaces that are code. A design is a document of real HTML and CSS. Code components are first-class layers, and changes move both ways between the canvas and a codebase. People and AI agents edit the same document, and every change is an attributed history transaction.

## What is in this repository
- **The studio host** (`packages/studio-host`) is the single writer of an open project. It serves the editor on a loopback-only HTTP API, keeps history with undo and redo, and hosts the MCP endpoint for agents.
- **The editor** (`packages/studio-web`, `packages/canvas`, `packages/renderer`) is a browser editor with a layers tree, an inspector and live history. It renders the document in a script-free, sandboxed frame.
- **The document model, history and persistence** (`packages/document-model`, `packages/history`, `packages/persistence`) store projects locally. They use content-addressed objects and a hash-chained, append-only journal, with crash recovery and versioned migrations.
- **Design and code** (`packages/code-ir`, `packages/design-components`, and `packages/studio-host` for a connected codebase) cover:
  - JSX and TSX components brought in as layers, and any layer exported as a JSX component, over bounded JSX/TSX, CSS and Tailwind adapters;
  - components from a connected codebase folder brought in bound to their source;
  - reviewed edits written back to the files.
- **Agents** (`packages/mcp-protocol`, `packages/agent-runtime`, `packages/collaboration`) work through Ninerr's own MCP tools. Every call is authorized per document, and a person confirms destructive changes. See `docs/MCP.md`.
- **The desktop app** (`packages/desktop`) is Ninerr in its own sandboxed Electron window. See `docs/DESKTOP.md`.

`docs/ARCHITECTURE.md` describes the subsystems. The architecture catalog in `packages/architecture` records each one's status: implemented, stub (a delivered slice with planned work) or planned.

## Running it
Ninerr needs Node.js 22.18 or a later 22.x, or Node.js 24.11 or later. Installing fetches its dependencies; once installed, it needs no network or account.

```bash
npm ci --ignore-scripts
npm start
```

`npm start` runs the studio host and prints a link to the editor. Projects live in a "Ninerr Projects" folder in your home folder unless `NINERR_PROJECTS` or `npm start -- --projects <folder>` names another. `docs/DESKTOP.md` covers the projects folder and settings from earlier versions, and `docs/MIGRATION.md` covers converting older projects.

To connect an MCP client, run `npm run mcp`, with the agent credential Ninerr shows you set as `NINERR_MCP_TOKEN`.

`npm test` runs the test suite, and `npm run smoke` runs the offline smoke workflow.

## Documentation
- `docs/ARCHITECTURE.md`: the subsystems and how they fit together.
- `docs/DESKTOP.md`: the desktop app, its packages and how it is protected.
- `docs/MCP.md`: the MCP server, its tools and authorization.
- `docs/MIGRATION.md`: project format versions, and migrating a project from an earlier version.
- `docs/RELEASE.md`: what a release contains, how it is signed, and how to verify it.
- `SECURITY.md`: reporting a vulnerability, and the security boundaries.
- `CONTRIBUTING.md`: setting up, testing, and opening a pull request.
- `docs/CURRENT.md` and `docs/MASTER_PLAN.md`: the current state of the program, and the plan.

## License
Ninerr is licensed under the Apache License 2.0 (`LICENSE`).
- `THIRD_PARTY_NOTICES.md` lists the third-party software Ninerr uses and the notices it carries.
- `docs/provenance/LICENSE_REGISTER.json` is the audited register of every source and dependency.
- `docs/DONORS.md` records the projects Ninerr studied or drew on, and what came from each.
- `docs/provenance/ELECTRON_CORRESPONDING_SOURCE.json` binds the desktop app's Electron runtime to its exact corresponding source.
