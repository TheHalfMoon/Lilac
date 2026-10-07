# Security policy

## Supported versions

Lilac has no tagged release yet. Security fixes land on `main`, and only the current `main` is supported.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do not open a public issue, pull request or discussion that describes one.

1. Use GitHub's private vulnerability reporting on this repository: the **Security** tab, then **Report a vulnerability**.
2. If that option is not available, open a public issue titled "Security contact request" with no technical details, and a maintainer will arrange a private channel.

Please include:
- the affected package or file and the commit;
- the steps or input that reproduce the problem;
- the impact as you understand it.

The maintainers aim to acknowledge a report within 7 days. Fixes are developed privately and published with an advisory that credits the reporter, unless the reporter asks not to be named.

## Scope

Lilac is local-first. Its core needs no hosted service, model or account, and its security boundaries are:

| Boundary | Owner | Evidence |
| --- | --- | --- |
| Imported HTML, CSS and SVG keep no executable or fetch authority | `packages/import-stack`, `packages/intake` | `tests/malicious-corpus.test.mjs` (P06 gate 6), `tests/import-idempotence.test.mjs` |
| Network access is default-deny, with decisions made before and after DNS | `packages/network-policy` | `tests/offline-guarantee.test.mjs`, `tests/browser-proxy.test.mjs` |
| Filesystem confinement for projects, mirrors, worktrees and evidence stores (traversal, links, swapped directories) | `persistence`, `import-stack`, `agent-supervisor`, `delivery-governance`, `collaboration` | `tests/sandbox-*.test.mjs` (P06 gate 5) |
| MCP tool calls are authorized per document, and consequential calls need a person's confirmation | `packages/mcp-protocol` | `tests/mcp-authorization.test.mjs` (P06 gate 8) |
| Project files are integrity-checked (content-addressed objects, hash-chained journal, single-writer lock) and fail closed on damage or unknown versions | `packages/persistence` | `tests/persistence.test.mjs`, `tests/crash-recovery.test.mjs`, `tests/migration-compatibility.test.mjs` (gates 10 and 11) |
| Dependencies have known licenses and pinned integrity hashes | `scripts/sbom.mjs`, `scripts/license-policy.json` | `tests/sbom.test.mjs` (gate 9) |

The following are in scope:
- a way past any of these boundaries;
- a crash or hang from bounded input;
- a way to make Lilac contact the network when its policy says it must not.

The following are out of scope:
- **Optional connectors and reference-only donors.** This covers a hosted crawler or a model provider that a user configures.
- **Third-party dependencies.** Report those upstream; tell us too if Lilac's use makes the problem reachable.
- **Running code that was never imported.** This covers someone who already runs arbitrary code in the same process or user account.

There is no MCP server yet (#82). Reports about its future transport are welcome as design input.
