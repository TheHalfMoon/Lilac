# Ninerr MCP Protocol

This package defines Ninerr's MCP tool surface and the rules every call to it is judged by.

- `MCP_TOOL_NAMES` is the catalog: the 16 tools Ninerr's MCP server offers. `classifyTool(name)` gives each one's class (read, write or consequential); any other name is unknown.
- `diffMCPTools` and `assertMCPToolSurface` check that a server's tool list is exactly the catalog. The studio host checks its own definitions with them when it loads.
- Runtime validators cover client identity, transports, tool definitions, server configuration, tool results and duplicate definitions.
- `authorizeMCPToolCall` and `requireMCPToolCall` decide each call through the collaboration access oracle. A consequential call also needs the person's confirmation of that exact call.

The server itself lives in `packages/studio-host/src/mcp.ts`. See [docs/MCP.md](../../docs/MCP.md).
