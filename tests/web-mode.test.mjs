import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { browserTestOptions } from "./support/browser.mjs";
import { layerCount, rendered, waitRevision } from "./support/editor.mjs";
import { attemptsIn, browse, openTab, run, startLilac } from "./support/lilac-process.mjs";

// PC7 (#146): local web mode and the offline, local-first smoke flow, through the product.
// One command (npm start, scripts/lilac.mjs) runs Lilac; it and the MCP relay run under a
// preload that refuses every connection off this computer, every DNS lookup and every
// helper process, and the browser refuses every request outside Lilac's origin. Closes PC
// gates 6 and 16.

// A tab whose page may not reach "ready" (a used link); its requests are still recorded.
const openTabUnready = (browser, origin, link) => openTab(browser, origin, link, { ready: false });

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
      const refused = async (attempt) => { try { await attempt(); return "allowed"; } catch { return "refused"; } };
      const { ChildProcess } = await import("node:child_process");
      const net = await import("node:net");
      const others = {
        worker: await refused(async () => new (await import("node:worker_threads")).Worker("process.exit(0)", { eval: true })),
        childProcessClass: await refused(() => new ChildProcess().spawn({ file: "true", args: ["true"], stdio: [] })),
        binding: await refused(() => process.binding("tcp_wrap")),
        dlopen: await refused(() => process.dlopen({}, "/nonexistent.node")),
        customLookup: await refused(() => net.connect({ host: "localhost", port: 9, lookup: (name, options, done) => done(null, "10.255.255.1", 4) })),
        udp: await refused(async () => new (await import("node:dgram")).Socket("udp4").send("x", 9, "127.0.0.1")),
        // http and https connect with path: null; and import-stack's pinned-lookup pattern.
        httpIp: await refused(async () => (await import("node:http")).get("http://93.184.215.14/")),
        httpsIp: await refused(async () => (await import("node:https")).get("https://1.1.1.1/")),
        httpsPinned: await refused(async () => (await import("node:https")).request({ hostname: "example.com", lookup: (name, options, done) => done(null, "93.184.215.14", 4) }).end()),
        httpName: await refused(async () => (await import("node:http")).get("http://example.com/")),
      };
      console.log(JSON.stringify({ local, remote, resolved, spawned, ...others }));
      server.close();
    });
  `]);
  assert.equal(await probe.exited, 0);
  assert.deepEqual(JSON.parse(probe.output.stdout), { local: "ok", remote: "refused", resolved: "refused", spawned: "refused", worker: "refused", childProcessClass: "refused", binding: "refused", dlopen: "refused", customLookup: "refused", udp: "refused", httpIp: "refused", httpsIp: "refused", httpsPinned: "refused", httpName: "refused" });
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
    assert.ok(others.length > 0, "this machine has another IPv4 address to probe");
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
    const reused = await openTabUnready(browser, lilac.origin, lilac.first);
    await reused.page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Open Lilac from its launcher");
    const fresh = await openTab(browser, lilac.origin, await lilac.newLink());
    await waitRevision(fresh.page, 1);
    assert.equal(await layerCount(fresh.page), 2);
    assert.deepEqual([...tab.foreign, ...fresh.foreign, ...reused.foreign], []);
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
  const tabs = [];
  try {
    let tab = await openTab(browser, lilac.origin, lilac.first);
    tabs.push(tab);
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
    assert.deepEqual(tab.errors, []);
    // Stop Lilac and start it again: everything is there.
    assert.equal(await lilac.stop(), 0);
    attempts.push(...attemptsIn(lilac.output.stderr));
    lilac = await startLilac(projects);
    tab = await openTab(browser, lilac.origin, lilac.first);
    tabs.push(tab);
    editor = tab.page;
    await editor.locator("#dialog[open] [data-project=offline]").click();
    await waitRevision(editor, 4);
    assert.equal(await layerCount(editor), layersBefore);
    const names = await editor.locator("#layers [role=treeitem] > .row .label").allTextContents();
    assert.ok(names.includes("Landing page") && names.includes("From agent") && names.includes("Badge"), names.join(", "));
    const h1 = await editor.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("h1")?.getAttribute("data-lilac-id"));
    assert.equal(await rendered(editor, h1, "color"), "rgb(51, 85, 119)");
    assert.deepEqual(tab.errors, []);
  } finally {
    // Everything every tab requested, from opening until the browser closes.
    for (const opened of tabs) attempts.push(...opened.foreign);
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

test("the command refuses options it does not understand", async () => {
  for (const args of [["--projects", "--open"], ["--port"], ["--port", "70000"], ["--frobnicate"]]) {
    const lilac = run(["scripts/lilac.mjs", ...args]);
    assert.equal(await lilac.exited, 2, args.join(" "));
    assert.match(lilac.output.stderr, /^lilac: /mu);
  }
});
