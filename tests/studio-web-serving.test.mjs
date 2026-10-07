import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { startStudioHost } from "../packages/studio-host/src/index.ts";

// PC4 part 1 (#157): the studio host serves the editor. Only the editor's browser packages
// are served, the page gets a strict CSP, and the single-use launch ticket is traded for the
// token only by this host's own page. Also the routes the editor reads: the session's user,
// the history log, and change events and documents that name their project.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

test("the host serves only the editor's files, and the launch ticket works once", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-editor-static-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  try {
    const page = await fetch(`${host.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/u);
    assert.match(await page.text(), /<title>Lilac<\/title>/u);
    assert.equal((await fetch(`${host.url}/packages/canvas/src/index.mjs`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    for (const path of ["/packages/persistence/src/store.ts", "/packages/studio-host/src/server.ts", "/packages/canvas/package.json", "/packages/canvas/src/../../../package.json", "/packages/canvas/src/%2e%2e/package.json", "/package.json", "/.git/config", "/packages/studio-web/src/"]) {
      assert.equal((await fetch(`${host.url}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${host.url}/packages/canvas/src/index.mjs`, { method: "POST" })).status, 405);
    // fetch normalises dot segments before sending; send the raw paths too.
    const raw = (path) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: host.port, path, method: "GET" }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    for (const path of ["/packages/canvas/src/../../../package.json", "/packages/canvas/src/%2e%2e/%2e%2e/package.json", "/packages/canvas/src/..%2f..%2fpackage.json", "/packages/studio-host/src/../src/server.ts"]) {
      assert.equal(await raw(path), 404, `raw ${path}`);
    }
    // The ticket is redeemed once, only with an Origin, and the token is never in a cookie.
    const ticket = new URL(host.launchUrl()).searchParams.get("ticket");
    const redeem = (headers) => fetch(`${host.url}/api/launch`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ticket }) });
    assert.equal((await redeem({})).status, 403, "no Origin");
    assert.equal((await redeem({ origin: "http://evil.test" })).status, 403, "foreign Origin");
    const first = await redeem({ origin: host.url });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).token, host.token);
    assert.equal(first.headers.get("set-cookie"), null);
    assert.equal((await redeem({ origin: host.url })).status, 401, "a used ticket");
    assert.equal((await fetch(`${host.url}/api/session`)).status, 401, "the API still needs the token");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the editor's routes: the user, the history log, and project-named changes and documents", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-editor-routes-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const call = (method, path, body) => fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  try {
    assert.deepEqual(await call("GET", "/api/session"), { project: null, user: { actorId: "local-user", displayName: "You" } });
    await call("POST", "/api/projects/create", { name: "demo" });
    const edit = await call("POST", "/api/edit", { baseRevision: 0, intent: "Add box", operations: [{ type: "insert-node", node: { id: "box", type: "element", props: {} }, parentId: null, index: 0 }] });
    assert.equal(edit.project, "demo");
    const document = await call("GET", "/api/document");
    assert.equal(document.project, "demo");
    assert.equal(document.revision, 1);
    await call("POST", "/api/undo");
    const { entries } = await call("GET", "/api/history");
    assert.deepEqual(entries.map((entry) => [entry.revision, entry.intent, entry.actor, entry.project]), [[1, "Add box", "local-user", "demo"], [2, "Undo: Add box", "local-user", "demo"]]);
    assert.ok(entries.every((entry) => entry.operations === undefined), "the log leaves operations out");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a request body over the limit is answered, not left waiting", { timeout: 15_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-too-large-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  try {
    const started = Date.now();
    const response = await fetch(`${host.url}/api/edit`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) }) });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "too-large");
    assert.ok(Date.now() - started < 5000, `answered in ${Date.now() - started} ms`);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
