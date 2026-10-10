import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_LOCK, startStudioHost } from "../packages/studio-host/src/index.ts";
import { client, ok } from "./support/host-api.mjs";

// #261: one studio host per projects folder. The folder-wide files (connected agents,
// codebase links, the discovery file MCP relays read) are each kept by one host, so a second
// host on the same folder would silently undo the first's changes. A host claims the folder
// while it runs; a second is refused, naming the first; a claim left by a crash is taken over.

const HOST_CHILD = fileURLToPath(new URL("./support/host-child.mjs", import.meta.url));
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();

async function withFolder(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-folder-")));
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a second host on the same projects folder is refused, naming the first, and the first goes on (#261)", () => withFolder(async (root) => {
  const first = await startStudioHost({ projectsRoot: root, now });
  try {
    const call = client(first.url, first.token);
    await ok(call("POST", "/api/projects/create", { name: "alpha" }));
    await ok(call("POST", "/api/agents/create", { name: "Kept" }));
    await assert.rejects(() => startStudioHost({ projectsRoot: root, now }), (error) => {
      assert.equal(error.code, "projects-folder-in-use");
      assert.match(error.message, new RegExp(`already running for this projects folder \\(process ${process.pid}, at ${first.url.replace(/\./gu, "\\.")}\\)`, "u"));
      assert.match(error.message, new RegExp(`remove ${HOST_LOCK.replace(/\./gu, "\\.")}`, "u"));
      return true;
    });
    // Nothing of the first host's was touched.
    assert.deepEqual((await ok(call("GET", "/api/agents"))).agents.map((agent) => agent.displayName), ["Kept"]);
    assert.equal((await ok(call("GET", "/api/session"))).project, "alpha");
  } finally {
    await first.close();
  }
  // Closed, the folder is free again, and the agent the first host connected is still there.
  assert.equal(existsSync(join(root, HOST_LOCK)), false);
  const next = await startStudioHost({ projectsRoot: root, now });
  try {
    assert.deepEqual((await ok(client(next.url, next.token)("GET", "/api/agents"))).agents.map((agent) => agent.displayName), ["Kept"]);
  } finally {
    await next.close();
  }
}));

test("a claim left by a host that crashed is taken over (#261)", () => withFolder(async (root) => {
  // A host in its own process, killed outright: its claim stays behind, for a process that is gone.
  const child = spawn(process.execPath, [HOST_CHILD, root], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("close", resolve));
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  for (let tries = 0; tries < 500 && !out.includes("\n") && child.exitCode === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(out.includes("\n"), "the child host started");
  assert.equal(JSON.parse(readFileSync(join(root, HOST_LOCK), "utf8")).pid, child.pid);
  child.kill("SIGKILL");
  await exited;
  assert.ok(existsSync(join(root, HOST_LOCK)), "a crash leaves the claim");
  const host = await startStudioHost({ projectsRoot: root, now });
  try {
    assert.equal(JSON.parse(readFileSync(join(root, HOST_LOCK), "utf8")).pid, process.pid, "taken over");
  } finally {
    await host.close();
  }
  // So is a claim made before the computer last started, even when its process id is in use
  // again (here by this very process).
  writeFileSync(join(root, HOST_LOCK), `${JSON.stringify({ version: 1, pid: process.pid, nonce: "before-boot", startedAt: now(), claimedAt: Date.now() - uptime() * 1000 - 11 * 60_000 })}\n`);
  const rebooted = await startStudioHost({ projectsRoot: root, now });
  await rebooted.close();
  // So is a claim that cannot be read (a disk that kept only part of it, say).
  writeFileSync(join(root, HOST_LOCK), "{\"pid\":");
  const after = await startStudioHost({ projectsRoot: root, now });
  await after.close();
}));

test("a host removes only its own claim (#261)", () => withFolder(async (root) => {
  const host = await startStudioHost({ projectsRoot: root, now });
  // Someone replaced the claim while the host ran: closing leaves the replacement alone.
  const replacement = `${JSON.stringify({ version: 1, pid: process.pid, nonce: "someone-else", startedAt: now(), claimedAt: Date.now() })}\n`;
  writeFileSync(join(root, HOST_LOCK), replacement);
  await host.close();
  assert.equal(readFileSync(join(root, HOST_LOCK), "utf8"), replacement);
}));
