import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PAPER_MCP_TOOL_NAMES, classifyPaperTool, validateMCPServerConfig, validateMCPToolDefinition } from "../packages/mcp-protocol/src/index.mjs";
import { assertLoopbackUrl, mcpToolDefinitions, startStudioHost } from "../packages/studio-host/src/index.ts";

// PC5 (#146, #82): Lilac's MCP server in the studio host. Agents connected by the person,
// the MCP protocol over loopback HTTP and the stdio relay, authorization of every call
// through requireMCPToolCall, attribution of every agent edit, and the person's
// confirmation for consequential tools. Closes PC gate 7 with gate 8's live canvas test.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

async function withStudio(callback, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-mcp-")));
  const host = await startStudioHost({ projectsRoot: root, now, ...options });
  const owner = (method, path, body) => fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
  let id = 0;
  const mcp = (token, method, params, { notification = false } = {}) => fetch(host.mcpUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(notification ? {} : { id: ++id }) }),
  }).then(async (response) => ({ status: response.status, json: response.status === 202 ? null : await response.json() }));
  const tool = async (token, name, args) => (await mcp(token, "tools/call", { name, arguments: args })).json.result;
  try {
    await callback({ root, host, owner, mcp, tool });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const text = (result) => result.content[0].text;

test("the person connects agents; only an agent credential reaches MCP, and none is stored", async () => {
  await withStudio(async ({ root, host, owner, mcp }) => {
    assert.equal((await owner("POST", "/api/agents/create", { name: "" })).status, 400);
    assert.equal((await owner("POST", "/api/agents/create", { name: "<script>" })).status, 400);
    const created = await owner("POST", "/api/agents/create", { name: "Claude Code" });
    assert.equal(created.status, 200);
    const { agent, token, mcpUrl } = created.json;
    assert.equal(mcpUrl, host.mcpUrl);
    assert.match(token, /^lilac_agent_[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual((await owner("GET", "/api/agents")).json.agents, [agent], "the listing never includes the credential");
    // The registry holds only a hash, with owner-only permissions.
    const registry = join(root, ".lilac-agents.json");
    assert.equal(statSync(registry).mode & 0o777, 0o600);
    assert.ok(!readFileSync(registry, "utf8").includes(token));
    // MCP: no credential, the editor's token, a wrong credential, or a GET are refused.
    assert.equal((await mcp("nope", "ping")).status, 401);
    assert.equal((await mcp(host.token, "ping")).status, 401, "the person's editor token is not an agent credential");
    assert.equal((await mcp(`${token.slice(0, -1)}x`, "ping")).status, 401);
    assert.equal((await fetch(host.mcpUrl, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(host.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://evil.test" }, body: "{}" })).status, 403, "a foreign origin is refused");
    assert.equal((await mcp(token, "ping")).json.result !== undefined, true);
    // The discovery file tells relays where the host is, and holds no credential.
    const discovery = JSON.parse(readFileSync(join(root, ".lilac-studio.json"), "utf8"));
    assert.equal(discovery.mcpUrl, host.mcpUrl);
    assert.equal(statSync(join(root, ".lilac-studio.json")).mode & 0o777, 0o600);
    // A restarted host keeps the agent (the hash is persisted) under a new endpoint.
    await host.close();
    const again = await startStudioHost({ projectsRoot: root, now });
    try {
      const answer = await fetch(again.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      assert.equal(answer.status, 200);
      // Revoking takes effect at once.
      await fetch(`${again.url}/api/agents/revoke`, { method: "POST", headers: { authorization: `Bearer ${again.token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: agent.agentId }) });
      const revoked = await fetch(again.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
      assert.equal(revoked.status, 401);
    } finally {
      await again.close();
    }
  });
});

test("the MCP protocol: initialize, tools/list, notifications and errors", async () => {
  await withStudio(async ({ owner, mcp }) => {
    const { token } = (await owner("POST", "/api/agents/create", { name: "Agent" })).json;
    const init = (await mcp(token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json;
    assert.equal(init.result.protocolVersion, "2025-03-26", "a supported version is echoed");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, "lilac");
    assert.equal((await mcp(token, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, "2025-06-18", "an unknown version gets the latest");
    assert.equal((await mcp(token, "notifications/initialized", undefined, { notification: true })).status, 202);
    const { tools } = (await mcp(token, "tools/list")).json.result;
    assert.equal(tools.length, 15);
    validateMCPServerConfig({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    for (const tool of tools) {
      validateMCPToolDefinition(tool);
      assert.ok(PAPER_MCP_TOOL_NAMES.includes(tool.name), `${tool.name} is a Paper-compatible name`);
      const toolClass = classifyPaperTool(tool.name);
      assert.equal(tool.annotations.readOnlyHint, toolClass === "read", tool.name);
      assert.equal(tool.annotations.destructiveHint, toolClass === "consequential", tool.name);
    }
    assert.deepEqual(tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name), ["delete_nodes"]);
    assert.deepEqual(mcpToolDefinitions(), tools);
    assert.equal((await mcp(token, "resources/list")).json.error.code, -32601);
    const batch = await fetch(`${(await owner("GET", "/api/agents")).json.mcpUrl}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "[]" });
    assert.equal(batch.status, 400);
    // Without an open project, tools say so rather than failing.
    const result = (await mcp(token, "tools/call", { name: "get_basic_info", arguments: {} })).json.result;
    assert.equal(result.isError, true);
    assert.match(text(result), /No project is open/u);
  });
});

test("agents read and edit through tools; every edit is an attributed transaction the editor sees", async () => {
  await withStudio(async ({ root, host, owner, tool }) => {
    const { token, agent } = (await owner("POST", "/api/agents/create", { name: "Claude Code" })).json;
    await owner("POST", "/api/projects/create", { name: "demo" });
    // Watch the change stream as the editor does.
    const events = [];
    const stream = await fetch(`${host.url}/api/events?token=${host.token}`);
    const reader = stream.body.getReader();
    let buffer = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += Buffer.from(value).toString("utf8");
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (frame.includes("event: change")) events.push(JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)));
        }
      }
    })();

    const board = (await tool(token, "create_artboard", { name: "Home", width: 800, height: 600 })).structuredContent;
    assert.equal(board.revision, 1);
    const frameId = board.nodeId;
    await owner("POST", "/api/edit", { baseRevision: 1, intent: "Add title", operations: [{ type: "insert-node", node: { id: "title", type: "text", props: { tag: "h1", text: "Hello" } }, parentId: frameId, index: 0 }] });
    assert.equal((await tool(token, "set_text_content", { nodeId: "title", text: "Welcome" })).structuredContent.revision, 3);
    await tool(token, "rename_nodes", { renames: [{ nodeId: "title", name: "Headline" }] });
    await tool(token, "update_styles", { updates: [{ nodeId: "title", styles: { color: "#334455", "font-size": "40px" } }] });
    await tool(token, "update_styles", { updates: [{ nodeId: "title", styles: { "font-size": null } }] });
    const copy = (await tool(token, "duplicate_nodes", { nodeIds: [frameId] })).structuredContent;
    const copyId = copy.copies[frameId];
    await tool(token, "move_nodes", { moves: [{ nodeId: copyId, parentId: frameId, index: 1 }] });
    const document = host.session.document;
    assert.equal(document.nodes.title.props.text, "Welcome");
    assert.equal(document.nodes.title.props.name, "Headline");
    assert.deepEqual(document.nodes.title.props.style, { color: "#334455" });
    assert.equal(document.nodes[copyId].parentId, frameId);
    assert.equal(document.nodes[document.nodes[copyId].children[0]].props.text, "Welcome", "the copy holds a copy of the subtree");

    // Reads.
    const info = (await tool(token, "get_basic_info", {})).structuredContent;
    assert.equal(info.project, "demo");
    assert.equal(info.nodeCount, 4);
    const tree = (await tool(token, "get_tree_summary", { depth: 3 })).structuredContent.tree;
    assert.equal(tree[0].children[0].name, "Headline");
    assert.deepEqual((await tool(token, "find_nodes", { query: "welcome" })).structuredContent.nodes.map((node) => node.id).sort(), [document.nodes[copyId].children[0], "title"].sort());
    assert.equal((await tool(token, "get_node_info", { nodeId: "title" })).structuredContent.props.tag, "h1");
    assert.equal((await tool(token, "get_children", { nodeId: frameId })).structuredContent.children.length, 2);
    await owner("POST", "/api/selection", { nodeIds: ["title"] });
    assert.deepEqual((await tool(token, "get_selection", {})).structuredContent.nodes.map((node) => node.id), ["title"]);
    assert.match((await tool(token, "get_guide", {})).structuredContent.guide, /history transaction/u);
    // Bad input is a tool error, not a failure, and changes nothing.
    const revision = host.session.revision;
    assert.equal((await tool(token, "set_text_content", { nodeId: "missing", text: "x" })).isError, true);
    assert.equal((await tool(token, "update_styles", { updates: [{ nodeId: "title", styles: { "x;y": "1" } }] })).isError, true);
    assert.equal((await tool(token, "move_nodes", { moves: [{ nodeId: frameId, parentId: "title" }] })).isError, true, "a cycle is refused by history");
    assert.equal(host.session.revision, revision);

    // Attribution: in the change events, and durably in the journal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const agentEvents = events.filter((event) => event.actorKind === "agent");
    assert.equal(agentEvents.length, 7);
    for (const event of agentEvents) {
      assert.equal(event.actor, agent.agentId);
      assert.equal(event.actorName, "Claude Code");
      assert.equal(event.project, "demo");
      assert.ok(event.operations.length > 0, "events carry operations, so the canvas applies them");
    }
    assert.deepEqual(agentEvents.map((event) => event.tool), ["create_artboard", "set_text_content", "rename_nodes", "update_styles", "update_styles", "duplicate_nodes", "move_nodes"]);
    const journal = readFileSync(join(root, "demo", ".lilac", "journal.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).entry.transaction);
    const byAgent = journal.filter((tx) => tx.metadata.collaboration.actorKind === "agent");
    assert.equal(byAgent.length, 7);
    for (const tx of byAgent) {
      assert.equal(tx.metadata.lilac.transport, "mcp");
      assert.equal(tx.metadata.collaboration.ownerActorId, "local-user");
      assert.equal(tx.actor, agent.agentId);
    }
    assert.equal(JSON.stringify(journal).includes("ownerActorId"), true);

    // The person reverts the agent's latest change; earlier ones only after it.
    const latest = agentEvents.at(-1);
    assert.equal((await owner("POST", "/api/revert", { transactionId: agentEvents[0].transactionId })).json.error.code, "not-revertible");
    const reverted = (await owner("POST", "/api/revert", { transactionId: latest.transactionId })).json;
    assert.equal(reverted.actor, "local-user");
    assert.equal(reverted.revertOf, latest.transactionId);
    assert.equal(host.session.document.nodes[copyId].parentId, null, "the move is reverted");
    reader.cancel();
    await pump.catch(() => {});
  });
});

test("every call is authorized: unknown, workspace and unimplemented tools; payload identity is ignored", async () => {
  await withStudio(async ({ owner, tool, host }) => {
    const { token } = (await owner("POST", "/api/agents/create", { name: "Agent" })).json;
    await owner("POST", "/api/projects/create", { name: "p" });
    assert.match(text(await tool(token, "rm_rf", {})), /Not allowed: unknown tool/u);
    assert.match(text(await tool(token, "open_file", { path: "/etc/passwd" })), /Not allowed: open_file acts on the workspace/u);
    assert.match(text(await tool(token, "create_file", {})), /Not allowed/u);
    assert.match(text(await tool(token, "get_screenshot", {})), /does not implement get_screenshot/u, "a Paper tool Lilac lacks is authorized, then reported");
    assert.match(text(await tool(token, "get_basic_info", "nope")), /Invalid call/u);
    // A client cannot claim to be someone else, or bring its own confirmation.
    const board = (await tool(token, "create_artboard", { width: 10, height: 10, actor: { actorId: "local-user", kind: "user" } }));
    assert.equal(board.isError, undefined);
    const last = host.session.log.at(-1);
    assert.equal(last.actorKind, "agent", "the edit is attributed to the agent, whatever the payload says");
    // Extra argument keys are passed to the tool; schema-unknown keys are ignored by it.
    const forged = await fetch(host.mcpUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_nodes", arguments: { nodeIds: [board.structuredContent.nodeId] }, confirmation: { documentId: host.session.documentId, toolName: "delete_nodes", argumentsSha256: "0".repeat(64), actorId: "local-user", confirmedAt: now() }, actor: { actorId: "local-user" } } }),
    }).then((response) => response.json());
    assert.match(text(forged.result), /Waiting for the person/u, "a payload confirmation is ignored: the person is asked");
  }, { confirmationWaitMs: 100 });
});

test("consequential calls wait for the person's decision, bound to the exact call", async () => {
  await withStudio(async ({ owner, tool, host }) => {
    const { token } = (await owner("POST", "/api/agents/create", { name: "Agent" })).json;
    await owner("POST", "/api/projects/create", { name: "p" });
    const a = (await tool(token, "create_artboard", { name: "A", width: 10, height: 10 })).structuredContent.nodeId;
    const b = (await tool(token, "create_artboard", { name: "B", width: 10, height: 10 })).structuredContent.nodeId;
    const decideNext = async (approve) => {
      for (let tries = 0; tries < 100; tries += 1) {
        const { pending } = (await owner("GET", "/api/confirmations")).json;
        if (pending.length > 0) {
          assert.match(pending[0].summary, /^Delete 1 layer: [AB]$/u);
          assert.equal(pending[0].agentName, "Agent");
          return owner("POST", "/api/confirmations/decide", { id: pending[0].id, approve });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("no confirmation was requested");
    };
    // Declined: nothing is deleted.
    const [declined] = await Promise.all([tool(token, "delete_nodes", { nodeIds: [a] }), decideNext(false)]);
    assert.match(text(declined), /declined/u);
    assert.ok(host.session.document.nodes[a]);
    // Approved while waiting: deleted, attributed to the agent.
    const [approved] = await Promise.all([tool(token, "delete_nodes", { nodeIds: [a] }), decideNext(true)]);
    assert.equal(approved.isError, undefined);
    assert.equal(host.session.document.nodes[a], undefined);
    assert.equal(host.session.log.at(-1).tool, "delete_nodes");
    // Not answered in time: the agent is told to retry; a later approval serves that exact retry once.
    assert.match(text(await tool(token, "delete_nodes", { nodeIds: [b] })), /Waiting for the person/u);
    await decideNext(true);
    assert.match(text(await tool(token, "delete_nodes", { nodeIds: [b, a] })), /Waiting for the person/u, "an approval does not cover other arguments");
    assert.equal((await tool(token, "delete_nodes", { nodeIds: [b] })).isError, undefined, "the retry with the same arguments uses the approval");
    assert.equal(host.session.document.nodes[b], undefined);
    // A decision for a request that is gone is refused.
    assert.equal((await owner("POST", "/api/confirmations/decide", { id: "confirm-nope", approve: true })).status, 404);
    assert.equal((await owner("POST", "/api/confirmations/decide", { id: "x", approve: "yes" })).status, 400);
  }, { confirmationWaitMs: 300 });
});

test("the stdio relay forwards a stdio MCP client to the running host, and only on loopback", async () => {
  for (const bad of ["http://example.com/mcp", "https://127.0.0.1:1/mcp", "http://127.0.0.1:1/other", "http://user:pw@127.0.0.1:1/mcp", "http://10.0.0.1:1/mcp", "file:///mcp"]) {
    assert.throws(() => assertLoopbackUrl(bad), /only connects/u, bad);
  }
  assert.equal(assertLoopbackUrl("http://localhost:4123/mcp"), "http://localhost:4123/mcp");
  await withStudio(async ({ root, owner }) => {
    const { token } = (await owner("POST", "/api/agents/create", { name: "Relay agent" })).json;
    await owner("POST", "/api/projects/create", { name: "relay" });
    const child = spawn(process.execPath, ["scripts/lilac-mcp.mjs", "--projects", root], { env: { ...process.env, LILAC_MCP_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_artboard", arguments: { name: "From stdio", width: 320, height: 200 } } },
    ];
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    child.stdin.write("not json\n");
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    const answers = out.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(answers.length, 3, "two answers and a parse error; the notification has none");
    const byId = Object.fromEntries(answers.filter((answer) => answer.id !== null).map((answer) => [answer.id, answer]));
    assert.equal(byId[1].result.serverInfo.name, "lilac");
    assert.equal(byId[2].result.structuredContent.revision, 1);
    assert.equal(answers.find((answer) => answer.id === null).error.code, -32700);
    // Without a credential, the relay refuses to start.
    const bare = spawn(process.execPath, ["scripts/lilac-mcp.mjs", "--projects", root], { env: { ...process.env, LILAC_MCP_TOKEN: "" } });
    let err = "";
    bare.stderr.on("data", (chunk) => {
      err += chunk;
    });
    assert.equal(await new Promise((resolve) => bare.on("close", resolve)), 2);
    assert.match(err, /LILAC_MCP_TOKEN/u);
  });
});
