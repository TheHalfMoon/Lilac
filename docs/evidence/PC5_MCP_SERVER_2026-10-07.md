# PC5: MCP server and authorization integration

PC5 adds Lilac's local MCP server inside the studio host, with a stdio relay. It closes two PC gates:
- **Gate 7, the MCP server and authorization integration (#82):** a stdio relay and loopback HTTP, every call through `requireMCPToolCall`, and the confirmation flow for consequential tools. This discharges the server obligations P06 G8 recorded on #82.
- **Gate 8:** MCP and agent mutations are visible live on the canvas.

## Design

**Where it runs.** The server runs in the studio host, not as a second process. Agent edits therefore go through the host's single writer and the persistence lock, exactly like the editor's. Each one is a history transaction committed by `StudioSession.edit` with the agent as the actor.

**Transport:**
- `POST /mcp` speaks MCP Streamable HTTP in its request/response form. One JSON-RPC message gets one JSON answer, and a notification gets 202. There is no server-initiated stream (GET returns 405) and no batches (400), and it listens on the host's loopback listener, so the Host and Origin checks apply.
- Protocol versions 2025-06-18, 2025-03-26 and 2024-11-05 are supported. The supported version the client requests is used; anything else gets the latest.
- The methods are `initialize`, `ping`, `tools/list` and `tools/call`.

**stdio relay** (`packages/studio-host/src/relay.ts`, `scripts/lilac-mcp.mjs`):
- **Running it.** An MCP client runs `node scripts/lilac-mcp.mjs --projects <folder>` with `LILAC_MCP_TOKEN` set.
- **Finding the host.** The relay reads the host's discovery file `<projects>/.lilac-studio.json`: owner-only, holding the URL but no credential, and removed when the host closes. `--url` can be given instead.
- **Forwarding.** Each stdio line is forwarded with the credential, and each answer is written back as one line.
- **Limits.** It connects only to `http://` on a loopback address with path `/mcp`: no credentials in the URL, no redirects. It holds no authority of its own.

**Agents and their identity** (`agents.ts`):
- **Connecting.** The person connects an agent in the editor (Agents → Connect agent). The agent gets its own credential, `lilac_agent_` plus 256 random bits, shown once.
- **Storage.** Only its sha256 is stored, in `<projects>/.lilac-agents.json` (mode 0600, written atomically). An agent therefore keeps working across launches, and a leaked registry reveals no credential.
- **Identity.** An authenticated agent acts as `{ actorId: agent-<uuid>, kind: "agent", accessClass: "service", displayName, ownerActorId: <the person> }`, which comes from the credential, never from the payload.
- **Grants.** The open project grants every connected agent `read`, `document-write` and `comments`. Connecting and disconnecting update the grants immediately.
- **Not accepted.** The person's editor token is not an agent credential, and `/mcp` refuses it.

**Authorization (#82 obligations):**
- **Every call is checked first.** Every `tools/call` goes through `requireMCPToolCall(session.accessPolicy(), { actor, toolName, arguments, at })` before anything is dispatched, and the actor is the authenticated agent.
- **Refused calls.** Unknown tools, and the workspace tools (`open_file`, `create_file`, `list_resources`, `rename_resource`), are refused by it.
- **Unimplemented tools.** A Paper tool that Lilac does not implement is authorized first, then reported as not implemented.
- **Ignored payload fields.** `actor` or `confirmation` fields in the request payload are ignored.

**Confirmation flow** (`ConfirmationBroker`). A consequential tool (`delete_nodes`) that the oracle answers `confirmation-required` is handled as follows:
- The host records a request, bound to the agent, the tool, the document and the canonical argument hash, and broadcasts it to the editor.
- The editor shows "<agent> asks for your approval" with a summary ("Delete 1 layer: Landing") and Approve or Decline.
- The call waits up to 50 s for the person.
  - Approval yields a confirmation `{ documentId, toolName, argumentsSha256, actorId: <the person>, confirmedAt }`, made by the host and checked again by `requireMCPToolCall`. The person, as confirmer, must hold `document-write`.
  - If the person does not answer in time, the agent is told to call again with the same arguments. A later approval serves exactly that retry, once.
  - Requests and unused approvals expire after 5 minutes, and are dropped when their agent is disconnected or their project closes.

**Tools (15 of Paper's 36):**
- **Read:** `get_basic_info`, `get_tree_summary`, `get_node_info`, `get_children`, `find_nodes`, `get_selection` (what the person has selected in the editor) and `get_guide`. `finish_working_on_nodes` is also read-class and changes nothing.
- **Write:** `create_artboard`, `set_text_content`, `rename_nodes`, `update_styles`, `move_nodes` and `duplicate_nodes`.
- **Consequential:** `delete_nodes`.
- **Definitions.** The tool definitions are checked by `validateMCPServerConfig` when the module loads. Every name is a Paper-compatible tool name, and the annotations (`readOnlyHint`, `destructiveHint`) follow `classifyPaperTool`.
- **Errors.** A bad argument is a tool error (`isError`), not a protocol failure, and changes nothing.

**Attribution:**
- **Change events** carry `actorKind: "agent"`, the agent's name and the tool, so the editor's history shows "Claude Code · agent · update_styles · revision 2".
- **The journal** records collaboration's attribution (`actorKind`, `ownerActorId`) plus `metadata.lilac.transport: "mcp"`.

**Reverting agent changes.** The person can revert an agent's change from the history (`POST /api/revert`). The inverse is committed as the person's own change, linked with `revertOf`. Only an agent's latest change can be reverted, so its earlier ones stay consistent, and a conflicting later change is refused.

## Tests

**`tests/mcp-server.test.mjs`** (Node, 6 tests):
1. **Agents.**
   - Invalid names are refused, and the credential is shown once and is absent from the listing and the registry (mode 0600).
   - `/mcp` refuses no credential, the editor's token, a wrong credential, GET, and a foreign Origin.
   - The discovery file holds no credential. The agent survives a host restart, and revoking it takes effect at once.
2. **Protocol.**
   - Version negotiation, 202 for notifications, and `tools/list`, validated by `validateMCPServerConfig` and `validateMCPToolDefinition`, with Paper names and class-consistent annotations; only `delete_nodes` is destructive.
   - An unknown method gives -32601 and a batch gives 400.
   - With no project open, a tool says so.
3. **Tools and attribution.**
   - Every write tool, applied and checked in the document. Every read tool, including the editor's selection.
   - Bad input, including a cycle refused by history, changes nothing.
   - All 7 agent edits are on the change stream with the agent's id, name, project and operations, and in the journal with transport `mcp` and the owner.
   - The person reverts the agent's latest change. An earlier one is `not-revertible`.
4. **Authorization.**
   - Unknown, workspace and unimplemented tools; malformed arguments.
   - An agent connected while a project is open can use it at once.
   - A payload claiming the person's identity is still attributed to the agent.
   - A forged payload confirmation is ignored, and the person is asked.
5. **Confirmation.**
   - Decline: nothing is deleted. Approve while the call waits: deleted.
   - Time out, then a later approval serves the identical retry once, and does not cover other arguments.
   - A decision on an unknown request returns 404, and a non-boolean decision returns 400.
6. **Relay.**
   - Non-loopback, `https`, wrong-path, embedded-credential and `file:` URLs are refused.
   - A real `node scripts/lilac-mcp.mjs` child process relays initialize, a notification (no answer), a tool call that commits, and a parse error.
   - Without a credential, the relay exits with 2.

**`tests/editor-browser.test.mjs` test 8** (Chromium, gate 8):
- The person connects an agent in the editor, and the credential and endpoint are shown once.
- The agent's `create_artboard` and `update_styles` calls appear live on the canvas and in the layers tree. The history attributes them to "Claude Code · agent" with the tool.
- The agent's `get_selection` sees what the person clicked in the tree.
- `delete_nodes` opens the approval dialog in the editor. Decline keeps the layer. Approve deletes it, and the canvas drops it.
- The person reverts the delete from the history, and it is attributed to them.
- There are no foreign requests and no page errors.

This test also found and fixed two real defects:
- an agent connected after the project opened had no grant until reopen;
- a new request arriving before the previous decision's answer had its dialog closed by the old handler.

## Catalog

- **`mcp-surface`** keeps its owner, `@lilac/mcp-protocol`, and now depends on `studio-host`. It stays `stub`, because 15 of 36 tools are implemented: screenshots, JSX export, tokens, comments and HTML import are later grains (PC6 brings code and import).
- **`studio-host`** now names the editor and the MCP endpoint.
