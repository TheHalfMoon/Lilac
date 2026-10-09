import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalCollaborationRoom } from "../packages/collaboration/src/index.ts";
import { MAX_OPERATIONS_PER_EDIT, StudioSession, startStudioHost } from "../packages/studio-host/src/index.ts";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

// PC1 (#146): the studio host composes persistence, history and collaboration behind a
// loopback-only API, and streams attributed changes. Advances PC gate 4.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

async function withHost(callback, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-studio-")));
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
  assert.deepEqual(ok.json, { project: null, user: { actorId: "local-user", displayName: "You" } });
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
    assert.equal(edit.json.operations[0].node.id, "frame-1", "the event carries the committed operations");
    const tooMany = await api(host, "POST", "/api/edit", { baseRevision: 1, operations: Array.from({ length: MAX_OPERATIONS_PER_EDIT + 1 }, (_, i) => insertFrame(`x${i}`)) });
    assert.equal(tooMany.status, 413);
    const invalid = await api(host, "POST", "/api/edit", { baseRevision: 1, operations: [{ type: "set-props", nodeId: "missing", set: { a: 1 } }] });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "invalid-edit");

    await api(host, "POST", "/api/edit", { baseRevision: 1, intent: "Rename", operations: [{ type: "set-props", nodeId: "frame-1", set: { name: "Hero" } }] });
    const undone = await api(host, "POST", "/api/undo");
    assert.equal(undone.status, 200);
    assert.equal(undone.json.tool, "ninerr:undo");
    assert.equal(undone.json.intent, "Undo: Rename");
    let doc = (await api(host, "GET", "/api/document")).json;
    assert.equal(doc.revision, 3);
    assert.equal(doc.document.nodes["frame-1"].props.name, "frame-1");
    const redone = await api(host, "POST", "/api/redo");
    assert.equal(redone.json.tool, "ninerr:redo");
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
    const journal = readFileSync(join(root, "demo", PROJECT_FILES.directory, "journal.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).entry.transaction);
    assert.deepEqual(journal.map((tx) => tx.tool), [null, null, "ninerr:undo", "ninerr:redo", "ninerr:undo", "ninerr:undo", "ninerr:redo"]);
    assert.equal(journal[2].metadata.ninerr.undoOf, journal[1].id);
    assert.equal(journal[3].metadata.ninerr.redoOf, journal[1].id);
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-studio-lock-")));
  const first = await startStudioHost({ projectsRoot: root, now });
  const second = await startStudioHost({ projectsRoot: root, now, owner: { actorId: "other-user", kind: "user", accessClass: "member", displayName: "Other" } });
  try {
    await api(first, "POST", "/api/projects/create", { name: "shared" });
    await api(first, "POST", "/api/edit", { baseRevision: 0, operations: [insertFrame("a")] });
    const locked = await api(second, "POST", "/api/projects/open", { name: "shared" });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error.code, "project-locked");
    assert.equal((await api(second, "POST", "/api/projects/open", { name: "shared", breakStaleLock: { reason: " " } })).json.error.code, "invalid-lock-override");
    // The holder (this test process) is alive, so its lock is not stale and is not broken.
    const live = await api(second, "POST", "/api/projects/open", { name: "shared", breakStaleLock: { reason: "the other studio crashed" } });
    assert.equal(live.status, 409);
    assert.equal(live.json.error.code, "lock-held-by-live-process");
    assert.equal((await api(first, "GET", "/api/session")).json.revision, 1, "the live holder keeps the project");
    // A lock left by a process that no longer exists is broken with a reason, and reported.
    await first.close();
    const lockPath = join(root, "shared", PROJECT_FILES.directory, "lock");
    writeFileSync(lockPath, JSON.stringify({ owner: "crashed-studio", pid: 2 ** 22 + 4321, at: "2026-10-07T11:00:00.000Z", nonce: "dead" }));
    const taken = await api(second, "POST", "/api/projects/open", { name: "shared", breakStaleLock: { reason: "the other studio crashed" } });
    assert.equal(taken.status, 200);
    assert.equal(taken.json.recovery.lockOverride.reason, "the other studio crashed");
    assert.equal(taken.json.recovery.lockOverride.previous.owner, "crashed-studio");
    await api(second, "POST", "/api/projects/close");

    // A torn journal tail from a crash is repaired on open and reported.
    appendFileSync(join(root, "shared", PROJECT_FILES.directory, "journal.log"), '{"digest":"torn');
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
  await assert.rejects(() => startStudioHost({ projectsRoot: join(tmpdir(), "ninerr-missing-root-for-test") }), /projectsRoot/u);
});

test("a project opens only by its exact name, and a name differing only by case is taken (#247)", () => withHost(async (host) => {
  await api(host, "POST", "/api/projects/create", { name: "site" });
  await api(host, "POST", "/api/projects/close");
  for (const name of ["SITE", "Site"]) {
    const other = await api(host, "POST", "/api/projects/open", { name });
    assert.deepEqual([other.status, other.json.error?.code], [404, "project-not-found"], `${name} is not site`);
  }
  assert.equal((await api(host, "POST", "/api/projects/create", { name: "Site" })).json.error.code, "project-exists", "nor can it be created beside site, on any disk");
  assert.equal((await api(host, "POST", "/api/projects/open", { name: "site" })).json.project, "site");
}));

test("a failed open or create keeps the current project, and failures have specific codes", () => withHost(async (host, root) => {
  await api(host, "POST", "/api/projects/create", { name: "keep" });
  const missing = await api(host, "POST", "/api/projects/open", { name: "nope" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "project-not-found");
  assert.equal((await api(host, "POST", "/api/projects/create", { name: "keep" })).json.error.code, "project-exists");
  assert.equal((await api(host, "GET", "/api/session")).json.project, "keep", "creating the open project's name does not close it");
  for (const name of ["CON", "nul.txt", "com1", "trailing."]) assert.equal((await api(host, "POST", "/api/projects/create", { name })).json.error.code, "invalid-project-name", name);
  mkdirSync(join(root, "plain"));
  assert.equal((await api(host, "POST", "/api/projects/open", { name: "plain" })).json.error.code, "project-not-found", "a plain directory is not a project");
  await api(host, "POST", "/api/projects/create", { name: "broken" });
  await api(host, "POST", "/api/projects/open", { name: "keep" });
  writeFileSync(join(root, "broken", PROJECT_FILES.directory, "project.json"), "{not json");
  const unreadable = await api(host, "POST", "/api/projects/open", { name: "broken" });
  assert.equal(unreadable.status, 422);
  assert.equal(unreadable.json.error.code, "project-unreadable");
  // A project directory that is a link to somewhere outside the root is refused.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-outside-")));
  try {
    renameSync(join(root, "broken"), join(outside, "victim"));
    symlinkSync(join(outside, "victim"), join(root, "link"));
    assert.equal((await api(host, "POST", "/api/projects/open", { name: "link" })).json.error.code, "invalid-project");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assert.equal((await api(host, "GET", "/api/session")).json.project, "keep", "every failure above left the open project open");
  // The query token is accepted only by the event stream.
  assert.equal((await raw(host, { method: "POST", path: `/api/projects/close?token=${host.token}` })).status, 401);
}));

test("a store that can no longer be written is reported as needing a reopen, without paths", () => withHost(async (host, root) => {
  await api(host, "POST", "/api/projects/create", { name: "p" });
  await api(host, "POST", "/api/edit", { baseRevision: 0, operations: [insertFrame("a")] });
  appendFileSync(join(root, "p", PROJECT_FILES.directory, "journal.log"), "tampered\n");
  const failed = await api(host, "POST", "/api/edit", { baseRevision: 1, operations: [insertFrame("b")] });
  assert.equal(failed.status, 409);
  assert.equal(failed.json.error.code, "project-needs-reopen");
  assert.ok(!failed.json.error.message.includes(root), "no filesystem path is reported");
  assert.equal((await api(host, "POST", "/api/undo")).json.error.code, "project-needs-reopen");
  const session = (await api(host, "GET", "/api/session")).json;
  assert.equal(session.project, "p");
  assert.match(session.failure, /reopen/u);
}));

test("undo and redo restore every operation type exactly, across reopen", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-undo-")));
  const owner = { actorId: "local-user", kind: "user", accessClass: "member", displayName: "You" };
  const strip = ({ revision, ...rest }) => JSON.stringify(rest);
  const node = (id, props = {}) => ({ id, type: "frame", props });
  let session = StudioSession.open({ projectsRoot: root, name: "p", owner, now, create: {} });
  const edit = (operations) => session.edit(owner, { baseRevision: session.revision, operations });
  try {
    edit([{ type: "insert-node", node: node("r", { z: 1, a: 2, m: 3 }), parentId: null }]);
    edit([{ type: "insert-node", node: node("a"), parentId: "r" }, { type: "insert-node", node: node("b"), parentId: "a" }, { type: "insert-node", node: node("c"), parentId: "b" }, { type: "insert-node", node: node("d", { k: [1, { x: 2 }] }), parentId: "c" }, { type: "insert-node", node: node("e"), parentId: "r" }]);
    session.close();
    session = StudioSession.open({ projectsRoot: root, name: "p", owner, now });
    const start = strip(session.document);
    for (const operations of [
      [{ type: "set-props", nodeId: "r", set: { q: 9, a: 5 }, unset: ["z"] }],
      [{ type: "move-node", nodeId: "b", parentId: "e", index: 0 }, { type: "set-props", nodeId: "d", unset: ["k"] }],
      [{ type: "remove-node", nodeId: "a" }],
      [{ type: "remove-node", nodeId: "b" }, { type: "insert-node", node: node("f"), parentId: "e" }],
      [{ type: "move-node", nodeId: "e", parentId: null, index: 0 }],
      [{ type: "restore-subtree", rootId: "g", parentId: "e", index: 0, nodes: [{ id: "g", type: "frame", props: {}, children: ["h"] }, { id: "h", type: "frame", props: { deep: { a: [1] } }, parentId: "g" }] }],
    ]) edit(operations);
    const final = strip(session.document);
    while (session.canUndo()) session.undo(owner);
    assert.deepEqual(JSON.parse(strip(session.document)), JSON.parse(start), "undo-all restores the start");
    while (session.canRedo()) session.redo(owner);
    assert.deepEqual(JSON.parse(strip(session.document)), JSON.parse(final), "redo-all restores the end");
    const inMemory = strip(session.document);
    session.close();
    session = StudioSession.open({ projectsRoot: root, name: "p", owner, now });
    // The same document; a clean close checkpoints (#239), so it reads back from a snapshot,
    // whose keys are in canonical order, where the session kept them as edits added them.
    assert.deepEqual(JSON.parse(strip(session.document)), JSON.parse(inMemory), "the persisted state equals the session's");
    // Undo stacks are per actor; a new edit clears the editing actor's redo.
    const agent = { actorId: "agent-1", kind: "agent", accessClass: "service", displayName: "Agent", ownerActorId: "local-user" };
    assert.equal(session.canUndo(agent), false);
    edit([{ type: "insert-node", node: node("tmp"), parentId: null }]);
    edit([{ type: "remove-node", nodeId: "tmp" }]);
    session.undo(owner);
    session.edit(owner, { baseRevision: session.revision, operations: [{ type: "remove-node", nodeId: "tmp" }] });
    assert.equal(session.canRedo(), false, "a new edit clears redo");
    session.undo(owner);
    assert.ok(session.document.nodes.tmp, "undoing the second removal restores tmp");
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("every commit uses a fresh collaboration room, so no fact log accumulates in a session", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-many-")));
  const owner = { actorId: "local-user", kind: "user", accessClass: "member", displayName: "You" };
  const session = StudioSession.open({ projectsRoot: root, name: "p", owner, now, create: {} });
  const original = LocalCollaborationRoom.prototype.commitTransaction;
  const rooms = new Set();
  let calls = 0;
  LocalCollaborationRoom.prototype.commitTransaction = function wrapped(input) {
    calls += 1;
    rooms.add(this);
    // A fresh room has only the facts its state was created with: none.
    assert.equal(this.readSnapshot({ actor: input.actor, transport: input.transport, at: input.at }).activity.length, 0, "the room starts empty");
    return original.call(this, input);
  };
  try {
    session.edit(owner, { baseRevision: 0, operations: [insertFrame("r")] });
    for (let i = 0; i < 200; i += 1) session.edit(owner, { baseRevision: session.revision, operations: [{ type: "set-props", nodeId: "r", set: { i } }] });
    session.undo(owner);
    session.redo(owner);
    assert.equal(calls, 203);
    assert.equal(rooms.size, 203, "no room is reused across commits");
  } finally {
    LocalCollaborationRoom.prototype.commitTransaction = original;
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
