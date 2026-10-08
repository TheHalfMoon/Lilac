#!/usr/bin/env node
// Ninerr's stdio MCP relay. Configure an MCP client to run:
//
//   node scripts/ninerr-mcp.mjs --projects <your Ninerr projects folder>
//
// with the environment variable NINERR_MCP_TOKEN set to the agent credential Ninerr showed
// when you connected the agent. `--url http://127.0.0.1:<port>/mcp` may be given instead of
// --projects. Without either, the projects folder is found as the app finds it. The relay
// forwards to the running Ninerr on this computer only.
import { LEGACY_MCP_TOKEN_ENV } from "../packages/studio-host/src/legacy.ts";
import { resolveProjectsFolder } from "../packages/studio-host/src/projects-folder.ts";
import { discoverMcpUrl, runRelay } from "../packages/studio-host/src/relay.ts";

function fail(message) {
  process.stderr.write(`ninerr-mcp: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
// MCP clients configured before the rename set the legacy variable; it is read, with a note.
let token = process.env.NINERR_MCP_TOKEN;
if ((token === undefined || token === "") && typeof process.env[LEGACY_MCP_TOKEN_ENV] === "string" && process.env[LEGACY_MCP_TOKEN_ENV] !== "") {
  token = process.env[LEGACY_MCP_TOKEN_ENV];
  process.stderr.write(`ninerr-mcp: note: ${LEGACY_MCP_TOKEN_ENV} is read because NINERR_MCP_TOKEN is not set; rename it in the MCP client's configuration\n`);
}
if (typeof token !== "string" || token === "") fail("set NINERR_MCP_TOKEN to the agent credential from Ninerr");
let mcpUrl;
try {
  const url = option("--url");
  if (url !== undefined) mcpUrl = url;
  else {
    const { path, note } = resolveProjectsFolder(option("--projects"));
    if (note !== null) process.stderr.write(`ninerr-mcp: note: ${note}\n`);
    mcpUrl = discoverMcpUrl(path);
  }
  await runRelay({ mcpUrl, token, input: process.stdin, output: process.stdout });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
