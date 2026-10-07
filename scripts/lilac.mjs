#!/usr/bin/env node
// Lilac in local web mode: one command starts Lilac on this computer and prints the link
// that opens the editor in a browser.
//
//   npm start -- [--projects <folder>] [--port <number>] [--open]
//
// Lilac listens on 127.0.0.1 only and needs no network: projects stay in the projects
// folder (default: "Lilac Projects" in your home folder, or LILAC_PROJECTS). Each link
// works once, for two minutes; press Enter for a new one. Ctrl+C stops Lilac.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { startStudioHost } from "../packages/studio-host/src/index.ts";

const args = process.argv.slice(2);
function fail(message) {
  process.stderr.write(`lilac: ${message}\n`);
  process.exit(2);
}
const VALUED = new Set(["--projects", "--port"]);
for (let index = 0; index < args.length; index += 1) {
  if (VALUED.has(args[index])) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${args[index]} needs a value`);
    index += 1;
  } else if (args[index] !== "--open") fail(`unknown option ${args[index]} (use --projects <folder>, --port <number>, --open)`);
}
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const projectsRoot = resolve(option("--projects") ?? process.env.LILAC_PROJECTS ?? join(homedir(), "Lilac Projects"));
const portText = option("--port") ?? "0";
const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be a number from 0 to 65535");
try {
  mkdirSync(projectsRoot, { recursive: true, mode: 0o700 });
  // Projects and agent registrations are this user's alone, even in an existing folder.
  if (process.platform !== "win32" && (statSync(projectsRoot).mode & 0o077) !== 0) chmodSync(projectsRoot, 0o700);
} catch (error) {
  fail(`cannot use the projects folder: ${error instanceof Error ? error.message : String(error)}`);
}

let host;
try {
  host = await startStudioHost({ projectsRoot, port });
} catch (error) {
  fail(`could not start: ${error instanceof Error ? error.message : String(error)}`);
}

const say = (line) => process.stdout.write(`${line}\n`);
say("Lilac is running on this computer only (no network access is needed).");
say(`Projects folder: ${projectsRoot}`);
say(`Open Lilac: ${host.launchUrl()}`);
say("Each link works once. Press Enter for a new link, or Ctrl+C to stop Lilac.");

if (args.includes("--open")) {
  // Only when asked: hand the system's browser opener a private file that forwards to a
  // fresh link, so the link (a ticket) never appears in the process list. The file is
  // removed once the ticket has expired.
  const file = join(projectsRoot, `.lilac-open-${process.pid}.html`);
  const url = host.launchUrl();
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${url}"><title>Opening Lilac</title>`, { mode: 0o600 });
  setTimeout(() => rmSync(file, { force: true }), 130_000).unref();
  process.on("exit", () => rmSync(file, { force: true }));
  const [command, commandArgs] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try {
    spawn(command, commandArgs, { stdio: "ignore", detached: true }).on("error", () => say("Could not open a browser; open the link above.")).unref();
  } catch {
    say("Could not open a browser; open the link above.");
  }
}

if (process.stdin.isTTY || process.env.LILAC_STDIN_LINKS === "1") {
  createInterface({ input: process.stdin }).on("line", () => say(`Open Lilac: ${host.launchUrl()}`));
}

let stopping = false;
async function stop() {
  // A second Ctrl+C stops at once, should closing ever hang.
  if (stopping) process.exit(1);
  stopping = true;
  say("Stopping Lilac.");
  await host.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
