# Ninerr and MCP

Ninerr runs an MCP server so that an agent can read and edit the open design document. This page covers what the server offers, how an agent connects to it, and how each call is authorized.

## Status

| Piece | State | Where |
| --- | --- | --- |
| The tool catalog and its classification (read / write / consequential / unknown) | Implemented | `packages/mcp-protocol/src/tools.mjs` |
| Contract validation (client identity, transports, tool definitions, server config, tool results, the server's tools against the catalog) | Implemented | `packages/mcp-protocol/src/index.mjs` |
| Tool-call authorization through the collaboration access oracle | Implemented | `packages/mcp-protocol/src/authorization.mjs`, `tests/mcp-authorization.test.mjs` |
| The MCP server: loopback HTTP inside the studio host, and its tools | Implemented | `packages/studio-host/src/mcp.ts`, `tests/mcp-server.test.mjs` |
| The stdio relay | Implemented | `packages/studio-host/src/relay.ts`, `scripts/ninerr-mcp.mjs`, `tests/mcp-relay.test.mjs` |

## Connecting an agent

1. In Ninerr, connect an agent. Ninerr shows its credential once.
2. Configure the MCP client to use one of the transports. Transports are `stdio` and `http` (`MCP_TRANSPORTS`).
   - **stdio:** run `node scripts/ninerr-mcp.mjs --projects <your Ninerr projects folder>` (or `npm run mcp`), with `NINERR_MCP_TOKEN` set to the credential. The relay finds the running Ninerr through the discovery file in the projects folder, or takes `--url`. It only connects to a loopback address.
   - **http:** send MCP's Streamable HTTP requests to `POST http://127.0.0.1:<port>/mcp` on Ninerr's loopback listener, with `Authorization: Bearer <credential>`. Each request carries one JSON-RPC message and gets one JSON answer.

The server identifies itself as `ninerr` and tells the agent to call `get_guide` first.

## Tools

`MCP_TOOL_NAMES` is the catalog: the 16 tools the server offers, and no others. The server checks its own definitions against it with `assertMCPToolSurface` when it loads. `classifyTool(name)` gives each tool its class:

| Class | Tools | Capability required |
| --- | --- | --- |
| read | `get_basic_info`, `get_tree_summary`, `get_node_info`, `get_children`, `find_nodes`, `get_selection`, `get_jsx`, `get_guide`, `finish_working_on_nodes` | `read` |
| write | `create_artboard`, `set_text_content`, `rename_nodes`, `update_styles`, `move_nodes`, `duplicate_nodes` | `document-write` |
| consequential | `delete_nodes` | `document-write` plus a confirmation |
| unknown | any other name | denied without consulting a policy |

So the 9 read-only tools need only `read`.

- **Reading.**
  - `get_guide`: how Ninerr documents, layers and edits work; the server asks the agent to call it first.
  - `get_basic_info`: the open project and document.
  - `get_tree_summary`, `get_children` and `get_node_info`: the layers.
  - `find_nodes`: search by name or text.
  - `get_selection`: what the person has selected in the editor.
  - `get_jsx`: a layer as a JSX component.
- **Editing.** Every write is one history transaction, attributed to the agent. The person sees it live on the canvas and can undo it. `finish_working_on_nodes` changes nothing; it tells Ninerr the agent is done with some layers.
- **Deleting.** `delete_nodes` asks the person to approve the call in the editor. The call waits up to 50 seconds for an answer (`CONFIRMATION_WAIT_MS`). If no answer comes, the agent is told to call again with the same arguments, and an approval stays usable for that exact call for 5 minutes.

## Authorizing a call

```js
import { authorizeMCPToolCall, requireMCPToolCall, mcpArgumentsSha256 } from "@ninerr/mcp-protocol";

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

`policy` is a collaboration document access policy. `evaluateAccess` evaluates it with transport `"mcp"`.

A decision carries `toolClass`, `capability`, `documentId`, `policyRevision` and a `reason`. If the tool is unknown, its name appears in the reason, quoted and truncated.

The possible outcomes are:
- `allowed`;
- `confirmation-required`;
- `denied`;
- `not-found`, for a deleted document.

`requireMCPToolCall` throws `MCPAuthorizationError`, with `.decision`, unless the outcome is `allowed`.

Malformed input throws:
- **`MCPContractError`**, in these cases:
  - the call or the confirmation has unsupported keys;
  - `toolName` is empty;
  - `at` or `confirmedAt` is not a real ISO-8601 UTC instant;
  - for a known tool, `arguments` is not a JSON object.
- **`CollaborationValidationError`**, from `evaluateAccess`, when a known tool's `actor`, `policy` or `linkGrantId` is malformed.

An unknown tool is denied as soon as `toolName` and `at` are read. Its arguments, actor and policy are never looked at.

### Confirmation for consequential tools

A consequential call needs `confirmation: { documentId, toolName, argumentsSha256, actorId, confirmedAt }`. It must meet all of these conditions:
- **It binds to this exact call on this document.** It names the same document and tool, and `argumentsSha256` equals `mcpArgumentsSha256(arguments)`, the SHA-256 of the canonical JSON of the arguments.
- **A person confirms it.** That is the calling user, or for an agent, the agent's owning user, and never the agent itself. The confirming person must hold `document-write` on the document through an actor grant; a link grant does not count.
- **It is recent.** `confirmedAt` is not after `at`, and it is within `MCP_CONFIRMATION_WINDOW_MS` (5 minutes) of it.

## What the server guarantees

`authorizeMCPToolCall` cannot tell who built its inputs, so the server in `packages/studio-host/src/mcp.ts` meets these obligations:
- It takes `actor` from the agent the request's credential belongs to, and an agent's `ownerActorId` is the local person.
- `confirmation` comes only from the editor's own approval flow with that person.
- It never takes either from the MCP client's request payload.
- It authorizes every `tools/call` before anything is dispatched, including before a consequential call asks the person.
- It applies every edit through the studio host's single writer, as a history transaction attributed to the agent.
- It grants no ambient filesystem or network authority.

