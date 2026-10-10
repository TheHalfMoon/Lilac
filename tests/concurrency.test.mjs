import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostPool, mcpClient, ok } from "./support/host-api.mjs";

// P08-G6 (#230, founder section P08.6): concurrency and races on the surfaces Ninerr supports,
// proving each semantic it claims and no other (docs/evidence/P08_G6_CONCURRENCY_2026-10-10.md).
// The studio host is the single writer of one open project; requests to it may arrive at the
// same time, from the editor, other tabs and agents. What it promises:
// - an edit carries the revision it was made at, and one made at a stale revision is refused
//   (409 stale-revision), never rebased or merged: of edits made at one revision, one wins;
// - each single-use token (an import review, a write-back preview) is used at most once;
// - every request ends in a result or a typed refusal, never a server error, and the project
//   on disk is always the one the host shows;
// - every change reaches the editor's event stream, once, in order.
// Changes for another project and a second host on the folder are pinned in
// tests/project-scope.test.mjs and tests/folder-lock.test.mjs.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();
const insert = (id, baseRevision) => ({ baseRevision, intent: `Add ${id}`, operations: [{ type: "insert-node", node: { id, type: "text", props: { text: id } }, parentId: null }] });
const outcomes = (results) => results.reduce((map, { status, json }) => {
  const key = `${status} ${json?.error?.code ?? "ok"}`;
  return { ...map, [key]: (map[key] ?? 0) + 1 };
}, {});

async function withHost(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-race-")));
  const projects = join(root, "projects");
  mkdirSync(projects);
  const pool = hostPool(now);
  try {
    const running = await pool.open(projects);
    await ok(running.call("POST", "/api/projects/create", { name: "race" }));
    return await callback({ ...running, root, projects, pool });
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Reopen the project in a new host: it must be exactly what the host showed, at the same revision. */
async function assertPersistedAsShown({ call, host, projects, pool }) {
  const shown = await ok(call("GET", "/api/document"));
  await ok(call("POST", "/api/projects/close"));
  await pool.close(host);
  const reopened = await pool.open(projects);
  await ok(reopened.call("POST", "/api/projects/open", { name: "race" }));
  const persisted = await ok(reopened.call("GET", "/api/document"));
  assert.deepEqual([persisted.revision, persisted.document], [shown.revision, shown.document]);
  return persisted;
}

test("of edits made at one revision, exactly one is applied; the others are refused as stale", () => withHost(async (running) => {
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => running.call("POST", "/api/edit", insert(`same-${index}`, 0))));
  assert.deepEqual(outcomes(results), { "200 ok": 1, "409 stale-revision": 24 });
  const winner = results.findIndex((result) => result.status === 200);
  const { revision, document } = await assertPersistedAsShown(running);
  assert.equal(revision, 1);
  assert.deepEqual(Object.keys(document.nodes), [`same-${winner}`], "only the winner's change is there");
}));

test("edits sent at once, each at the revision the previous one makes, form one unbroken chain", () => withHost(async (running) => {
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => running.call("POST", "/api/edit", insert(`chain-${index}`, index))));
  // Each answer is applied or stale; the applied ones are revisions 1..n, with no gap or repeat.
  for (const result of results) assert.ok(result.status === 200 || result.json?.error?.code === "stale-revision", JSON.stringify(result.json));
  const revisions = results.filter((result) => result.status === 200).map((result) => result.json.revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, Array.from({ length: revisions.length }, (_, index) => index + 1));
  const { revision, document } = await assertPersistedAsShown(running);
  assert.equal(revision, revisions.length);
  assert.equal(Object.keys(document.nodes).length, revisions.length);
}));

test("a single-use import review commits once, however many times it is sent at once", () => withHost(async (running) => {
  const review = await ok(running.call("POST", "/api/import", { html: "<!doctype html><html><body><main><h1>Page</h1></main></body></html>", name: "Page" }));
  const results = await Promise.all(Array.from({ length: 8 }, () => running.call("POST", "/api/import/commit", { proposalId: review.proposalId })));
  assert.deepEqual(outcomes(results), { "200 ok": 1, "404 import-not-found": 7 });
  const { document } = await assertPersistedAsShown(running);
  assert.equal(document.rootIds.length, 1, "one imported page");
}));

test("a single-use write-back preview writes once, however many times it is sent at once", () => withHost(async (running) => {
  const code = join(running.root, "code");
  mkdirSync(code);
  writeFileSync(join(code, "Card.jsx"), "export function Card() {\n  return <section><p>Text</p></section>;\n}\n");
  await ok(running.call("POST", "/api/codebase/connect", { folder: code }));
  await ok(running.call("POST", "/api/codebase/import", { file: "Card.jsx", component: "Card" }));
  const { document, revision } = await ok(running.call("GET", "/api/document"));
  const p = Object.values(document.nodes).find((node) => node.props.tag === "p");
  const section = Object.values(document.nodes).find((node) => node.props.tag === "section");
  await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Retext", operations: [{ type: "set-props", nodeId: p.id, set: { text: "Changed" } }] }));
  const preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }));
  const results = await Promise.all(Array.from({ length: 6 }, () => running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token })));
  assert.deepEqual(outcomes(results), { "200 ok": 1, "409 plan-changed": 5 });
  assert.equal(readFileSync(join(code, "Card.jsx"), "utf8"), "export function Card() {\n  return <section><p>Changed</p></section>;\n}\n");
  await assertPersistedAsShown(running);
}));

test("a person's edits, undos and redos and an agent's changes, all at once: typed outcomes, and the project on disk is the one shown", (t) => withHost(async (running) => {
  const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Racer" }));
  const agent = mcpClient(running.host.mcpUrl, token);
  await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "race", version: "1" } });
  // The editor's event stream, open throughout.
  const events = [];
  const controller = new AbortController();
  const streaming = fetch(`${running.host.url}/api/events?token=${running.host.token}`, { signal: controller.signal }).then(async (response) => {
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        if (fields.event === "change") events.push(JSON.parse(fields.data));
      }
    }
  }).catch(() => {});
  const statuses = {};
  for (let round = 0; round < 12; round += 1) {
    const { revision, document } = await ok(running.call("GET", "/api/document"));
    const ids = Object.keys(document.nodes);
    const requests = [
      running.call("POST", "/api/edit", insert(`p-${round}-a`, revision)),
      running.call("POST", "/api/edit", insert(`p-${round}-b`, revision)),
      running.call("POST", "/api/undo"),
      running.call("POST", "/api/redo"),
      agent.tool("create_frame", { name: `Agent ${round}`, width: 10, height: 10 }).then((result) => ({ status: result.isError ? 409 : 200, json: result.isError ? { error: { code: "agent-refused" } } : result })),
      ...(ids.length > 0 ? [agent.tool("set_text", { nodeId: ids[round % ids.length], text: `Set ${round}` }).then((result) => ({ status: result.isError ? 409 : 200, json: result.isError ? { error: { code: "agent-refused" } } : result }))] : []),
    ];
    for (const [key, count] of Object.entries(outcomes(await Promise.all(requests)))) statuses[key] = (statuses[key] ?? 0) + count;
  }
  t.diagnostic(`outcomes over 12 rounds: ${JSON.stringify(statuses)}`);
  // Every outcome is a result or a typed refusal.
  for (const key of Object.keys(statuses)) assert.match(key, /^(200 ok|409 [a-z-]+|400 [a-z-]+)$/u, key);
  const final = await ok(running.call("GET", "/api/document"));
  // Every change reached the stream once, in revision order.
  for (let tries = 0; tries < 100 && events.length < final.revision; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await streaming;
  assert.deepEqual(events.map((event) => event.revision), Array.from({ length: final.revision }, (_, index) => index + 1));
  await assertPersistedAsShown(running);
}));
