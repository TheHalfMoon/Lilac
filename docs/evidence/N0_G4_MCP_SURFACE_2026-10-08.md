# N0-G4: Ninerr's own MCP tool surface

Issue: #190 (N0 umbrella).

## Before
The protocol package recorded another product's public MCP tool list: 36 names, an observation date and a version stamp. The server had to offer a subset of those names. The package also carried:
- drift checks against that list;
- the classification of all 36 tools, including tools Ninerr never served;
- denials for four workspace tools that Ninerr does not implement;
- a capability exception for a comment tool that Ninerr does not implement.

## After
- **The catalog.** `packages/mcp-protocol/src/tools.mjs` holds the 16 tools the server offers, each with its class: 9 read, 6 write, 1 consequential. `classifyTool` classifies only own names, so `toString` and `__proto__` are unknown.
- **The server check.** `assertMCPToolSurface` checks that a server's tools are exactly the catalog. The studio host runs it on its own definitions when it loads, so a tool cannot be added to the server without classifying it.
- **Authorization.** It needs no per-tool exceptions: every tool acts on the open document, and its class decides the capability.
- **Ninerr names.** The tools have their own names, such as `layer_tree`, `set_styles`, `create_frame` and `delete_layers`. Nothing was released under the earlier names, so no aliases are kept, and an earlier name is now an unknown tool. `docs/MCP.md` lists the mapping.
- **History.** Entries recorded before the change keep the tool name they were made with.
- **Docs.** `docs/MCP.md` now describes the server that exists: its transports, how to connect, the tools, authorization and the server's obligations. `tests/release-docs.test.mjs` checks the doc against the catalog, including the rename table.
