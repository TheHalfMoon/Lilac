import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertLoopbackUrl, discoverMcpUrl, startStudioHost } from "../packages/studio-host/src/index.ts";

// PC5 (#146, #82): the stdio MCP relay. A stdio MCP client runs scripts/ninerr-mcp.mjs, which
// finds the running host through its discovery file and forwards each line to the host's
// MCP endpoint with the agent's credential, on loopback only.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

async function withStudio(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-relay-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const owner = (method, path, body) => fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
  try {
    await callback({ root, host, owner });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("the stdio relay forwards a stdio MCP client to the running host, and only on loopback", async () => {
  for (const bad of ["http://example.com/mcp", "https://127.0.0.1:1/mcp", "http://127.0.0.1:1/other", "http://user:pw@127.0.0.1:1/mcp", "http://10.0.0.1:1/mcp", "file:///mcp"]) {
    assert.throws(() => assertLoopbackUrl(bad), /only connects/u, bad);
  }
  assert.equal(assertLoopbackUrl("http://localhost:4123/mcp"), "http://localhost:4123/mcp");
  await withStudio(async ({ root, host, owner }) => {
    assert.equal(discoverMcpUrl(root), host.mcpUrl, "the discovery file names the running host");
    const { token } = (await owner("POST", "/api/agents/create", { name: "Relay agent" })).json;
    await owner("POST", "/api/projects/create", { name: "relay" });
    const child = spawn(process.execPath, ["scripts/ninerr-mcp.mjs", "--projects", root], { env: { ...process.env, NINERR_MCP_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_frame", arguments: { name: "From stdio", width: 320, height: 200 } } },
    ];
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    child.stdin.write("not json\n");
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    const answers = out.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(answers.length, 3, "two answers and a parse error; the notification has none");
    const byId = Object.fromEntries(answers.filter((answer) => answer.id !== null).map((answer) => [answer.id, answer]));
    assert.equal(byId[1].result.serverInfo.name, "ninerr");
    assert.equal(byId[2].result.structuredContent.revision, 1);
    assert.equal(answers.find((answer) => answer.id === null).error.code, -32700);
    // Without a credential, the relay refuses to start.
    const bare = spawn(process.execPath, ["scripts/ninerr-mcp.mjs", "--projects", root], { env: { ...process.env, NINERR_MCP_TOKEN: "" } });
    let err = "";
    bare.stderr.on("data", (chunk) => {
      err += chunk;
    });
    assert.equal(await new Promise((resolve) => bare.on("close", resolve)), 2);
    assert.match(err, /NINERR_MCP_TOKEN/u);
  });
});

test("a discovery file left by a Ninerr that is no longer running is not followed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-relay-stale-")));
  try {
    assert.throws(() => discoverMcpUrl(root), /not running/u, "no file");
    writeFileSync(join(root, ".ninerr-studio.json"), JSON.stringify({ version: 1, url: "http://127.0.0.1:9", mcpUrl: "http://127.0.0.1:9/mcp", pid: 2 ** 22 + 4321, nonce: "x" }), { mode: 0o600 });
    assert.throws(() => discoverMcpUrl(root), /not running/u, "a dead pid");
    writeFileSync(join(root, ".ninerr-studio.json"), JSON.stringify({ version: 1, url: "http://10.0.0.1:9", mcpUrl: "http://10.0.0.1:9/mcp", pid: process.pid, nonce: "x" }), { mode: 0o600 });
    assert.throws(() => discoverMcpUrl(root), /only connects/u, "a non-loopback address");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
