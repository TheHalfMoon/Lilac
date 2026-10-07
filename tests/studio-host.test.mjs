import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStudioHost } from "../packages/studio-host/src/index.ts";

// PC1 (#146): the studio host composes persistence, history and collaboration behind a
// loopback-only API, and streams attributed changes. Advances PC gate 4.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

async function withHost(callback, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-studio-")));
  const host = await startStudioHost({ projectsRoot: root, now, ...extra });
  try {
    return await callback(host, root);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A raw request, so tests control Host, Origin and the body exactly. */
function raw(host, { method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: host.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function api(host, method, path, payload) {
  return raw(host, {
    method,
    path,
    headers: { authorization: `Bearer ${host.token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/** Subscribe to the change stream and collect parsed events. */
async function subscribe(host) {
  const events = [];
  const controller = new AbortController();
  const response = await fetch(`${host.url}/api/events?token=${host.token}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/mu.exec(frame)?.[1];
          const data = /^data: (.+)$/mu.exec(frame)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; i += 1) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  return { events, waitFor, close: () => controller.abort() };
}

const insertFrame = (id) => ({ type: "insert-node", node: { id, type: "frame", props: { name: id } }, parentId: null });

test("the host listens on loopback only and refuses requests outside its envelope", () => withHost(async (host) => {
  assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(host.token.length >= 40, true);
  const base = { path: "/api/session" };
  assert.equal((await raw(host, base)).status, 401, "no token");
  assert.equal((await raw(host, { ...base, headers: { authorization: "Bearer wrong" } })).status, 401, "wrong token");
  assert.equal((await raw(host, { ...base, path: `/api/session?token=${host.token.slice(1)}` })).status, 401, "truncated token");
  const good = { authorization: `Bearer ${host.token}` };
  assert.equal((await raw(host, { ...base, headers: { ...good, host: "evil.example" } })).status, 421, "DNS-rebinding Host");
  assert.equal((await raw(host, { ...base, headers: { ...good, origin: "https://evil.example" } })).status, 403, "foreign Origin");
  assert.equal((await raw(host, { ...base, headers: { ...good, origin: host.url } })).status, 200, "own Origin");
  const ok = await raw(host, { ...base, headers: good });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { project: null });
  for (const header of ["cache-control", "x-content-type-options", "content-security-policy"]) assert.ok(ok.headers[header], header);
  // A cross-site form post cannot be JSON, and bodies are bounded.
  assert.equal((await raw(host, { method: "POST", path: "/api/projects/create", headers: { ...good, "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await raw(host, { method: "POST", path: "/api/projects/create", headers: { ...good, "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await raw(host, { method: "POST", path: "/api/projects/create", headers: { ...good, "content-type": "application/json" }, body: "{" })).status, 400);
  // Only plain names inside the projects root can be opened or created.
  for (const name of ["../escape", "/abs", "a/b", "", ".hidden", "x".repeat(65)]) {
    const response = await api(host, "POST", "/api/projects/create", { name });
    assert.equal(response.status, 400, JSON.stringify(name));
    assert.equal(response.json.error.code, "invalid-project-name");
  }
  assert.equal((await api(host, "GET", "/api/nope")).status, 404);
  assert.equal((await api(host, "POST", "/api/edit", { baseRevision: 0, operations: [insertFrame("a")] })).json.error.code, "no-project");
}));

test("create, edit, undo and redo are attributed transactions streamed live and durable on reopen", () => withHost(async (host, root) => {
  const stream = await subscribe(host);
  try {
    const created = await api(host, "POST", "/api/projects/create", { name: "demo", title: "Demo" });
    assert.equal(created.status, 200);
    assert.equal(created.json.project, "demo");
    assert.equal(created.json.revision, 0);
    assert.deepEqual((await api(host, "GET", "/api/projects")).json, { projects: ["demo"] });

    const edit = await api(host, "POST", "/api/edit", { baseRevision: 0, intent: "Add frame", operations: [insertFrame("frame-1")] });
    assert.equal(edit.status, 200);
    assert.equal(edit.json.revision, 1);
    assert.equal(edit.json.actor, "local-user");
    assert.equal(edit.json.actorKind, "user");
    assert.deepEqual(edit.json.affectedNodeIds, ["frame-1"]);
    const streamed = await stream.waitFor((event) => event.name === "change" && event.data.transactionId === edit.json.transactionId, "the edit event");
    assert.deepEqual(streamed.data, edit.json);

    const stale = await api(host, "POST", "/api/edit", { baseRevision: 0, operations: [insertFrame("frame-2")] });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "stale-revision");
    const invalid = await api(host, "POST", "/api/edit", { baseRevision: 1, operations: [{ type: "set-props", nodeId: "missing", set: { a: 1 } }] });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "invalid-edit");

    await api(host, "POST", "/api/edit", { baseRevision: 1, intent: "Rename", operations: [{ type: "set-props", nodeId: "frame-1", set: { name: "Hero" } }] });
    const undone = await api(host, "POST", "/api/undo");
    assert.equal(undone.status, 200);
    assert.equal(undone.json.tool, "lilac:undo");
    assert.equal(undone.json.intent, "Undo: Rename");
    let doc = (await api(host, "GET", "/api/document")).json;
    assert.equal(doc.revision, 3);
    assert.equal(doc.document.nodes["frame-1"].props.name, "frame-1");
    const redone = await api(host, "POST", "/api/redo");
    assert.equal(redone.json.tool, "lilac:redo");
    doc = (await api(host, "GET", "/api/document")).json;
    assert.equal(doc.document.nodes["frame-1"].props.name, "Hero");
    assert.equal((await api(host, "POST", "/api/redo")).json.error.code, "nothing-to-redo");
    // Undo twice walks back past the redone change to before the frame existed.
    await api(host, "POST", "/api/undo");
    await api(host, "POST", "/api/undo");
    doc = (await api(host, "GET", "/api/document")).json;
    assert.equal(doc.document.nodes["frame-1"], undefined);
    assert.equal((await api(host, "POST", "/api/undo")).json.error.code, "nothing-to-undo");
    await api(host, "POST", "/api/redo");
    assert.equal((await api(host, "POST", "/api/checkpoint")).status, 200);

    // The journal holds every change, including undo and redo, with collaboration attribution.
    const journal = readFileSync(join(root, "demo", ".lilac", "journal.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).entry.transaction);
    assert.deepEqual(journal.map((tx) => tx.tool), [null, null, "lilac:undo", "lilac:redo", "lilac:undo", "lilac:undo", "lilac:redo"]);
    assert.equal(journal[2].metadata.lilac.undoOf, journal[1].id);
    assert.equal(journal[3].metadata.lilac.redoOf, journal[1].id);
    for (const tx of journal) {
      assert.equal(tx.actor, "local-user");
      assert.equal(tx.metadata.collaboration.actorKind, "user");
    }

    // Close and reopen: the persisted state, not the session, is the source of truth.
    assert.deepEqual((await api(host, "POST", "/api/projects/close")).json, { project: null });
    const reopened = await api(host, "POST", "/api/projects/open", { name: "demo" });
    assert.equal(reopened.json.revision, 7);
    assert.equal(reopened.json.canUndo, false, "the undo stack belongs to the session");
    doc = (await api(host, "GET", "/api/document")).json;
    assert.equal(doc.document.nodes["frame-1"].props.name, "frame-1");
    assert.equal((await api(host, "POST", "/api/projects/create", { name: "demo" })).json.error.code, "project-exists");
    await stream.waitFor((event) => event.name === "project" && event.data.project === "demo" && event.data.revision === 7, "the reopen event");
  } finally {
    stream.close();
  }
}));

test("locks and recovery are reported, and a stale lock is replaced only with a reason", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-studio-lock-")));
  const first = await startStudioHost({ projectsRoot: root, now });
  const second = await startStudioHost({ projectsRoot: root, now, owner: { actorId: "other-user", kind: "user", accessClass: "member", displayName: "Other" } });
  try {
    await api(first, "POST", "/api/projects/create", { name: "shared" });
    await api(first, "POST", "/api/edit", { baseRevision: 0, operations: [insertFrame("a")] });
    const locked = await api(second, "POST", "/api/projects/open", { name: "shared" });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error.code, "project-locked");
    assert.equal((await api(second, "POST", "/api/projects/open", { name: "shared", breakStaleLock: { reason: " " } })).json.error.code, "invalid-lock-override");
    const taken = await api(second, "POST", "/api/projects/open", { name: "shared", breakStaleLock: { reason: "the other studio crashed" } });
    assert.equal(taken.status, 200);
    assert.equal(taken.json.recovery.lockOverride.reason, "the other studio crashed");
    assert.equal(taken.json.recovery.lockOverride.previous.owner, "local-user");
    await api(second, "POST", "/api/projects/close");

    // A torn journal tail from a crash is repaired on open and reported.
    appendFileSync(join(root, "shared", ".lilac", "journal.log"), '{"digest":"torn');
    const repaired = await api(second, "POST", "/api/projects/open", { name: "shared" });
    assert.equal(repaired.status, 200);
    assert.equal(repaired.json.recovery.tornTailBytes, '{"digest":"torn'.length);
    assert.equal(repaired.json.revision, 1);
  } finally {
    await first.close();
    await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host refuses a projects root that is not a directory", async () => {
  await assert.rejects(() => startStudioHost({ projectsRoot: join(tmpdir(), "lilac-missing-root-for-test") }), /projectsRoot/u);
});
