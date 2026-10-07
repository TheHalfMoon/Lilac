import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { browserTestOptions, findBrowser } from "./support/browser.mjs";
import { layerCount, rendered, waitRevision } from "./support/editor.mjs";

// PC7 (#146): local web mode and the offline, local-first smoke flow, through the product.
// One command (npm start, scripts/lilac.mjs) runs Lilac; it and the MCP relay run under a
// preload that refuses every connection off this computer, every DNS lookup and every
// helper process, and the browser refuses every request outside Lilac's origin. Closes PC
// gates 6 and 16.

const PRELOAD = "./tests/support/no-network.mjs";
const attemptsIn = (text) => text.split("\n").filter((line) => line.startsWith("LILAC-NETWORK-ATTEMPT"));

function run(args, env = {}) {
  const child = spawn(process.execPath, ["--import", PRELOAD, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return { child, output, exited };
}

async function startLilac(projects) {
  const lilac = run(["scripts/lilac.mjs", "--projects", projects, "--port", "0"], { LILAC_STDIN_LINKS: "1" });
  const links = [];
  const nextLink = async () => {
    const seen = links.length;
    for (let tries = 0; tries < 500; tries += 1) {
      const all = [...lilac.output.stdout.matchAll(/^Open Lilac: (\S+)$/gmu)].map((match) => match[1]);
      if (all.length > seen) {
        links.push(...all.slice(seen));
        return all[seen];
      }
      if (lilac.child.exitCode !== null) throw new Error(`lilac exited: ${lilac.output.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("lilac printed no link");
  };
  const first = await nextLink();
  return {
    ...lilac,
    first,
    origin: new URL(first).origin,
    async newLink() {
      lilac.child.stdin.write("\n");
      return nextLink();
    },
    async stop() {
      lilac.child.kill("SIGTERM");
      return lilac.exited;
    },
  };
}

async function browse() {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
  return browser;
}

async function openTab(browser, origin, link) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const foreign = [];
  const errors = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(link);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  return { page, foreign, errors };
}

test("the network trap refuses connections off this computer and allows loopback", async () => {
  const probe = run(["--input-type=module", "-e", `
    import { createServer } from "node:http";
    const server = createServer((request, response) => response.end("ok")).listen(0, "127.0.0.1", async () => {
      const local = await fetch("http://127.0.0.1:" + server.address().port + "/").then((response) => response.text());
      let remote = "allowed";
      try { await fetch("https://example.com/"); } catch { remote = "refused"; }
      let resolved = "allowed";
      try { await (await import("node:dns")).promises.lookup("example.com"); } catch { resolved = "refused"; }
      let spawned = "allowed";
      try { (await import("node:child_process")).spawn("true"); } catch { spawned = "refused"; }
      console.log(JSON.stringify({ local, remote, resolved, spawned }));
      server.close();
    });
  `]);
  assert.equal(await probe.exited, 0);
  assert.deepEqual(JSON.parse(probe.output.stdout), { local: "ok", remote: "refused", resolved: "refused", spawned: "refused" });
  assert.ok(attemptsIn(probe.output.stderr).length >= 3, "every refused attempt is reported");
});

test("one command serves Lilac on this computer only, with single-use links, and stops cleanly", browserTestOptions(), async () => {
  const projects = realpathSync(mkdtempSync(join(tmpdir(), "lilac-web-")));
  const lilac = await startLilac(join(projects, "Lilac Projects"));
  const browser = await browse();
  try {
    assert.match(lilac.output.stdout, /^Lilac is running on this computer only/mu);
    assert.match(lilac.output.stdout, /^Projects folder: .*Lilac Projects$/mu);
    const url = new URL(lilac.first);
    assert.equal(url.hostname, "127.0.0.1");
    // Not reachable on any other address of this computer.
    const others = Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal && entry.family === "IPv4").map((entry) => entry.address);
    for (const address of others) {
      const refused = await new Promise((resolve) => {
        const socket = connect({ host: address, port: Number(url.port) });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
      });
      assert.equal(refused, true, `not reachable on ${address}`);
    }
    // The editor works from the link.
    const tab = await openTab(browser, lilac.origin, lilac.first);
    await tab.page.locator("#new-project-name").fill("web");
    await tab.page.keyboard.press("Enter");
    await waitRevision(tab.page, 0);
    await tab.page.locator("#action-insert-box").click();
    await waitRevision(tab.page, 1);
    // A link works once; Enter prints a fresh one, which opens a second editor on the same project.
    const reused = await (await browser.newContext()).newPage();
    await reused.goto(lilac.first);
    await reused.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Open Lilac from its launcher");
    const fresh = await openTab(browser, lilac.origin, await lilac.newLink());
    await waitRevision(fresh.page, 1);
    assert.equal(await layerCount(fresh.page), 2);
    assert.deepEqual([...tab.foreign, ...fresh.foreign], []);
    assert.deepEqual([...tab.errors, ...fresh.errors], []);
  } finally {
    await browser.close();
    assert.equal(await lilac.stop(), 0, "Ctrl+C or SIGTERM stops Lilac cleanly");
    assert.match(lilac.output.stdout, /Stopping Lilac\./u);
    assert.equal(existsSync(join(projects, "Lilac Projects", ".lilac-studio.json")), false);
    assert.deepEqual(attemptsIn(lilac.output.stderr), [], "Lilac never tried to reach the network");
    rmSync(projects, { recursive: true, force: true });
  }
});

test("offline smoke: create, import, edit, code, an agent over stdio, save, restart and reopen, with no network", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-offline-")));
  const projects = join(root, "projects");
  const page = join(root, "landing.html");
  writeFileSync(page, `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/x.css">
    <script src="https://cdn.example.com/x.js"></script></head><body><main><h1 style="color: #335577">Landing</h1>
    <img src="https://images.example.com/hero.png" alt="Hero"><a href="https://example.com">Out</a></main></body></html>`);
  let lilac = await startLilac(projects);
  const browser = await browse();
  const attempts = [];
  try {
    let tab = await openTab(browser, lilac.origin, lilac.first);
    let { page: editor } = tab;
    // Create a project and import a page that links to the network.
    await editor.locator("#new-project-name").fill("offline");
    await editor.keyboard.press("Enter");
    await waitRevision(editor, 0);
    await editor.locator("#action-import").click();
    await editor.locator("#import-file").setInputFiles(page);
    await editor.locator("#dialog[open] button.primary").click();
    await editor.locator("#import-review").waitFor();
    await editor.locator("#dialog[open] button.primary", { hasText: "Import" }).click();
    await waitRevision(editor, 1);
    // Edit: rename the imported page from the inspector.
    await editor.locator("#inspect-name").fill("Landing page");
    await editor.keyboard.press("Tab");
    await waitRevision(editor, 2);
    // Code: bring a component in.
    await editor.locator("#action-code").click();
    await editor.locator("#code-import").fill("export function Badge() { return <span className=\"badge\" style=\"color: #aa2200\">New</span>; }");
    await editor.locator("#dialog[open] button.primary", { hasText: "Add to design" }).click();
    await waitRevision(editor, 3);
    // An agent over the stdio relay (also trapped) adds an artboard.
    await editor.locator("#action-agents").click();
    await editor.locator("#agent-name").fill("Offline agent");
    await editor.keyboard.press("Enter");
    const token = await editor.locator("#agent-credential").inputValue();
    await editor.locator("#dialog[open] button.primary").click();
    const relay = run(["scripts/lilac-mcp.mjs", "--projects", projects], { LILAC_MCP_TOKEN: token });
    relay.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_artboard", arguments: { name: "From agent", width: 400, height: 300 } } })}\n`);
    relay.child.stdin.end();
    assert.equal(await relay.exited, 0);
    assert.equal(JSON.parse(relay.output.stdout.trim()).result.structuredContent.revision, 4);
    attempts.push(...attemptsIn(relay.output.stderr));
    await waitRevision(editor, 4);
    await editor.locator("#action-save").click();
    await editor.waitForFunction(() => document.getElementById("status").textContent.startsWith("Saved."));
    const layersBefore = await layerCount(editor);
    attempts.push(...tab.foreign);
    assert.deepEqual(tab.errors, []);
    // Stop Lilac and start it again: everything is there.
    assert.equal(await lilac.stop(), 0);
    attempts.push(...attemptsIn(lilac.output.stderr));
    lilac = await startLilac(projects);
    tab = await openTab(browser, lilac.origin, lilac.first);
    editor = tab.page;
    await editor.locator("#dialog[open] [data-project=offline]").click();
    await waitRevision(editor, 4);
    assert.equal(await layerCount(editor), layersBefore);
    const names = await editor.locator("#layers [role=treeitem] > .row .label").allTextContents();
    assert.ok(names.includes("Landing page") && names.includes("From agent") && names.includes("Badge"), names.join(", "));
    const h1 = await editor.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("h1")?.getAttribute("data-lilac-id"));
    assert.equal(await rendered(editor, h1, "color"), "rgb(51, 85, 119)");
    attempts.push(...tab.foreign);
    assert.deepEqual(tab.errors, []);
  } finally {
    await browser.close();
    await lilac.stop();
    attempts.push(...attemptsIn(lilac.output.stderr));
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(attempts, [], "no process and no page tried to reach anything off this computer");
});

test("stopping Lilac does not wait for open connections", { timeout: 10_000 }, async () => {
  const { startStudioHost } = await import("../packages/studio-host/src/index.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-close-")));
  const host = await startStudioHost({ projectsRoot: root });
  try {
    // An open event stream and an idle keep-alive connection.
    const stream = await fetch(`${host.url}/api/events?token=${host.token}`);
    const idle = connect({ host: "127.0.0.1", port: host.port });
    await new Promise((resolve) => idle.once("connect", resolve));
    const started = Date.now();
    await host.close();
    assert.ok(Date.now() - started < 1000, `closed in ${Date.now() - started} ms`);
    await stream.body.cancel().catch(() => {});
    idle.destroy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
