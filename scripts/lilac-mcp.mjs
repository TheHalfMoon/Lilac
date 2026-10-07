#!/usr/bin/env node
// Lilac's stdio MCP relay. Configure an MCP client to run:
//
//   node scripts/lilac-mcp.mjs --projects <your Lilac projects folder>
//
// with the environment variable LILAC_MCP_TOKEN set to the agent credential Lilac showed
// when you connected the agent. `--url http://127.0.0.1:<port>/mcp` may be given instead of
// --projects. The relay forwards to the running Lilac on this computer only.
import { discoverMcpUrl, runRelay } from "../packages/studio-host/src/relay.ts";

function fail(message) {
  process.stderr.write(`lilac-mcp: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const token = process.env.LILAC_MCP_TOKEN;
if (typeof token !== "string" || token === "") fail("set LILAC_MCP_TOKEN to the agent credential from Lilac");
let mcpUrl;
try {
  const url = option("--url");
  const projects = option("--projects") ?? process.env.LILAC_PROJECTS;
  if (url !== undefined) mcpUrl = url;
  else if (projects !== undefined) mcpUrl = discoverMcpUrl(projects);
  else fail("give --projects <folder> or --url <Lilac MCP URL>");
  await runRelay({ mcpUrl, token, input: process.stdin, output: process.stdout });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
