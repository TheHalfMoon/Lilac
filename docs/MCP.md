# Lilac and MCP

This page describes what Lilac's MCP layer provides today, and what it does not provide yet.

## Status

| Piece | State | Where |
| --- | --- | --- |
| Contract validation (client identity, transports, tool definitions, server config, tool results, tool-name drift) | Implemented | `packages/mcp-protocol/src/index.mjs` |
| Tool classification (read / write / consequential / unknown) | Implemented | `packages/mcp-protocol/src/paper-tools.mjs` |
| Tool-call authorization through the collaboration access oracle | Implemented, P06 gate 8 | `packages/mcp-protocol/src/authorization.mjs`, `tests/mcp-authorization.test.mjs` |
| A local MCP server (stdio or loopback HTTP), its transport, and the tool handlers | **Not implemented** | #82 |

There is no MCP endpoint to connect a client to yet. Nothing on this page describes a server you can run. The catalog entry `mcp-surface` in `packages/architecture` is a `stub` for this reason.

## Tool surface

`PAPER_MCP_TOOL_NAMES` records the 36-tool public surface observed on 2026-10-03 (`PAPER_MCP_OBSERVED_AT`). `diffPaperMCPTools` and `assertPaperMCPCompatibility` report exact drift from it, so upstream changes are detected rather than silently accepted. Transports are `stdio` and `http` (`MCP_TRANSPORTS`).

`classifyPaperTool(name)` assigns each tool one class:

| Class | Tools | Capability required |
| --- | --- | --- |
| read | the 21 read-only tools (except the workspace tools below), such as `get_selection`, `get_node_info`, `get_jsx`, `find_nodes`, `export` and `get_tokens` | `read` |
| write | for example `write_html`, `update_styles`, `move_nodes`, `set_text_content` and `create_tokens` | `document-write` |
| write | `set_comment_thread_status` | `comments` (an exception to the class default) |
| consequential | `delete_nodes` | `document-write` plus a confirmation |
| unknown | any other name | denied without consulting a policy |

The workspace tools `open_file`, `create_file`, `list_resources` and `rename_resource` act on files rather than the open document. No workspace access policy exists yet, so they are always denied.

## Authorizing a call

```js
import { authorizeMCPToolCall, requireMCPToolCall, mcpArgumentsSha256 } from "@lilac/mcp-protocol";

const decision = authorizeMCPToolCall(policy, {
  actor,             // the identity the server authenticated for this session
  toolName: "update_styles",
  arguments: { ... },// a JSON object, or absent
  at: "2026-10-07T12:00:00.000Z",
  linkGrantId,       // optional
  confirmation,      // required for consequential tools
});
// decision.outcome: "allowed" | "denied" | "confirmation-required" | "not-found"
```

`policy` is a collaboration document access policy, evaluated by `evaluateAccess` with transport `"mcp"`. A decision carries `toolClass`, `capability`, `documentId`, `policyRevision` and a `reason`; an unknown tool's name appears in it quoted and truncated. Besides `allowed` and `confirmation-required`, the outcomes are `denied`, and `not-found` for a deleted document. `requireMCPToolCall` throws `MCPAuthorizationError` (with `.decision`) unless the outcome is `allowed`.

Malformed input throws:
- **`MCPContractError`** for unsupported keys on the call or the confirmation, an empty `toolName`, or an `at` or `confirmedAt` value that is not a real ISO-8601 UTC instant. For a known tool, it also covers an `arguments` value that is not a JSON object.
- **`CollaborationValidationError`** from `evaluateAccess`, for a malformed `actor`, `policy` or `linkGrantId` on a known tool.

An unknown tool is denied as soon as `toolName` and `at` are read, before its arguments, actor or policy are looked at.

### Confirmation for consequential tools

A consequential call needs `confirmation: { documentId, toolName, argumentsSha256, actorId, confirmedAt }`. It must meet all of these conditions:
- **It binds to this exact call on this document.** It names the same document and tool, and `argumentsSha256` equals `mcpArgumentsSha256(arguments)`, the SHA-256 of the canonical JSON of the arguments.
- **A person confirms it.** That is the calling user, or for an agent, the agent's owning user, and never the agent itself. The confirming person must hold `document-write` on the document through an actor grant; a link grant does not count.
- **It is recent.** `confirmedAt` is not after `at`, and it is within `MCP_CONFIRMATION_WINDOW_MS` (5 minutes) of it.

## Obligations on the future server (#82)

`authorizeMCPToolCall` cannot tell who built its inputs. A server built on it must:
- take `actor` from its own authenticated session; for an agent, `ownerActorId` must be an authenticated user;
- produce `confirmation` from its own confirmation flow with that person;
- never take either from the MCP client's request payload;
- apply every mutation as a history transaction with agent attribution through collaboration, and grant no ambient filesystem or network authority. Loopback HTTP must go through `@lilac/network-policy` local-only decisions.
