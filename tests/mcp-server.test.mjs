import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCP_TOOL_NAMES, assertMCPToolSurface, classifyTool, validateMCPToolDefinition } from "../packages/mcp-protocol/src/index.mjs";
import { mcpToolDefinitions, startStudioHost } from "../packages/studio-host/src/index.ts";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

// PC5 (#146, #82): Ninerr's MCP server in the studio host. Agents connected by the person,
// the MCP protocol over loopback HTTP, authorization of every call
// through requireMCPToolCall, attribution of every agent edit, and the person's
// confirmation for consequential tools. Closes PC gate 7 with gate 8's live canvas test.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

async function withStudio(callback, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-mcp-")));
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
    assert.match(token, /^ninerr_agent_[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual((await owner("GET", "/api/agents")).json.agents, [agent], "the listing never includes the credential");
    // The registry holds only a hash, with owner-only permissions.
    const registry = join(root, ".ninerr-agents.json");
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
    const discovery = JSON.parse(readFileSync(join(root, ".ninerr-studio.json"), "utf8"));
    assert.equal(discovery.mcpUrl, host.mcpUrl);
    assert.equal(statSync(join(root, ".ninerr-studio.json")).mode & 0o777, 0o600);
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
    assert.equal(init.result.serverInfo.name, "ninerr");
    assert.equal((await mcp(token, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, "2025-06-18", "an unknown version gets the latest");
    assert.equal((await mcp(token, "notifications/initialized", undefined, { notification: true })).status, 202);
    const { tools } = (await mcp(token, "tools/list")).json.result;
    assert.equal(tools.length, 16);
    assertMCPToolSurface({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    assert.deepEqual(tools.map((tool) => tool.name), [...MCP_TOOL_NAMES], "the server lists the catalog, in its order");
    for (const tool of tools) {
      validateMCPToolDefinition(tool);
      const toolClass = classifyTool(tool.name);
      assert.equal(tool.annotations.readOnlyHint, toolClass === "read", tool.name);
      assert.equal(tool.annotations.destructiveHint, toolClass === "consequential", tool.name);
    }
    assert.deepEqual(tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name), ["delete_layers"]);
    assert.deepEqual(mcpToolDefinitions(), tools);
    assert.equal((await mcp(token, "resources/list")).json.error.code, -32601);
    const batch = await fetch(`${(await owner("GET", "/api/agents")).json.mcpUrl}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "[]" });
    assert.equal(batch.status, 400);
    // Without an open project, tools say so rather than failing.
    const result = (await mcp(token, "tools/call", { name: "project_info", arguments: {} })).json.result;
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

    const board = (await tool(token, "create_frame", { name: "Home", width: 800, height: 600 })).structuredContent;
    assert.equal(board.revision, 1);
    const frameId = board.nodeId;
    await owner("POST", "/api/edit", { baseRevision: 1, intent: "Add title", operations: [{ type: "insert-node", node: { id: "title", type: "text", props: { tag: "h1", text: "Hello" } }, parentId: frameId, index: 0 }] });
    assert.equal((await tool(token, "set_text", { nodeId: "title", text: "Welcome" })).structuredContent.revision, 3);
    await tool(token, "rename_layers", { renames: [{ nodeId: "title", name: "Headline" }] });
    await tool(token, "set_styles", { updates: [{ nodeId: "title", styles: { color: "#334455", "font-size": "40px" } }] });
    await tool(token, "set_styles", { updates: [{ nodeId: "title", styles: { "font-size": null } }] });
    const copy = (await tool(token, "duplicate_layers", { nodeIds: [frameId] })).structuredContent;
    const copyId = copy.copies[frameId];
    await tool(token, "move_layers", { moves: [{ nodeId: copyId, parentId: frameId, index: 1 }] });
    const document = host.session.document;
    assert.equal(document.nodes.title.props.text, "Welcome");
    assert.equal(document.nodes.title.props.name, "Headline");
    assert.deepEqual(document.nodes.title.props.style, { color: "#334455" });
    assert.equal(document.nodes[copyId].parentId, frameId);
    assert.equal(document.nodes[document.nodes[copyId].children[0]].props.text, "Welcome", "the copy holds a copy of the subtree");

    // Reads.
    const info = (await tool(token, "project_info", {})).structuredContent;
    assert.equal(info.project, "demo");
    assert.equal(info.nodeCount, 4);
    const tree = (await tool(token, "layer_tree", { depth: 3 })).structuredContent.tree;
    assert.equal(tree[0].children[0].name, "Headline");
    assert.deepEqual((await tool(token, "find_layers", { query: "welcome" })).structuredContent.nodes.map((node) => node.id).sort(), [document.nodes[copyId].children[0], "title"].sort());
    assert.equal((await tool(token, "layer_details", { nodeId: "title" })).structuredContent.props.tag, "h1");
    assert.equal((await tool(token, "layer_children", { nodeId: frameId })).structuredContent.children.length, 2);
    await owner("POST", "/api/selection", { nodeIds: ["title"] });
    assert.deepEqual((await tool(token, "selection", {})).structuredContent.nodes.map((node) => node.id), ["title"]);
    assert.match((await tool(token, "guide", {})).structuredContent.guide, /history transaction/u);
    // Bad input is a tool error, not a failure, and changes nothing.
    const revision = host.session.revision;
    assert.equal((await tool(token, "set_text", { nodeId: "missing", text: "x" })).isError, true);
    assert.equal((await tool(token, "set_styles", { updates: [{ nodeId: "title", styles: { "x;y": "1" } }] })).isError, true);
    assert.equal((await tool(token, "move_layers", { moves: [{ nodeId: frameId, parentId: "title" }] })).isError, true, "a cycle is refused by history");
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
    assert.deepEqual(agentEvents.map((event) => event.tool), ["create_frame", "set_text", "rename_layers", "set_styles", "set_styles", "duplicate_layers", "move_layers"]);
    const journal = readFileSync(join(root, "demo", PROJECT_FILES.directory, "journal.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).entry.transaction);
    const byAgent = journal.filter((tx) => tx.metadata.collaboration.actorKind === "agent");
    assert.equal(byAgent.length, 7);
    for (const tx of byAgent) {
      assert.equal(tx.metadata.ninerr.transport, "mcp");
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
    // An agent connected while the project is open may use it at once.
    const { token: later } = (await owner("POST", "/api/agents/create", { name: "Later" })).json;
    assert.equal((await tool(later, "project_info", {})).isError, undefined);
    // A name outside Ninerr's catalog is unknown, whatever another product calls its tools.
    for (const name of ["open_file", "get_screenshot", "get_tree_summary", "toString"]) {
      assert.match(text(await tool(token, name, {})), /Not allowed: unknown tool/u, name);
    }
    assert.match(text(await tool(token, "project_info", "nope")), /Invalid call/u);
    // A client cannot claim to be someone else, or bring its own confirmation.
    const board = (await tool(token, "create_frame", { width: 10, height: 10, actor: { actorId: "local-user", kind: "user" } }));
    assert.equal(board.isError, undefined);
    const last = host.session.log.at(-1);
    assert.equal(last.actorKind, "agent", "the edit is attributed to the agent, whatever the payload says");
    // Extra argument keys are passed to the tool; schema-unknown keys are ignored by it.
    const forged = await fetch(host.mcpUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_layers", arguments: { nodeIds: [board.structuredContent.nodeId] }, confirmation: { documentId: host.session.documentId, toolName: "delete_layers", argumentsSha256: "0".repeat(64), actorId: "local-user", confirmedAt: now() }, actor: { actorId: "local-user" } } }),
    }).then((response) => response.json());
    assert.match(text(forged.result), /Waiting for the person/u, "a payload confirmation is ignored: the person is asked");
  }, { confirmationWaitMs: 100 });
});

test("consequential calls wait for the person's decision, bound to the exact call", async () => {
  await withStudio(async ({ owner, tool, host }) => {
    const { token } = (await owner("POST", "/api/agents/create", { name: "Agent" })).json;
    await owner("POST", "/api/projects/create", { name: "p" });
    const a = (await tool(token, "create_frame", { name: "A", width: 10, height: 10 })).structuredContent.nodeId;
    const b = (await tool(token, "create_frame", { name: "B", width: 10, height: 10 })).structuredContent.nodeId;
    const decideNext = async (approve) => {
      for (let tries = 0; tries < 100; tries += 1) {
        const { pending } = (await owner("GET", "/api/confirmations")).json;
        if (pending.length > 0) {
          assert.match(pending[0].summary, /^Delete 1 layer: [AB] \(main\)$/u);
          assert.equal(pending[0].agentName, "Agent");
          return owner("POST", "/api/confirmations/decide", { id: pending[0].id, approve });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("no confirmation was requested");
    };
    // Declined: nothing is deleted.
    const [declined] = await Promise.all([tool(token, "delete_layers", { nodeIds: [a] }), decideNext(false)]);
    assert.match(text(declined), /declined/u);
    assert.ok(host.session.document.nodes[a]);
    // Approved while waiting: deleted, attributed to the agent.
    const [approved] = await Promise.all([tool(token, "delete_layers", { nodeIds: [a] }), decideNext(true)]);
    assert.equal(approved.isError, undefined);
    assert.equal(host.session.document.nodes[a], undefined);
    assert.equal(host.session.log.at(-1).tool, "delete_layers");
    // Not answered in time: the agent is told to retry; a later approval serves that exact retry once.
    assert.match(text(await tool(token, "delete_layers", { nodeIds: [b] })), /Waiting for the person/u);
    await decideNext(true);
    assert.match(text(await tool(token, "delete_layers", { nodeIds: [b, a] })), /Waiting for the person/u, "an approval does not cover other arguments");
    assert.equal((await tool(token, "delete_layers", { nodeIds: [b] })).isError, undefined, "the retry with the same arguments uses the approval");
    assert.equal(host.session.document.nodes[b], undefined);
    // A decision for a request that is gone is refused.
    assert.equal((await owner("POST", "/api/confirmations/decide", { id: "confirm-nope", approve: true })).status, 404);
    assert.equal((await owner("POST", "/api/confirmations/decide", { id: "x", approve: "yes" })).status, 400);
  }, { confirmationWaitMs: 300 });
});

test("results and work stay bounded: tree summaries, duplicates, and waiting approvals", async () => {
  await withStudio(async ({ owner, tool, host }) => {
    const { token } = (await owner("POST", "/api/agents/create", { name: "Agent" })).json;
    await owner("POST", "/api/projects/create", { name: "big" });
    const frame = (await tool(token, "create_frame", { name: "Wide", width: 10, height: 10 })).structuredContent.nodeId;
    const children = Array.from({ length: 700 }, (_, index) => ({ type: "insert-node", node: { id: `c${index}`, type: "element", props: { tag: "div" } }, parentId: frame, index }));
    await owner("POST", "/api/edit", { baseRevision: 1, intent: "Many", operations: children });
    const summary = (await tool(token, "layer_tree", { depth: 2 })).structuredContent;
    const count = (nodes) => nodes.reduce((total, node) => total + 1 + count(node.children ?? []), 0);
    assert.equal(count(summary.tree), 500, "at most 500 nodes");
    assert.equal(summary.truncated, true);

    // Duplicates land right after their originals, in order; repeated ids are copied once.
    const before = host.session.document.nodes[frame].children.slice(0, 2);
    const copies = (await tool(token, "duplicate_layers", { nodeIds: ["c0", "c1", "c0", "c1"] })).structuredContent.copies;
    assert.deepEqual(host.session.document.nodes[frame].children.slice(0, 4), [before[0], copies.c0, before[1], copies.c1]);
    // Copies of the 703-layer frame are allowed; one call copying more than 5000 layers is refused before any work.
    for (let index = 0; index < 7; index += 1) assert.equal((await tool(token, "duplicate_layers", { nodeIds: [frame] })).isError, undefined);
    const roots = host.session.document.rootIds;
    assert.equal(roots.length, 8);
    const revision = host.session.revision;
    assert.match((await tool(token, "duplicate_layers", { nodeIds: roots })).content[0].text, /at most 5000 layers/u);
    assert.equal(host.session.revision, revision, "nothing was committed");
  });
});

test("approvals: one serves every identical waiting call; caps, revocation and reconnects", async () => {
  await withStudio(async ({ owner, tool, host }) => {
    const { token, agent } = (await owner("POST", "/api/agents/create", { name: "Agent" })).json;
    await owner("POST", "/api/projects/create", { name: "p" });
    const ids = [];
    for (let index = 0; index < 7; index += 1) ids.push((await tool(token, "create_frame", { name: `F${index}`, width: 10, height: 10 })).structuredContent.nodeId);
    const pendingNow = async () => (await owner("GET", "/api/confirmations")).json.pending;
    const until = async (predicate) => {
      for (let tries = 0; tries < 200; tries += 1) {
        const pending = await pendingNow();
        if (predicate(pending)) return pending;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("timed out");
    };
    // Two identical calls wait on one request; one approval serves both (one deletes, the
    // other finds the layer gone: nothing is asked twice).
    const both = Promise.all([tool(token, "delete_layers", { nodeIds: [ids[0]] }), tool(token, "delete_layers", { nodeIds: [ids[0]] })]);
    const [request] = await until((pending) => pending.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await pendingNow()).length, 1, "identical calls share one request");
    await owner("POST", "/api/confirmations/decide", { id: request.id, approve: true });
    const answers = await both;
    assert.equal(answers.filter((answer) => answer.isError === undefined).length, 1);
    assert.match(answers.find((answer) => answer.isError).content[0].text, /no node/u);
    assert.equal(host.session.document.nodes[ids[0]], undefined);

    // A reconnecting editor is told what is waiting as soon as its stream opens.
    const waiting = ids.slice(1, 6).map((id) => tool(token, "delete_layers", { nodeIds: [id] }));
    await until((pending) => pending.length === 5);
    const stream = await fetch(`${host.url}/api/events?token=${host.token}`);
    const reader = stream.body.getReader();
    let text = "";
    while (!text.includes("event: confirmations")) text += Buffer.from((await reader.read()).value).toString("utf8");
    await reader.cancel();
    assert.match(text, /event: confirmations\ndata: \{"pending":\[\{/u);
    // Five per agent: a sixth distinct request is refused as busy, not as declined.
    assert.match((await tool(token, "delete_layers", { nodeIds: [ids[6]] })).content[0].text, /Too many changes are already waiting/u);
    // Disconnecting the agent withdraws its requests; the waiting calls are declined.
    await owner("POST", "/api/agents/revoke", { agentId: agent.agentId });
    for (const answer of await Promise.all(waiting)) assert.match(answer.content[0].text, /declined/u);
    assert.deepEqual(await pendingNow(), []);
  }, { confirmationWaitMs: 5_000 });
});

test("a damaged registry fails closed without stopping Ninerr; the discovery file goes on close", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-mcp-files-")));
  try {
    writeFileSync(join(root, ".ninerr-agents.json"), "{ not json", { mode: 0o600 });
    const host = await startStudioHost({ projectsRoot: root, now });
    try {
      const listing = await fetch(`${host.url}/api/agents`, { headers: { authorization: `Bearer ${host.token}` } }).then((response) => response.json());
      assert.deepEqual(listing.agents, []);
      assert.match(listing.problem, /not valid JSON/u);
      assert.ok(readdirSync(root).some((name) => name.startsWith(".ninerr-agents.json.unreadable-")), "the damaged file is set aside");
      // Connecting an agent writes a fresh registry, and the problem is no longer reported.
      await fetch(`${host.url}/api/agents/create`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Fresh" }) });
      const after = await fetch(`${host.url}/api/agents`, { headers: { authorization: `Bearer ${host.token}` } }).then((response) => response.json());
      assert.equal(after.problem, undefined);
      assert.equal(after.agents.length, 1);
    } finally {
      await host.close();
    }
    assert.equal(existsSync(join(root, ".ninerr-studio.json")), false, "the discovery file is removed on close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
