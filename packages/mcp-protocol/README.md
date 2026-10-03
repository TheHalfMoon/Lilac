# Lilac MCP Protocol

This package is Lilac's independent MCP compatibility boundary.

It is **not** recovered Paper private source. The current Paper-facing snapshot is reconstructed from:

- Paper's public Desktop MCP configuration.
- User-authorized live renderer contract inspection.
- Exact shipped Paper Desktop call sites and bridge behavior already recorded in Lilac evidence.

The snapshot is intentionally explicit so upstream contract drift is detectable rather than silently accepted.

`PAPER_MCP_TOOL_NAMES` records the 36-tool public surface observed on 2026-10-03. Runtime validators cover client identity, transports, tool definitions, server configuration, tool results, duplicate definitions, and exact tool-name drift.

Tool read/write/consequential classification mirrors the public MCP annotations observed at that baseline. Lilac may apply stricter policy above this compatibility layer.
