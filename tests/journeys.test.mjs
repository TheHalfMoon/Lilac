import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument, serializeDocument, validateDocument } from "../packages/document-model/src/index.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";
import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { createPrng, propertySeeds } from "./support/prng.mjs";

// P08-G1 (#230): the five end-to-end journeys of the founder's P08.1, each run once per seed
// with generated content, through the studio host's own API, as the editor and an MCP agent
// use it. "Exact state" is the canonical serialization of the document together with every
// file of the project's store but the lock: after a close and a reopen in a new host, it must
// be byte-identical. The generated sessions (journeys A and E) also keep a reference model
// written in this file, sharing no code with the host, so a change the host dropped, altered or
// wrongly refused cannot pass. The
// history panel lists only the changes since the project was opened (#231), so it is not part
// of the persisted state. Each seed is its own subtest; replay one with
// NINERR_PROPERTY_SEED=<seed>. NINERR_JOURNEY_RUNS sets how many seeds each journey runs.

const runsText = process.env.NINERR_JOURNEY_RUNS ?? "3";
if (!/^[1-9]\d*$/u.test(runsText)) throw new Error(`NINERR_JOURNEY_RUNS must be a positive integer, got ${JSON.stringify(runsText)}`);
const RUNS = Number(runsText);
const HOST_CHILD = fileURLToPath(new URL("./support/host-child.mjs", import.meta.url));
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "ninerr-journey-")));

function client(base, token) {
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  };
}

function mcpClient(mcpUrl, token) {
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return (await response.json()).result;
  };
  return { rpc, tool: (name, args) => rpc("tools/call", { name, arguments: args }) };
}

/** Every host a seed starts, so its `finally` closes them all, whatever failed. */
function hostPool() {
  const hosts = [];
  return {
    async open(root) {
      const host = await startStudioHost({ projectsRoot: root, now });
      hosts.push(host);
      return { host, call: client(host.url, host.token) };
    },
    async closeAll() {
      for (const host of hosts.splice(0)) await host.close().catch(() => {});
    },
  };
}

async function ok(promise, what) {
  const result = await promise;
  assert.equal(result.status, 200, `${what}: ${JSON.stringify(result.json)}`);
  return result.json;
}

const content = (document) => serializeDocument({ ...document, revision: 0 });

/** The exact state: the canonical document and every store file but the lock, byte for byte. */
async function exactState(call, root, project) {
  const { revision, document } = await ok(call("GET", "/api/document"), "document");
  const store = join(root, project, PROJECT_FILES.directory);
  const files = {};
  for (const name of readdirSync(store).sort()) {
    if (name === PROJECT_FILES.lock || name === PROJECT_FILES.objects) continue;
    files[name] = readFileSync(join(store, name), "utf8");
  }
  const objects = readdirSync(join(store, PROJECT_FILES.objects), { recursive: true }).map(String).sort();
  return { revision, document: serializeDocument(document), files, objects };
}

/** Close the project and its host, start a new host on the same folder, and reopen it. */
async function reopen(pool, running, root, project) {
  await ok(running.call("POST", "/api/projects/close"), "close");
  await running.host.close();
  const next = await pool.open(root);
  await ok(next.call("POST", "/api/projects/open", { name: project }), "reopen");
  return next;
}

/** A generated edit against the current document: insert, rename, retext, restyle, move or remove. */
function generatedEdit(prng, document, counter) {
  const ids = Object.keys(document.nodes);
  const kind = ids.length < 3 ? "insert" : prng.pick(["insert", "insert", "rename", "text", "style", "move", "remove"]);
  const anyParent = () => (ids.length === 0 || prng.next() < 0.3 ? null : prng.pick(ids));
  if (kind === "insert") {
    const id = `n${counter.next++}`;
    const node = prng.next() < 0.5
      ? { id, type: "frame", props: { name: `Frame ${id}`, tag: "div", style: { width: `${prng.int(10, 400)}px` } } }
      : { id, type: "text", props: { name: `Text ${id}`, tag: prng.pick(["p", "h1", "span"]), text: prng.pick(["Hello", "Prix: 12 €", "مرحبا", "שלום", "é", "😀 ok", ""]) } };
    return { intent: `Insert ${id}`, operations: [{ type: "insert-node", node, parentId: anyParent(), index: prng.pick([undefined, 0, 99]) }] };
  }
  const nodeId = prng.pick(ids);
  if (kind === "rename") return { intent: `Rename ${nodeId}`, operations: [{ type: "set-props", nodeId, set: { name: `Renamed ${prng.int(0, 999)}` } }] };
  if (kind === "text") return { intent: `Text ${nodeId}`, operations: [{ type: "set-props", nodeId, set: { text: prng.pick(["One", "Two\nlines", "‮bidi", "  spaced  "]) } }] };
  if (kind === "style") return { intent: `Style ${nodeId}`, operations: [{ type: "set-props", nodeId, set: { style: { color: prng.pick(["#112233", "red", "rgb(1, 2, 3)"]), padding: `${prng.int(0, 32)}px` } } }] };
  if (kind === "move") return { intent: `Move ${nodeId}`, operations: [{ type: "move-node", nodeId, parentId: anyParent(), index: prng.pick([undefined, 0, 1]) }] };
  return { intent: `Remove ${nodeId}`, operations: [{ type: "remove-node", nodeId }] };
}

/** The tree and props of a document: what the reference model below tracks. */
const shape = (document) => ({
  rootIds: [...document.rootIds],
  nodes: Object.fromEntries(Object.entries(document.nodes).map(([id, node]) => [id, { type: node.type, parentId: node.parentId, children: [...node.children], props: structuredClone(node.props) }])),
});

/**
 * A reference model of the generated operations, written here from their documented meaning
 * and sharing no code with the host (which applies edits with @ninerr/history). It returns the
 * next shape, or null for an edit the host must refuse: a move into the node's own subtree, or
 * an index past the end of the siblings.
 */
function modelApply(current, operations) {
  const next = structuredClone(current);
  const siblings = (parentId) => (parentId === null ? next.rootIds : next.nodes[parentId].children);
  const place = (id, parentId, index) => {
    const list = siblings(parentId);
    const at = index ?? list.length;
    if (at > list.length) return false;
    list.splice(at, 0, id);
    next.nodes[id].parentId = parentId;
    return true;
  };
  const unlink = (id) => {
    const list = siblings(next.nodes[id].parentId);
    list.splice(list.indexOf(id), 1);
  };
  for (const operation of operations) {
    if (operation.type === "insert-node") {
      const { id, type, props } = operation.node;
      next.nodes[id] = { type, parentId: null, children: [], props: structuredClone(props) };
      if (!place(id, operation.parentId ?? null, operation.index)) return null;
    } else if (operation.type === "set-props") {
      Object.assign(next.nodes[operation.nodeId].props, structuredClone(operation.set));
    } else if (operation.type === "move-node") {
      const target = operation.parentId ?? null;
      for (let at = target; at !== null; at = next.nodes[at].parentId) if (at === operation.nodeId) return null;
      unlink(operation.nodeId);
      if (!place(operation.nodeId, target, operation.index)) return null;
    } else if (operation.type === "remove-node") {
      unlink(operation.nodeId);
      const drop = (id) => {
        for (const child of next.nodes[id].children) drop(child);
        delete next.nodes[id];
      };
      drop(operation.nodeId);
    } else {
      throw new Error(`the model has no ${operation.type}`);
    }
  }
  return next;
}

/**
 * Apply generated edits, undos and redos through the host, and the same to the reference model,
 * which starts from the host's starting shape. The host must accept exactly the edits the model
 * accepts (refusing the others with 400), and undo or redo exactly when the model has something
 * to undo or redo (409 otherwise); at the end its document must have the model's shape.
 */
async function generatedSession(call, prng, steps) {
  const counter = { next: 0 };
  const start = (await ok(call("GET", "/api/document"), "document")).document;
  const tally = { edits: 0, undos: 0, redos: 0, refused: 0, model: shape(start) };
  const past = [];
  const future = [];
  for (let step = 0; step < steps; step += 1) {
    const roll = prng.next();
    if (roll < 0.25) {
      const kind = roll < 0.15 ? "undo" : "redo";
      const [from, to] = kind === "undo" ? [past, future] : [future, past];
      const result = await call("POST", `/api/${kind}`);
      assert.equal(result.status, from.length > 0 ? 200 : 409, `${kind}: ${JSON.stringify(result.json)}`);
      if (result.status === 200) {
        tally[`${kind}s`] += 1;
        to.push(tally.model);
        tally.model = from.pop();
      }
      continue;
    }
    const { revision, document } = await ok(call("GET", "/api/document"), "document");
    assert.deepEqual(shape(document), tally.model, "the host's document has the reference model's shape before each edit");
    const edit = generatedEdit(prng, document, counter);
    const expected = modelApply(tally.model, edit.operations);
    const result = await call("POST", "/api/edit", { baseRevision: revision, ...edit });
    assert.equal(result.status, expected === null ? 400 : 200, `${edit.intent}: ${JSON.stringify(result.json)}`);
    if (expected === null) {
      tally.refused += 1;
      continue;
    }
    tally.edits += 1;
    past.push(tally.model);
    future.length = 0;
    tally.model = expected;
  }
  assert.deepEqual(shape((await ok(call("GET", "/api/document"), "document")).document), tally.model, "the host's document has the reference model's shape");
  return tally;
}

/** Run `journey` once per seed, each as its own subtest with its own folder and hosts. */
function perSeed(name, journey) {
  test(name, async (t) => {
    for (const seed of propertySeeds(RUNS)) {
      await t.test(`seed ${seed}`, async () => {
        const root = scratch();
        const pool = hostPool();
        try {
          await journey({ seed, prng: createPrng(seed), root, pool });
        } finally {
          await pool.closeAll();
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  });
}

perSeed("Journey A: create, edit, save, close and reopen; the exact state survives, and matches a reference model", async ({ prng, root, pool }) => {
  let running = await pool.open(root);
  await ok(running.call("POST", "/api/projects/create", { name: "work", title: "Work" }), "create");
  const tally = await generatedSession(running.call, prng, 40);
  assert.ok(tally.edits > 10, "the session made real changes");
  const before = await exactState(running.call, root, "work");
  // Every accepted edit, undo and redo is one revision, and none of the refused edits is.
  assert.equal(before.revision, tally.edits + tally.undos + tally.redos);
  running = await reopen(pool, running, root, "work");
  assert.deepEqual(await exactState(running.call, root, "work"), before, "the reopened state is exact");
  // The reopened document is still the reference model's, read from the store this time.
  assert.deepEqual(shape((await ok(running.call("GET", "/api/document"), "document")).document), tally.model, "the reopened document has the reference model's shape");
  running = await reopen(pool, running, root, "work");
  assert.deepEqual(await exactState(running.call, root, "work"), before, "a second reopen changes nothing");
  // The reopened project keeps working.
  await ok(running.call("POST", "/api/edit", { baseRevision: before.revision, intent: "After reopen", operations: [{ type: "insert-node", node: { id: "after", type: "frame", props: { name: "After" } }, parentId: null }] }), "edit after reopen");
});

const PAGE = (title, line) => `<!doctype html><html><head><title>${title}</title><style>.lead { color: #334455 }</style></head>
<body><main><h1>${title}</h1><p class="lead" style="margin: 4px">${line}</p><ul><li>One</li><li>Two</li></ul></main></body></html>`;

/** The texts under `nodeId`, in document order. */
function textsUnder(document, nodeId) {
  const node = document.nodes[nodeId];
  return [...(node.type === "text" ? [node.props.text] : []), ...(node.children ?? []).flatMap((child) => textsUnder(document, child))];
}

perSeed("Journey B: import a page, inspect, edit, save, reopen, export it as code and bring the code back", async ({ prng, root, pool }) => {
  let running = await pool.open(root);
  const title = prng.pick(["Pricing", "Über uns", "Contact"]);
  await ok(running.call("POST", "/api/projects/create", { name: "site" }), "create");
  const review = await ok(running.call("POST", "/api/import", { html: PAGE(title, "First line"), name: `${title} page` }), "import review");
  await ok(running.call("POST", "/api/import/commit", { proposalId: review.proposalId }), "import commit");
  // Inspect: the page's structure came in as layers.
  let { revision, document } = await ok(running.call("GET", "/api/document"), "document");
  const nodes = Object.values(document.nodes);
  const byTag = (tag) => nodes.filter((node) => node.props.tag === tag);
  assert.equal(byTag("h1").length, 1);
  assert.equal(byTag("li").length, 2);
  const paragraph = byTag("p")[0];
  assert.equal(paragraph.props.attributes.class, "lead");
  assert.equal(paragraph.props.style.margin, "4px");
  // Edit the paragraph's text: an imported paragraph keeps its words in a child text layer.
  const edited = `Edited ${prng.int(100, 999)}`;
  await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Edit the paragraph", operations: [{ type: "set-props", nodeId: paragraph.children[0], set: { text: edited } }] }), "edit");
  const before = await exactState(running.call, root, "site");
  running = await reopen(pool, running, root, "site");
  assert.deepEqual(await exactState(running.call, root, "site"), before, "the imported, edited page reopens exactly");
  ({ document } = await ok(running.call("GET", "/api/document"), "document"));
  const contains = (nodeId) => nodeId === paragraph.id || (document.nodes[nodeId].children ?? []).some(contains);
  const pageId = document.rootIds.find(contains);
  // Export the page as code: deterministic, with the edit, the class, the style and every text.
  const exported = await ok(running.call("POST", "/api/code/export", { nodeId: pageId }), "export");
  assert.deepEqual(await ok(running.call("POST", "/api/code/export", { nodeId: pageId }), "export again"), exported, "export is deterministic");
  const code = exported.code;
  // The page's texts, in order: its <title>, its heading, the edited paragraph and the list.
  assert.deepEqual(textsUnder(document, pageId).filter((text) => text.trim() !== ""), [title, title, edited, "One", "Two"]);
  for (const text of textsUnder(document, pageId)) assert.ok(code.includes(text), `the export has ${JSON.stringify(text)}`);
  assert.ok(!code.includes("First line"), "and not the replaced text");
  assert.match(code, /<h1\b/u);
  assert.match(code, /className="lead"/u);
  assert.match(code, /margin/u);
  // Bring the exported code back, and export what came back: the very same code. (Code comes
  // in with each element's text on the element, where an HTML import keeps it in a child text
  // layer, #235; the code is the same either way.)
  const back = await ok(running.call("POST", "/api/code/import", { code }), "bring the code back");
  ({ document } = await ok(running.call("GET", "/api/document"), "document"));
  const [component] = document.nodes[back.frameId].children;
  assert.equal((await ok(running.call("POST", "/api/code/export", { nodeId: component }), "export the code that came back")).code, code, "the code round-trips exactly");
});

const CARD = (heading) => `export function PriceCard() {
  return (
    <section className="card" style="padding: 16px; background: #f4f0ff">
      <h2>${heading}</h2>
      <p title="Plan">Everything in Free, and more.</p>
    </section>
  );
}
`;

perSeed("Journey C: connect a codebase, bring a component in, edit, review the diff, write back, edit outside, reconcile", async ({ prng, root, pool }) => {
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const card = join(code, "Card.jsx");
  writeFileSync(card, CARD("Pro"));
  let running = await pool.open(projects);
  await ok(running.call("POST", "/api/projects/create", { name: "app" }), "create");
  await ok(running.call("POST", "/api/codebase/connect", { folder: code }), "connect");
  await ok(running.call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" }), "bring in");
  let { revision, document } = await ok(running.call("GET", "/api/document"), "document");
  const section = Object.values(document.nodes).find((node) => node.props.tag === "section");
  const h2 = Object.values(document.nodes).find((node) => node.props.tag === "h2");
  const heading = prng.pick(["Team", "Business", "Équipe"]);
  const retitle = async (text) => {
    ({ revision } = await ok(running.call("GET", "/api/document"), "document"));
    await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Retitle", operations: [{ type: "set-props", nodeId: h2.id, set: { text } }] }), "edit");
  };
  await retitle(heading);
  // Review: the diff shows exactly the edit, and a preview writes nothing.
  let preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview");
  assert.deepEqual(preview.changes.map((change) => change.field), ["text"]);
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.diff, new RegExp(`\\n\\+      <h2>${heading}</h2>\\n`, "u"));
  assert.equal(readFileSync(card, "utf8"), CARD("Pro"));
  await ok(running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "write back");
  assert.equal(readFileSync(card, "utf8"), CARD(heading), "the file has exactly the reviewed change");
  // An edit outside Ninerr while it is closed, to a field Ninerr did not change: reconciled.
  await ok(running.call("POST", "/api/projects/close"), "close");
  await running.host.close();
  writeFileSync(card, readFileSync(card, "utf8").replace("Everything in Free, and more.", "All of Free, plus more."));
  running = await pool.open(projects);
  await ok(running.call("POST", "/api/projects/open", { name: "app" }), "reopen");
  preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview after the outside edit");
  assert.deepEqual(preview.changes, [], "nothing of Ninerr's is pending");
  assert.deepEqual(preview.conflicts, []);
  // An edit outside Ninerr while it is open, to the same heading Ninerr changes: a conflict,
  // reported and never written over.
  await retitle(`${heading} Plus`);
  const outside = readFileSync(card, "utf8").replace(`<h2>${heading}</h2>`, "<h2>Changed outside</h2>");
  writeFileSync(card, outside);
  preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview with a conflict");
  assert.deepEqual(preview.changes, [], "the conflicting field is not offered as a change");
  assert.deepEqual(preview.conflicts.map((conflict) => [conflict.nodeId, conflict.field]), [[h2.id, "text"]], "the conflict names the heading's text");
  assert.deepEqual(preview.matched, []);
  // Inspect it: Ninerr's text, the text both last agreed on, and the file's are all different.
  // (The conflict itself carries only a reason, not these values: #236.)
  assert.equal(preview.conflicts[0].reason, "changed both here and in the file");
  ({ document } = await ok(running.call("GET", "/api/document"), "document"));
  assert.deepEqual([document.nodes[h2.id].props.text, document.nodes[h2.id].props.codeSource.base.text], [`${heading} Plus`, heading]);
  assert.match(readFileSync(card, "utf8"), /<h2>Changed outside<\/h2>/u);
  const refused = await running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token });
  assert.equal(refused.status, 409, "with only a conflict there is nothing to write");
  assert.equal(refused.json.error.code, "nothing-to-write");
  assert.equal(readFileSync(card, "utf8"), outside, "the outside edit is never written over");
  // Resolving it: take the file's text, so the two agree; mark the field as matching, which
  // moves its base and leaves the file as it is; then a later change is written as usual.
  await retitle("Changed outside");
  preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview after taking the file's text");
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.matched.map((entry) => entry.field), ["text"]);
  const marked = await ok(running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "mark as matching");
  assert.equal(marked.written, 0);
  assert.equal(marked.matched, 1);
  assert.equal(readFileSync(card, "utf8"), outside, "marking writes nothing to the file");
  // The heading's base moved to the file's text, and nothing is left pending.
  ({ document } = await ok(running.call("GET", "/api/document"), "document"));
  assert.equal(document.nodes[h2.id].props.codeSource.base.text, "Changed outside", "the base advanced to the agreed text");
  assert.equal(document.nodes[h2.id].props.codeSource.pending, undefined);
  preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview after marking");
  assert.deepEqual([preview.changes, preview.conflicts, preview.matched], [[], [], []], "nothing is left to write, mark or resolve");
  // The field is writable again: a later change is a change, not a conflict (the bug the
  // first run of this journey found, fixed in #234).
  await retitle(`${heading} Final`);
  preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "final preview");
  assert.deepEqual(preview.changes.map((change) => [change.nodeId, change.field]), [[h2.id, "text"]]);
  assert.deepEqual(preview.conflicts, [], "no conflict remains on the heading");
  await ok(running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "final write");
  const final = readFileSync(card, "utf8");
  assert.equal(final, outside.replace("<h2>Changed outside</h2>", `<h2>${heading} Final</h2>`), "exactly the heading changed, and the earlier outside change is kept");
  assert.match(final, /All of Free, plus more\./u);
  // Exact state survives one more reopen, and the file and the project still agree.
  const before = await exactState(running.call, projects, "app");
  running = await reopen(pool, running, projects, "app");
  assert.deepEqual(await exactState(running.call, projects, "app"), before);
  assert.equal(JSON.parse(before.document).nodes[h2.id].props.codeSource.base.text, `${heading} Final`);
  preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview after the last reopen");
  assert.deepEqual([preview.changes, preview.conflicts, preview.matched], [[], [], []]);
  assert.equal(readFileSync(card, "utf8"), final, "reopening writes nothing");
});

perSeed("Journey D: an agent over MCP inspects and edits; the person reviews, accepts, undoes and redoes; it all persists", async ({ prng, root, pool }) => {
  let running = await pool.open(root);
  const documentNow = async () => (await ok(running.call("GET", "/api/document"), "document")).document;
  await ok(running.call("POST", "/api/projects/create", { name: "agentic" }), "create");
  const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Journey agent" }), "connect an agent");
  let agent = mcpClient(running.host.mcpUrl, token);
  await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } });
  // Inspect, then mutate.
  assert.equal((await agent.tool("project_info", {})).isError, undefined);
  const frame = (await agent.tool("create_frame", { name: "Board", width: prng.int(200, 800), height: 400 })).structuredContent.nodeId;
  let { revision } = await ok(running.call("GET", "/api/document"), "document");
  await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Add title", operations: [{ type: "insert-node", node: { id: "title", type: "text", props: { tag: "h1", text: "Hello" } }, parentId: frame, index: 0 }] }), "person's edit");
  const agentText = prng.pick(["Welcome", "Bienvenue", "ようこそ"]);
  assert.equal((await agent.tool("set_text", { nodeId: "title", text: agentText })).isError, undefined);
  // Review: the agent's change is attributed to it.
  const retitle = (await ok(running.call("GET", "/api/history"), "history")).entries.at(-1);
  assert.equal(retitle.actorKind, "agent");
  assert.equal(retitle.tool, "set_text");
  ({ revision } = await ok(running.call("GET", "/api/document"), "document"));
  await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Scratch", operations: [{ type: "insert-node", node: { id: "scratch", type: "frame", props: { name: "Scratch" } }, parentId: null }] }), "scratch");
  const withScratch = content(await documentNow());
  // A consequential call waits for the person, who sees exactly what it will do and accepts.
  const deleting = agent.tool("delete_layers", { nodeIds: ["scratch"] });
  deleting.catch(() => {}); // awaited below; a failed assertion first must not leave it unhandled
  let pending = [];
  for (let tries = 0; tries < 200 && pending.length === 0; tries += 1) {
    ({ pending } = await ok(running.call("GET", "/api/confirmations"), "confirmations"));
    if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pending.length, 1, "the deletion asks the person");
  assert.match(pending[0].summary, /^Delete 1 layer: Scratch\b/u);
  assert.equal(pending[0].agentName, "Journey agent");
  await ok(running.call("POST", "/api/confirmations/decide", { id: pending[0].id, approve: true }), "accept");
  assert.equal((await deleting).isError, undefined);
  const withoutScratch = content(await documentNow());
  assert.notEqual(withoutScratch, withScratch);
  // Undo the agent's latest change, the accepted deletion (a revert by the person, since undo
  // is per actor), then undo and redo that revert. Each lands on exactly one known document.
  const deletion = (await ok(running.call("GET", "/api/history"), "history")).entries.at(-1);
  assert.equal(deletion.tool, "delete_layers");
  assert.equal(deletion.actorKind, "agent", "the accepted deletion is the agent's");
  assert.equal(deletion.actorName, "Journey agent");
  assert.deepEqual(deletion.affectedNodeIds, ["scratch"]);
  const reverted = await ok(running.call("POST", "/api/revert", { transactionId: deletion.transactionId }), "revert the agent's deletion");
  assert.equal(reverted.revertOf, deletion.transactionId, "the revert is of the accepted deletion");
  assert.equal(reverted.actorKind, "user");
  assert.equal(content(await documentNow()), withScratch, "the revert restores the document before the deletion");
  const undone = await ok(running.call("POST", "/api/undo"), "undo the revert");
  assert.equal(undone.undoOf, reverted.transactionId, "the undo takes back that revert, not the person's earlier edit");
  assert.equal(content(await documentNow()), withoutScratch, "undoing the revert is the deletion again");
  const redone = await ok(running.call("POST", "/api/redo"), "redo the revert");
  assert.equal(redone.redoOf, reverted.transactionId);
  assert.equal(content(await documentNow()), withScratch, "redoing it restores the document again");
  // The deletion was taken back once, so it cannot be reverted twice.
  assert.equal((await running.call("POST", "/api/revert", { transactionId: deletion.transactionId })).json.error.code, "not-revertible");
  // Persist and reopen: exact, and the agent's credential still works.
  const before = await exactState(running.call, root, "agentic");
  running = await reopen(pool, running, root, "agentic");
  assert.deepEqual(await exactState(running.call, root, "agentic"), before, "the agent session reopens exactly");
  assert.equal(content(JSON.parse(before.document)), withScratch, "what persisted is the reverted document");
  // Attribution persisted: the journal read back after the reopen names the agent and its tool
  // for the deletion, and the person for the revert, the undo and the redo.
  const journal = new Map(before.files[PROJECT_FILES.journal].trim().split("\n").map((line) => JSON.parse(line).entry.transaction).map((entry) => [entry.id, entry]));
  assert.deepEqual([journal.get(deletion.transactionId).actor, journal.get(deletion.transactionId).tool], [deletion.actor, "delete_layers"]);
  assert.notEqual(deletion.actor, reverted.actor);
  // So do the links: the revert names the deletion, and the undo and the redo name the revert.
  for (const [event, tool, link, of] of [[reverted, "ninerr:revert", "revertOf", deletion], [undone, "ninerr:undo", "undoOf", reverted], [redone, "ninerr:redo", "redoOf", reverted]]) {
    const entry = journal.get(event.transactionId);
    assert.deepEqual([entry.actor, entry.tool, entry.metadata.ninerr[link]], [reverted.actor, tool, of.transactionId]);
  }
  agent = mcpClient(running.host.mcpUrl, token);
  assert.equal((await agent.tool("layer_details", { nodeId: "title" })).structuredContent.props.text, agentText, "the agent reads its own change");
  // Undo and revert are per session (#231): after a reopen the agent's earlier change cannot
  // be reverted, and says so.
  const late = await running.call("POST", "/api/revert", { transactionId: retitle.transactionId });
  assert.equal(late.status, 409);
  assert.equal(late.json.error.code, "not-revertible");
});

const TORN = '{"seq":999999,"entry":{"transaction":{"id":"torn';

/** A host in a child process, so it can be killed outright. Killed on any startup failure. */
async function startChild(projects, children) {
  const child = spawn(process.execPath, [HOST_CHILD, projects], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve(signal ?? code)));
  for (let tries = 0; tries < 500 && !out.includes("\n"); tries += 1) {
    if (child.exitCode !== null) throw new Error(`the host exited: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!out.includes("\n")) {
    child.kill("SIGKILL");
    throw new Error(`the host printed no address: ${err}`);
  }
  const info = JSON.parse(out.split("\n")[0]);
  return { exited, call: client(info.url, info.token), kill: async () => { child.kill("SIGKILL"); return exited; }, stop: async () => { child.kill("SIGTERM"); return exited; } };
}

test("Journey E: a crash during a burst of edits recovers every confirmed change, and nothing partial", async (t) => {
  for (const seed of propertySeeds(RUNS)) {
    await t.test(`seed ${seed}`, async () => {
      const projects = scratch();
      const children = [];
      try {
        const prng = createPrng(seed);
        let host = await startChild(projects, children);
        await ok(host.call("POST", "/api/projects/create", { name: "crashy" }), "create");
        await generatedSession(host.call, prng, 15);
        const start = (await ok(host.call("GET", "/api/document"), "document")).revision;
        // A burst of edits, killed once part of it is confirmed, at a point the seed fixes.
        const killAfter = prng.int(1, 5);
        let confirmed = start;
        let confirmedBursts = 0;
        let stopped = false;
        const burst = (async () => {
          for (let index = 0; index < 500 && !stopped; index += 1) {
            const result = await host.call("POST", "/api/edit", { baseRevision: confirmed, intent: `Burst ${index}`, operations: [{ type: "insert-node", node: { id: `b${index}`, type: "frame", props: { name: `B${index}` } }, parentId: null }] }).catch(() => null);
            if (result === null || result.status !== 200) return;
            confirmed = result.json.revision;
            confirmedBursts = index + 1;
          }
        })();
        const deadline = Date.now() + 10_000;
        while (confirmedBursts < killAfter && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
        await host.kill();
        stopped = true;
        await burst;
        assert.ok(confirmedBursts >= killAfter, `part of the burst was confirmed before the crash (${confirmedBursts})`);
        // The write the kill interrupted, left torn at the end of the journal.
        const journal = join(projects, "crashy", PROJECT_FILES.directory, PROJECT_FILES.journal);
        // Complete entries end in a newline; the kill itself may have torn the in-flight one.
        const complete = (readFileSync(journal, "utf8").match(/\n/gu) ?? []).length;
        appendFileSync(journal, TORN);
        // Restart: the dead session's lock is refused until it is taken over with a reason.
        host = await startChild(projects, children);
        const refused = await host.call("POST", "/api/projects/open", { name: "crashy" });
        assert.equal(refused.status, 409, JSON.stringify(refused.json));
        assert.match(refused.json.error.code, /lock/u);
        const opened = await ok(host.call("POST", "/api/projects/open", { name: "crashy", breakStaleLock: { reason: "Journey E crash" } }), "recover");
        // The reopen explains itself: the torn tail it dropped, and the lock taken over and why.
        assert.ok(opened.recovery.tornTailBytes >= TORN.length, `the torn tail is reported (${opened.recovery.tornTailBytes} bytes)`);
        assert.equal(opened.recovery.lockOverride.reason, "Journey E crash");
        const recovered = await exactState(host.call, projects, "crashy");
        assert.equal(recovered.revision, complete, "the recovered revision is every complete journal entry");
        assert.ok(recovered.revision >= confirmed, `every confirmed change survived (confirmed ${confirmed}, recovered ${recovered.revision})`);
        // Every confirmed burst layer is there; at most the one edit in flight at the kill beyond them.
        const nodes = JSON.parse(recovered.document).nodes;
        for (let index = 0; index < confirmedBursts; index += 1) assert.ok(nodes[`b${index}`], `confirmed burst layer b${index} survived`);
        const beyond = Object.keys(nodes).filter((id) => /^b\d+$/u.test(id) && Number(id.slice(1)) >= confirmedBursts);
        assert.ok(beyond.length <= 1, `at most the in-flight edit beyond the confirmed ones (${beyond.join(", ")})`);
        // The recovered document is valid, and an in-flight edit that landed landed whole.
        validateDocument(parseDocument(recovered.document));
        for (const id of beyond) assert.deepEqual([nodes[id].type, nodes[id].props.name, nodes[id].parentId], ["frame", `B${id.slice(1)}`, null], `the in-flight edit ${id} is complete`);
        assert.equal(recovered.revision - confirmed, beyond.length, "each revision beyond the confirmed ones is that in-flight edit");
        assert.ok(!recovered.files[PROJECT_FILES.journal].includes('"torn'), "nothing half-written is left in the journal");
        // Recovery is deterministic: a clean restart reads the very same state.
        await ok(host.call("POST", "/api/projects/close"), "close");
        await host.stop();
        host = await startChild(projects, children);
        await ok(host.call("POST", "/api/projects/open", { name: "crashy" }), "reopen after recovery");
        assert.deepEqual(await exactState(host.call, projects, "crashy"), recovered, "recovery is deterministic");
        // And the project keeps working.
        await ok(host.call("POST", "/api/edit", { baseRevision: recovered.revision, intent: "After the crash", operations: [{ type: "insert-node", node: { id: "after", type: "frame", props: { name: "After" } }, parentId: null }] }), "edit after recovery");
      } finally {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.all(children.map((child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("close", resolve)))));
        rmSync(projects, { recursive: true, force: true });
      }
    });
  }
});
