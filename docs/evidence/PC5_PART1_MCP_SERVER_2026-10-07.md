# PC5 part 1: the MCP server in the studio host

**Why the split.** PC5 (#82, phase umbrella #146) is split into two PRs, like PC4: its full diff (about 134 KB) exceeds the Jev exact-head qualification's input limit.
- **Part 1** lands the server: the agent registry, the MCP endpoint and tools, authorization through `requireMCPToolCall`, the person's confirmation broker, revert of agent changes, and the host routes.
- **Part 2** lands the stdio relay and its CLI, the editor's Agents and approval dialogs, the history's Revert button, the live-canvas browser test (gate 8), the catalog update, and the full evidence document `docs/evidence/PC5_MCP_SERVER_2026-10-07.md`.

**The code is the PC5 branch's, unchanged** (`impl/pc5-mcp` at `580fb66`), with two exceptions:
- `index.ts` does not export the relay yet;
- the check script does not reference the relay files.

**Review.** That code went through PC5's ps-review: a security and correctness judge, then a delta for one must-fix (the tree-summary cap) and the items it raised (honest approval summaries, bounded waiting, reconnects, bounded duplicates, a registry that fails closed). The delta re-review is under way on the PC5 branch. Any further fix found by it lands with part 2 and is qualified there.

**Contents:**
- `packages/studio-host/src/agents.ts`: agents the person connects, each with its own credential. Only a hash is stored, in an owner-only registry. A damaged registry fails closed, and Lilac still starts.
- `packages/studio-host/src/mcp.ts`:
  - MCP over Streamable HTTP, request/response form;
  - 15 Paper-compatible tools;
  - every `tools/call` authorized by `requireMCPToolCall` with the authenticated agent as the actor;
  - consequential tools confirmed by the person through the host's own broker, never from the payload;
  - attributed history transactions.
- **Host routes:**
  - `POST /mcp`;
  - `GET`/`POST` under `/api/agents`;
  - `/api/confirmations` and `/decide`;
  - `/api/selection`;
  - `/api/revert`.
  - The discovery file names the endpoint for the relay (part 2).
- **Session:** agent grants, the access policy, `actorName` on change events, transport in the journal metadata, and person-only revert of an agent's latest change.

**Tests:** `tests/mcp-server.test.mjs`, 8 Node tests:
- agents and credentials;
- protocol conformance;
- the tools and their attribution in events and the journal;
- authorization (unknown, workspace and unimplemented tools; payload identity and confirmation ignored);
- the confirmation flow (decline, approve, timeout then retry, binding to the arguments);
- bounded results and work;
- approvals shared by identical calls, caps, revocation, and reconnects;
- the damaged registry.
