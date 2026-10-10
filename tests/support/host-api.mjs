// Clients for the studio host's HTTP API and its MCP endpoint, for the P08 tests that drive the
// host as the editor and an agent do, and a pool that closes every host a test starts.
import assert from "node:assert/strict";

import { startStudioHost } from "../../packages/studio-host/src/index.ts";

/** `call(method, path, body)` against the host at `base`, as the holder of `token`. */
export function client(base, token) {
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  };
}

/** An MCP client for an agent's `token`: `rpc(method, params)` and `tool(name, args)`. */
export function mcpClient(mcpUrl, token) {
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return (await response.json()).result;
  };
  return { rpc, tool: (name, args) => rpc("tools/call", { name, arguments: args }) };
}

/** Every host a test starts, so its `finally` closes them all, whatever failed. `options` go to each host. */
export function hostPool(now, options = {}) {
  const hosts = [];
  return {
    async open(root) {
      const host = await startStudioHost({ projectsRoot: root, now, ...options });
      hosts.push(host);
      return { host, call: client(host.url, host.token) };
    },
    /** Close one host and let it go, so a long test does not keep every host it closed. */
    async close(host) {
      const index = hosts.indexOf(host);
      if (index >= 0) hosts.splice(index, 1);
      await host.close();
    },
    async closeAll() {
      for (const host of hosts.splice(0)) await host.close().catch(() => {});
    },
  };
}

/** The JSON of a call that must succeed. */
export async function ok(promise, what) {
  const result = await promise;
  assert.equal(result.status, 200, `${what}: ${JSON.stringify(result.json)}`);
  return result.json;
}
