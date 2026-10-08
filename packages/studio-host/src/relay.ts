import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isLoopbackAddress } from "@ninerr/network-policy";

// The stdio MCP relay. An MCP client that speaks stdio (one JSON-RPC message per line)
// starts this; each message is forwarded to the running studio host's MCP endpoint with
// the agent's credential, and each answer is written back as one line. It holds no state
// and no authority of its own: the host authenticates the agent and authorizes every call.
// It only ever connects to a loopback address.

const MAX_LINE_BYTES = 1024 * 1024;

export interface RelayOptions {
  /** The host's MCP endpoint, e.g. http://127.0.0.1:41234/mcp. */
  mcpUrl: string;
  /** The agent credential Ninerr showed when the agent was connected. */
  token: string;
  input: Readable;
  output: Writable;
  fetch?: typeof fetch;
}

/** The MCP endpoint of the host running for `projectsRoot`, from its discovery file. */
export function discoverMcpUrl(projectsRoot: string): string {
  const path = join(projectsRoot, ".ninerr-studio.json");
  let info: any;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size > 4096) throw new Error("not a small regular file");
    // Only a file this user wrote: another local user could otherwise point the relay, and
    // the agent credential it sends, at their own server.
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) throw new Error("not this user's");
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Ninerr is not running for this projects folder (start Ninerr first)");
  }
  // A file left by a Ninerr that crashed names a port someone else may now hold.
  if (!Number.isSafeInteger(info?.pid) || info.pid <= 0 || !processAlive(info.pid)) throw new Error("Ninerr is not running for this projects folder (start Ninerr first)");
  return assertLoopbackUrl(info?.mcpUrl);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function assertLoopbackUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("the MCP URL is not a URL");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" || !(host === "localhost" || isLoopbackAddress(host)) || url.pathname !== "/mcp" || url.username !== "" || url.password !== "") {
    throw new Error("the relay only connects to a Ninerr MCP endpoint on this computer (http://127.0.0.1:<port>/mcp)");
  }
  return url.href;
}

const errorLine = (id: unknown, message: string) => JSON.stringify({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code: -32603, message } });

/** Relay until `input` ends; resolves once every answer has been written. */
export async function runRelay(options: RelayOptions): Promise<void> {
  const mcpUrl = assertLoopbackUrl(options.mcpUrl);
  const send = options.fetch ?? fetch;
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();
  const write = (line: string) => {
    options.output.write(`${line}\n`);
  };
  for await (const line of lines) {
    if (line.trim() === "") continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      write(errorLine(null, "message too large"));
      continue;
    }
    let id: unknown = null;
    try {
      id = JSON.parse(line)?.id ?? null;
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      continue;
    }
    const task = (async () => {
      try {
        const response = await send(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json", accept: "application/json" }, body: line, redirect: "error" });
        if (response.status === 202) return;
        const text = await response.text();
        if (response.headers.get("content-type")?.startsWith("application/json")) {
          // The host answers in JSON-RPC (including its errors); pass it through on one line.
          try {
            const answer = JSON.parse(text);
            if (answer?.jsonrpc === "2.0") {
              write(JSON.stringify(answer));
              return;
            }
            if (id !== null) write(errorLine(id, answer?.error?.message ?? `Ninerr answered ${response.status}`));
            return;
          } catch {
            // fall through
          }
        }
        if (id !== null) write(errorLine(id, `Ninerr answered ${response.status}`));
      } catch {
        if (id !== null) write(errorLine(id, "Ninerr is not reachable; is it still running?"));
      }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }
  await Promise.all(inflight);
}
