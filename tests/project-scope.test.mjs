import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "../packages/studio-web/src/client.mjs";
import { hostPool, mcpClient, ok } from "./support/host-api.mjs";

// #260: a change is applied only to the project it was made for. The studio host has one open
// project, and another tab or client can open a different one at any moment, often at the
// same revision (every new project starts at 0). The editor names its project in every
// request (X-Ninerr-Project) and the host refuses a change made for another; an agent's
// change is refused once the open project is not the one it last connected to or read.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();

/** A client of `host` that names `project` in every request, as the editor does. */
const named = (host, project) => async (method, path, body) => {
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "x-ninerr-project": encodeURIComponent(project), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

async function withHost(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-scope-")));
  const pool = hostPool(now);
  try {
    const { host, call } = await pool.open(root);
    return await callback({ host, call, root });
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

const insert = (id, baseRevision) => ({ baseRevision, intent: `Add ${id}`, operations: [{ type: "insert-node", node: { id, type: "text", props: { text: id } }, parentId: null }] });

test("an editor's change made for one project is refused once another is open, and changes nothing (#260)", () => withHost(async ({ host, call, root }) => {
  await ok(call("POST", "/api/projects/create", { name: "alpha" }));
  const alpha = named(host, "alpha");
  await ok(alpha("POST", "/api/edit", insert("first", 0)), "a change named for the open project");
  // Another tab opens beta, at revision 1 like alpha.
  await ok(call("POST", "/api/projects/create", { name: "beta" }));
  await ok(call("POST", "/api/edit", insert("beta-1", 0)));
  const before = await ok(call("GET", "/api/document"));
  const refusals = [
    ["POST", "/api/edit", insert("meant-for-alpha", 1)],
    ["POST", "/api/undo", undefined],
    ["POST", "/api/redo", undefined],
    ["POST", "/api/revert", { transactionId: "tx-anything" }],
    ["POST", "/api/checkpoint", undefined],
    ["POST", "/api/selection", { nodeIds: ["first"] }],
    ["POST", "/api/import", { html: "<!doctype html><html><body><p>Alpha</p></body></html>", name: "Alpha page" }],
    ["POST", "/api/import/commit", { proposalId: "proposal-anything" }],
    ["POST", "/api/code/import", { code: "export function Alpha() { return <p>Alpha</p>; }" }],
    ["POST", "/api/codebase/connect", { folder: root }],
    ["POST", "/api/codebase/disconnect", {}],
  ];
  for (const [method, path, body] of refusals) {
    const refused = await alpha(method, path, body);
    assert.deepEqual([refused.status, refused.json?.error?.code], [409, "project-changed"], path);
    assert.match(refused.json.error.message, /made for project "alpha", but project "beta" is open now/u);
  }
  const after = await ok(call("GET", "/api/document"));
  assert.deepEqual([after.revision, after.document], [before.revision, before.document], "beta is unchanged");
  // Named for the open project, or not named (other API clients), a change goes through.
  await ok(named(host, "beta")("POST", "/api/edit", insert("named-beta", 1)));
  await ok(call("POST", "/api/edit", insert("unnamed", 2)));
  // A project name the host cannot decode is refused as a bad request.
  const garbled = await fetch(`${host.url}/api/edit`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", "x-ninerr-project": "%E0%A4%A" }, body: JSON.stringify(insert("garbled", 3)) });
  assert.equal(garbled.status, 400);
  assert.equal((await garbled.json()).error.code, "invalid-project-header");
  // With no project open, a named change is refused the same way.
  await ok(call("POST", "/api/projects/close"));
  const closed = await named(host, "beta")("POST", "/api/edit", insert("closed", 3));
  assert.deepEqual([closed.status, closed.json.error.code], [409, "project-changed"]);
}));

test("a project opened while a change's body is still arriving: the change is refused (#260)", () => withHost(async ({ host, call }) => {
  await ok(call("POST", "/api/projects/create", { name: "alpha" }));
  const body = JSON.stringify(insert("in-flight", 0));
  const answered = new Promise((resolve, reject) => {
    const url = new URL("/api/edit", host.url);
    const outgoing = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-ninerr-project": encodeURIComponent("alpha") } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(text) }));
    });
    outgoing.on("error", reject);
    // Half the body now; the rest after another tab opens beta.
    outgoing.write(body.slice(0, 10));
    setTimeout(async () => {
      try {
        await ok(call("POST", "/api/projects/create", { name: "beta" }));
        outgoing.end(body.slice(10));
      } catch (error) {
        reject(error);
      }
    }, 50);
  });
  const result = await answered;
  assert.deepEqual([result.status, result.json.error.code], [409, "project-changed"]);
  assert.deepEqual(Object.keys((await ok(call("GET", "/api/document"))).document.nodes), [], "beta got nothing");
}));

test("an agent cannot change a project it has not read since the open project changed (#260)", () => withHost(async ({ host, call }) => {
  await ok(call("POST", "/api/projects/create", { name: "alpha" }));
  const { token } = await ok(call("POST", "/api/agents/create", { name: "Agent" }));
  const agent = mcpClient(host.mcpUrl, token);
  await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scope", version: "1" } });
  const frame = await agent.tool("create_frame", { name: "In alpha", width: 10, height: 10 });
  assert.equal(frame.isError, undefined, "connected while alpha was open, it changes alpha");
  // Another tab opens beta.
  await ok(call("POST", "/api/projects/create", { name: "beta" }));
  for (const [name, args] of [["create_frame", { name: "Meant for alpha", width: 10, height: 10 }], ["delete_layers", { nodeIds: [frame.structuredContent.nodeId] }]]) {
    const refused = await agent.tool(name, args);
    assert.equal(refused.isError, true, name);
    assert.match(refused.content[0].text, /open project in Ninerr is now "beta", not "alpha".*Call project_info/su, name);
  }
  assert.deepEqual((await ok(call("GET", "/api/confirmations"))).pending, [], "a refused delete never asked the person");
  assert.deepEqual(Object.keys((await ok(call("GET", "/api/document"))).document.nodes), [], "beta got nothing");
  // Reading beta lets the agent change it; going back to alpha needs another read.
  const info = await agent.tool("project_info", {});
  assert.equal(info.isError, undefined);
  assert.equal((await agent.tool("create_frame", { name: "In beta", width: 10, height: 10 })).isError, undefined);
  await ok(call("POST", "/api/projects/open", { name: "alpha" }));
  assert.equal((await agent.tool("set_text", { nodeId: frame.structuredContent.nodeId, text: "x" })).isError, true);
  // The guide is not about a project, so reading it does not count.
  await agent.tool("guide", {});
  assert.equal((await agent.tool("set_text", { nodeId: frame.structuredContent.nodeId, text: "x" })).isError, true);
  await agent.tool("layer_tree", {});
  assert.equal((await agent.tool("set_text", { nodeId: frame.structuredContent.nodeId, text: "x" })).isError, undefined);
}));

test("the editor's client names the project it shows in every request (#260)", async () => {
  const seen = [];
  const win = { fetch: async (path, init) => { seen.push([path, init.headers["x-ninerr-project"]]); return { ok: true, status: 200, json: async () => ({}) }; } };
  const client = createClient("token", win);
  await client.get("/api/session");
  let project = "Café ünïcode";
  client.followProject(() => project);
  await client.post("/api/edit", {});
  project = null;
  await client.post("/api/projects/open", { name: "x" });
  assert.deepEqual(seen, [["/api/session", undefined], ["/api/edit", encodeURIComponent("Café ünïcode")], ["/api/projects/open", undefined]]);
  assert.equal(decodeURIComponent(seen[1][1]), "Café ünïcode");
});
