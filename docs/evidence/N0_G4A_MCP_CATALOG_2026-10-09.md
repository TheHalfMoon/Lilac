# N0-G4a: Ninerr's own MCP tool catalog

Issue: #190 (N0 umbrella). This is the first half of N0-G4. The second half, N0-G4b, gives the tools Ninerr names. The change is split because the whole of it exceeds the exact-head reviewer's context.

## Before
The protocol package recorded another product's public MCP tool list: 36 names, with an observation date and a version stamp. The server had to offer a subset of those names. The package also carried:
- drift checks against that list;
- the classification of all 36 tools, including tools Ninerr never served;
- denials for four workspace tools that Ninerr does not implement;
- a capability exception for a comment tool that Ninerr does not implement.

## After
- **The catalog.** `packages/mcp-protocol/src/tools.mjs` holds the 16 tools the server offers, each with its class: 9 read, 6 write and 1 consequential. `classifyTool` classifies only the catalog's own names, so `toString` and `__proto__` are unknown.
- **The surface check.** `assertMCPToolSurface` checks that a server's tools are exactly the catalog. The studio host runs it on its own definitions when it loads, so a tool cannot be added to the server without being classified.
- **Authorization.** No per-tool exceptions are needed: every tool acts on the open document, and its class decides the capability it needs.
- **Unknown names.** A name outside the catalog is unknown and denied. This includes the other product's tools that Ninerr never served, such as `get_screenshot`, `open_file` and `list_resources`.
- **Docs.** `docs/MCP.md` now describes the server that exists: its transports, how to connect, the tools, authorization and the server's obligations. `tests/release-docs.test.mjs` checks it against the catalog.

The tools keep the names they have today. N0-G4b renames them.

**Review follow-ups.** The architecture catalog's description of the MCP surface, the license register's Paper evidence note, and a server test title now describe the catalog. The `public-mcp-catalog` census rule is removed: it matched the deleted Paper list, and kept, it would have exempted new Paper text in the MCP package from the identity gate.
