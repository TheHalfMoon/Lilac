import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostPool, mcpClient, ok } from "./support/host-api.mjs";
import { createPrng } from "./support/prng.mjs";

// P08-G6 (#230, founder section P08.6): concurrency and races on the surfaces Ninerr supports,
// proving each semantic it claims and no other (docs/evidence/P08_G6_CONCURRENCY_2026-10-10.md).
// The studio host is the single writer of one open project; requests to it may arrive at the
// same time, from the editor, other tabs and agents. What it promises:
// - an edit carries the revision it was made at, and one made at a stale revision is refused
//   (409 stale-revision), never rebased or merged: of edits made at one revision, one wins;
// - each single-use token (an import review, a write-back preview) is used at most once;
// - every request ends in a result or a typed refusal, never a server error, and the project
//   on disk is always the one the host shows;
// - every change reaches the editor's event stream, once, in order;
// - an agent's call waiting for the person changes nothing once another project is open.
// Changes for another project and a second host on the folder are pinned in
// tests/project-scope.test.mjs and tests/folder-lock.test.mjs.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();
const insert = (id, baseRevision) => ({ baseRevision, intent: `Add ${id}`, operations: [{ type: "insert-node", node: { id, type: "text", props: { text: id } }, parentId: null }] });
const outcomes = (results) => results.reduce((map, { status, json }) => {
  const key = `${status} ${json?.error?.code ?? "ok"}`;
  return { ...map, [key]: (map[key] ?? 0) + 1 };
}, {});

// An agent's tool call as an HTTP-like outcome: applied, or refused with a known reason. Any
// other error (Ninerr's "could not complete the call") is kept as such, so it fails the test.
// The only refusal these calls can meet here: the layer an undo or the person just removed.
const AGENT_REFUSALS = [/^no node "/u];
const agentOutcome = (result) => {
  if (!result.isError) return { status: 200, json: result };
  const text = result.content[0].text;
  if (AGENT_REFUSALS.some((pattern) => pattern.test(text))) return { status: 409, json: { error: { code: "agent-refused" } } };
  return { status: 500, json: { error: { code: `agent-error: ${text.slice(0, 80)}` } } };
};

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
async function assertPersistedAsShown({ call, host, projects, pool }, name = "race") {
  const shown = await ok(call("GET", "/api/document"));
  await ok(call("POST", "/api/projects/close"));
  await pool.close(host);
  const reopened = await pool.open(projects);
  await ok(reopened.call("POST", "/api/projects/open", { name }));
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

test("edits of one chain sent in a shuffled order: each applies only at the revision it was made at, never rebased", () => withHost(async (running) => {
  // Later links often reach the host before the ones they follow; those must be refused, not
  // moved onto the revision they find.
  const order = createPrng(230_006).shuffle(Array.from({ length: 25 }, (_, index) => index));
  const results = new Array(25);
  await Promise.all(order.map(async (index) => {
    results[index] = await running.call("POST", "/api/edit", insert(`chain-${index}`, index));
  }));
  const applied = [];
  for (const [index, result] of results.entries()) {
    if (result.status !== 200) {
      assert.equal(result.json?.error?.code, "stale-revision", JSON.stringify(result.json));
      continue;
    }
    // Made at revision `index`, it is applied as revision `index + 1` or not at all.
    assert.equal(result.json.revision, index + 1, `chain-${index}`);
    applied.push(index);
  }
  // The applied ones are the chain's first links, with no gap; some later ones were refused.
  assert.deepEqual(applied, Array.from({ length: applied.length }, (_, index) => index));
  assert.ok(applied.length < 25, "some links reached the host before the ones they follow, and were refused");
  const { revision, document } = await assertPersistedAsShown(running);
  assert.equal(revision, applied.length);
  assert.deepEqual(Object.keys(document.nodes).sort(), applied.map((index) => `chain-${index}`).sort());
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

test("a person's edits, undos and redos and an agent's changes, all at once: known outcomes only, and the project on disk is the one shown", (t) => withHost(async (running) => {
  const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Racer" }));
  const agent = mcpClient(running.host.mcpUrl, token);
  await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "race", version: "1" } });
  // The editor's event stream, open before the first change (the host registers it as it answers).
  const events = [];
  const controller = new AbortController();
  const response = await fetch(`${running.host.url}/api/events?token=${running.host.token}`, { signal: controller.signal });
  const streaming = (async () => {
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
  })().catch(() => {});
  const prng = createPrng(230_007);
  const statuses = {};
  let personApplied = 0;
  for (let round = 0; round < 16; round += 1) {
    const { revision, document } = await ok(running.call("GET", "/api/document"));
    const ids = Object.keys(document.nodes);
    // Each round sends its requests in a different order, so different ones win.
    const requests = prng.shuffle([
      () => running.call("POST", "/api/edit", insert(`p-${round}-a`, revision)),
      () => running.call("POST", "/api/edit", insert(`p-${round}-b`, revision)),
      () => running.call("POST", "/api/undo"),
      () => running.call("POST", "/api/redo"),
      () => agent.tool("create_frame", { name: `Agent ${round}`, width: 10, height: 10 }).then(agentOutcome),
      ...(ids.length > 0 ? [() => agent.tool("set_text", { nodeId: ids[round % ids.length], text: `Set ${round}` }).then(agentOutcome)] : []),
    ]);
    const results = await Promise.all(requests.map((send) => send()));
    personApplied += results.filter((result) => result.status === 200 && /^Add p-/u.test(result.json?.intent ?? "")).length;
    for (const [key, count] of Object.entries(outcomes(results))) statuses[key] = (statuses[key] ?? 0) + count;
  }
  t.diagnostic(`outcomes over 16 rounds: ${JSON.stringify(statuses)}; the person's edits applied: ${personApplied}`);
  // Only these outcomes: applied, stale, nothing to undo or redo, or an agent's known refusal.
  for (const key of Object.keys(statuses)) assert.ok(["200 ok", "409 stale-revision", "409 nothing-to-undo", "409 nothing-to-redo", "409 agent-refused"].includes(key), key);
  assert.ok(personApplied > 0, "some of the person's edits won a round");
  const final = await ok(running.call("GET", "/api/document"));
  // Every change reached the stream once, in revision order.
  for (let tries = 0; tries < 100 && events.length < final.revision; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await streaming;
  assert.deepEqual(events.map((event) => event.revision), Array.from({ length: final.revision }, (_, index) => index + 1));
  await assertPersistedAsShown(running);
}));

test("an agent's deletion waiting for the person changes nothing once another project is open", () => withHost(async (running) => {
  const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Deleter" }));
  const agent = mcpClient(running.host.mcpUrl, token);
  await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "race", version: "1" } });
  const frame = (await agent.tool("create_frame", { name: "Keep me", width: 10, height: 10 })).structuredContent.nodeId;
  // The deletion waits for the person's approval...
  const waiting = agent.tool("delete_layers", { nodeIds: [frame] });
  for (let tries = 0; tries < 100 && (await ok(running.call("GET", "/api/confirmations"))).pending.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await ok(running.call("GET", "/api/confirmations"))).pending.length, 1);
  // ...and the person opens another project instead.
  await ok(running.call("POST", "/api/projects/create", { name: "other" }));
  const result = await waiting;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^The open project changed while the call was waiting\.$/u, "the agent is told why, not that the person declined");
  assert.deepEqual((await ok(running.call("GET", "/api/confirmations"))).pending, []);
  assert.deepEqual(Object.keys((await ok(running.call("GET", "/api/document"))).document.nodes), [], "the other project got nothing");
  await ok(running.call("POST", "/api/projects/open", { name: "race" }));
  assert.ok(Object.hasOwn((await ok(running.call("GET", "/api/document"))).document.nodes, frame), "the frame is still there");
}));
