// A studio host in its own process, for tests that must kill it outright (a crash).
//   node tests/support/host-child.mjs <projects folder>
// It prints one JSON line with its URL, token and MCP URL, then runs until it is killed.
import { startStudioHost } from "../../packages/studio-host/src/index.ts";

const host = await startStudioHost({ projectsRoot: process.argv[2] });
process.stdout.write(`${JSON.stringify({ url: host.url, token: host.token, mcpUrl: host.mcpUrl })}\n`);
