# Security policy

## Supported versions

Ninerr has no tagged release yet. Security fixes land on `main`, and only the current `main` is supported.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do not open a public issue, pull request or discussion that describes one.

1. Use **Report a vulnerability** on this repository's **Security** tab. That is GitHub's private vulnerability reporting, which is enabled for this repository. Only you and the maintainers see the report.
2. If you cannot use it, open an issue titled "Private contact request". Give no technical details and do not say what it concerns. The maintainer will open a draft repository security advisory, invite you to it, and continue there privately.

Please include:
- the affected package or file and the commit;
- the steps or input that reproduce the problem;
- the impact as you understand it.

The maintainers aim to acknowledge a report within 7 days. Fixes are developed privately and published with an advisory that credits the reporter, unless the reporter asks not to be named.

## Scope

Ninerr is local-first. Its core needs no hosted service, model or account, and its security boundaries are:

| Boundary | Owner | Evidence |
| --- | --- | --- |
| Imported HTML, CSS and SVG keep no executable or fetch authority | `packages/import-stack`, `packages/intake` | `tests/malicious-corpus.test.mjs`, `tests/import-idempotence.test.mjs` |
| Network access is default-deny, with decisions made before and after DNS | `packages/network-policy` | `tests/network-policy.test.mjs`, `tests/sandbox-network.test.mjs`, `tests/import-network-policy.test.mjs`, `tests/browser-proxy.test.mjs`, `tests/offline-guarantee.test.mjs` |
| Filesystem confinement for projects, mirrors, worktrees and evidence stores (traversal, links, swapped directories) | `packages/persistence`, `packages/import-stack`, `packages/agent-supervisor`, `packages/delivery-governance`, `packages/collaboration` | `tests/sandbox-persistence.test.mjs`, `tests/sandbox-surfaces.test.mjs` |
| MCP tool calls are authorized per document, and consequential calls need a person's confirmation | `packages/mcp-protocol` | `tests/mcp-authorization.test.mjs` |
| Project files are integrity-checked (content-addressed objects, hash-chained journal, single-writer lock) and fail closed on damage or unknown versions | `packages/persistence` | `tests/persistence.test.mjs`, `tests/crash-recovery.test.mjs`, `tests/migration-compatibility.test.mjs` |
| Dependencies have known licenses and pinned integrity hashes | `scripts/sbom.mjs`, `scripts/license-policy.json` | `tests/sbom.test.mjs` |
| A connected codebase folder is used only by the person (never an agent): files are read and written only inside it (relative paths, no links, realpath-confined, bounded), and a write-back is the reviewed, three-way patch the person previewed, written atomically | `packages/studio-host/src/codebase.ts` | `tests/codebase.test.mjs` |
| The desktop window is isolated and sandboxed with no Node, may reach only Ninerr's host, and is granted no permission; the packaged runtime's fuses refuse running as Node, `NODE_OPTIONS` and `--inspect` | `packages/desktop`, `scripts/desktop/fuses.mjs` | `tests/desktop-shell.test.mjs`, `tests/desktop-package.test.mjs`, `scripts/smoke-desktop.mjs` |

The following are in scope:
- a way past any of these boundaries;
- a crash or hang from bounded input;
- a way to make Ninerr contact the network when its policy says it must not.

The following are out of scope:
- **Optional connectors and third-party services.** This covers a hosted crawler or a model provider that a user configures.
- **Third-party dependencies.** Report those upstream; tell us too if Ninerr's use makes the problem reachable.
- **An attacker who already runs code locally,** in the same process or user account. This includes starting the desktop app with Chromium switches such as `--remote-debugging-port`, which no fuse covers and which give the starter control of the editor.

The MCP server runs inside the studio host, over loopback HTTP and a stdio relay; `docs/MCP.md` describes its transports and authorization.
