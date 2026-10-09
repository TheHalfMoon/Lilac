import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeDocument } from "../packages/document-model/src/index.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";
import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { createPrng, propertySeeds } from "./support/prng.mjs";

// P08-G1 (#230): the five end-to-end journeys of the founder's P08.1, each run several times
// with generated content, through the studio host's own API, as the editor and an MCP agent
// use it. "Exact state" is the canonical serialization of the document together with the
// project's journal file: after a close and a reopen in a new host, both must be
// byte-identical. (The history panel lists only the changes since the project was opened, by
// design, so it is not part of the persisted state.)
// A failure names its seed; replay it with NINERR_PROPERTY_SEED=<seed>. NINERR_JOURNEY_RUNS
// sets how many seeds each journey runs (default 3).

const RUNS = Number(process.env.NINERR_JOURNEY_RUNS ?? 3);
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

/** A running in-process host and its API client. */
async function open(root) {
  const host = await startStudioHost({ projectsRoot: root, now });
  return { host, call: client(host.url, host.token) };
}

async function ok(promise, what) {
  const result = await promise;
  assert.equal(result.status, 200, `${what}: ${JSON.stringify(result.json)}`);
  return result.json;
}

const journalOf = (root, project) => join(root, project, PROJECT_FILES.directory, "journal.log");

/** The exact state: the canonical document and the bytes of the project's journal. */
async function exactState(call, root, project) {
  const { revision, document } = await ok(call("GET", "/api/document"), "document");
  return { revision, document: serializeDocument(document), journal: readFileSync(journalOf(root, project), "utf8") };
}

/** Close the project and the host, start a new host on the same folder, and reopen it. */
async function reopen(running, root, project) {
  await ok(running.call("POST", "/api/projects/close"), "close");
  await running.host.close();
  const next = await open(root);
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

/** Apply generated edits, undos and redos; an edit history refuses (a cycle) is skipped. */
async function generatedSession(call, prng, steps) {
  const counter = { next: 0 };
  let accepted = 0;
  for (let step = 0; step < steps; step += 1) {
    const roll = prng.next();
    if (roll < 0.15) {
      await call("POST", "/api/undo");
      continue;
    }
    if (roll < 0.25) {
      await call("POST", "/api/redo");
      continue;
    }
    const { revision, document } = await ok(call("GET", "/api/document"), "document");
    const edit = generatedEdit(prng, document, counter);
    const result = await call("POST", "/api/edit", { baseRevision: revision, ...edit });
    if (result.status === 200) accepted += 1;
    else assert.equal(result.status, 400, `only an invalid edit may be refused: ${JSON.stringify(result.json)}`);
  }
  return accepted;
}

test("Journey A: create, edit, save, close and reopen; the exact state survives, run after run", async () => {
  for (const seed of propertySeeds(RUNS)) {
    const root = scratch();
    let running = await open(root);
    try {
      const prng = createPrng(seed);
      await ok(running.call("POST", "/api/projects/create", { name: "work", title: `Work ${seed}` }), "create");
      const accepted = await generatedSession(running.call, prng, 40);
      assert.ok(accepted > 10, `seed ${seed}: the session made real changes`);
      const before = await exactState(running.call, root, "work");
      running = await reopen(running, root, "work");
      assert.deepEqual(await exactState(running.call, root, "work"), before, `seed ${seed}: the reopened state is exact`);
      // And again, with no edit in between: reopening is idempotent.
      running = await reopen(running, root, "work");
      assert.deepEqual(await exactState(running.call, root, "work"), before, `seed ${seed}: a second reopen changes nothing`);
      // The reopened project keeps working.
      const { revision } = await ok(running.call("GET", "/api/document"), "document");
      await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "After reopen", operations: [{ type: "insert-node", node: { id: "after", type: "frame", props: { name: "After" } }, parentId: null }] }), "edit after reopen");
    } finally {
      await running.host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const PAGE = (title, line) => `<!doctype html><html><head><title>${title}</title><style>.lead { color: #334455 }</style></head>
<body><main><h1>${title}</h1><p class="lead" style="margin: 4px">${line}</p><ul><li>One</li><li>Two</li></ul></main></body></html>`;

test("Journey B: import a page, inspect, edit, save, reopen, export; the export carries the edit, deterministically", async () => {
  for (const seed of propertySeeds(RUNS)) {
    const root = scratch();
    let running = await open(root);
    try {
      const prng = createPrng(seed);
      const title = prng.pick(["Pricing", "Über uns", "Contact"]);
      await ok(running.call("POST", "/api/projects/create", { name: "site" }), "create");
      const review = await ok(running.call("POST", "/api/import", { html: PAGE(title, "First line"), name: `${title} page` }), "import review");
      await ok(running.call("POST", "/api/import/commit", { proposalId: review.proposalId }), "import commit");
      // Inspect: the heading and the paragraph came in as layers.
      let { revision, document } = await ok(running.call("GET", "/api/document"), "document");
      const nodes = Object.values(document.nodes);
      const heading = nodes.find((node) => node.props.tag === "h1");
      const paragraph = nodes.find((node) => node.props.tag === "p");
      assert.ok(heading && paragraph, `seed ${seed}: the page's heading and paragraph are layers`);
      const edited = `Edited ${prng.int(100, 999)}`;
      await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Edit the paragraph", operations: [{ type: "set-props", nodeId: paragraph.children[0], set: { text: edited } }] }), "edit");
      const before = await exactState(running.call, root, "site");
      running = await reopen(running, root, "site");
      assert.deepEqual(await exactState(running.call, root, "site"), before, `seed ${seed}: the imported, edited page reopens exactly`);
      ({ document } = await ok(running.call("GET", "/api/document"), "document"));
      // The imported page's frame: the root layer the paragraph sits under.
      const contains = (nodeId) => nodeId === paragraph.id || (document.nodes[nodeId].children ?? []).some(contains);
      const rootId = document.rootIds.find(contains);
      const exported = await ok(running.call("POST", "/api/code/export", { nodeId: rootId }), "export");
      const again = await ok(running.call("POST", "/api/code/export", { nodeId: rootId }), "export again");
      assert.deepEqual(again, exported, `seed ${seed}: export is deterministic`);
      const code = JSON.stringify(exported);
      assert.ok(code.includes(edited), `seed ${seed}: the export carries the edit`);
      assert.ok(!code.includes("First line"), `seed ${seed}: and not the replaced text`);
    } finally {
      await running.host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
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

test("Journey C: connect a codebase, bring a component in, edit, review the diff, write back, edit outside, reconcile", async () => {
  for (const seed of propertySeeds(RUNS)) {
    const root = scratch();
    const projects = join(root, "projects");
    const code = join(root, "code");
    mkdirSync(projects);
    mkdirSync(code);
    const card = join(code, "Card.jsx");
    writeFileSync(card, CARD("Pro"));
    let running = await open(projects);
    try {
      const prng = createPrng(seed);
      await ok(running.call("POST", "/api/projects/create", { name: "app" }), "create");
      await ok(running.call("POST", "/api/codebase/connect", { folder: code }), "connect");
      await ok(running.call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" }), "bring in");
      let { revision, document } = await ok(running.call("GET", "/api/document"), "document");
      const section = Object.values(document.nodes).find((node) => node.props.tag === "section");
      const h2 = Object.values(document.nodes).find((node) => node.props.tag === "h2");
      const heading = prng.pick(["Team", "Business", "Équipe"]);
      await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Retitle", operations: [{ type: "set-props", nodeId: h2.id, set: { text: heading } }] }), "edit");
      // Review: the diff shows exactly the edit, and a preview writes nothing.
      let preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview");
      assert.deepEqual(preview.changes.map((change) => change.field), ["text"]);
      assert.deepEqual(preview.conflicts, []);
      assert.match(preview.diff, new RegExp(`\\n\\+      <h2>${heading}</h2>\\n`, "u"));
      assert.equal(readFileSync(card, "utf8"), CARD("Pro"));
      await ok(running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "write back");
      assert.equal(readFileSync(card, "utf8"), CARD(heading), `seed ${seed}: the file has exactly the reviewed change`);
      // An edit made outside Ninerr, while it is closed.
      await ok(running.call("POST", "/api/projects/close"), "close");
      await running.host.close();
      writeFileSync(card, readFileSync(card, "utf8").replace("Everything in Free, and more.", "All of Free, plus more."));
      running = await open(projects);
      await ok(running.call("POST", "/api/projects/open", { name: "app" }), "reopen");
      // Reconcile: the outside edit is the file's own change, so there is nothing to write and no conflict.
      preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview after the outside edit");
      assert.deepEqual(preview.changes, [], `seed ${seed}: nothing of Ninerr's is pending`);
      assert.deepEqual(preview.conflicts, []);
      // A further edit writes back only itself and keeps the outside change.
      ({ revision } = await ok(running.call("GET", "/api/document"), "document"));
      await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Retitle again", operations: [{ type: "set-props", nodeId: h2.id, set: { text: `${heading} Plus` } }] }), "second edit");
      preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "second preview");
      await ok(running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "second write");
      const final = readFileSync(card, "utf8");
      assert.match(final, new RegExp(`<h2>${heading} Plus</h2>`, "u"));
      assert.match(final, /All of Free, plus more\./u, `seed ${seed}: the outside change is kept`);
      // Exact state survives one more reopen.
      const before = await exactState(running.call, projects, "app");
      running = await reopen(running, projects, "app");
      assert.deepEqual(await exactState(running.call, projects, "app"), before);
    } finally {
      await running.host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Journey D: an agent over MCP inspects and edits; the person reviews, accepts, undoes and redoes; it all persists", async () => {
  for (const seed of propertySeeds(RUNS)) {
    const root = scratch();
    let running = await open(root);
    try {
      const prng = createPrng(seed);
      await ok(running.call("POST", "/api/projects/create", { name: "agentic" }), "create");
      const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Journey agent" }), "connect an agent");
      let agent = mcpClient(running.host.mcpUrl, token);
      await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } });
      // Inspect, then mutate.
      assert.equal((await agent.tool("project_info", {})).isError, undefined);
      const frame = (await agent.tool("create_frame", { name: `Board ${seed}`, width: prng.int(200, 800), height: 400 })).structuredContent.nodeId;
      let { revision } = await ok(running.call("GET", "/api/document"), "document");
      await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Add title", operations: [{ type: "insert-node", node: { id: "title", type: "text", props: { tag: "h1", text: "Hello" } }, parentId: frame, index: 0 }] }), "person's edit");
      const retitled = await agent.tool("set_text", { nodeId: "title", text: prng.pick(["Welcome", "Bienvenue", "ようこそ"]) });
      assert.equal(retitled.isError, undefined, JSON.stringify(retitled));
      // Review: the agent's change is attributed to it in the history.
      const { entries } = await ok(running.call("GET", "/api/history"), "history");
      const agentChange = entries.at(-1);
      assert.equal(agentChange.actorKind, "agent");
      // A consequential call waits for the person; the person accepts it.
      await ok(running.call("POST", "/api/edit", { baseRevision: (await ok(running.call("GET", "/api/document"), "document")).revision, intent: "Scratch", operations: [{ type: "insert-node", node: { id: "scratch", type: "frame", props: { name: "Scratch" } }, parentId: null }] }), "scratch");
      const deleting = agent.tool("delete_layers", { nodeIds: ["scratch"] });
      let pending = [];
      for (let tries = 0; tries < 200 && pending.length === 0; tries += 1) {
        ({ pending } = await ok(running.call("GET", "/api/confirmations"), "confirmations"));
        if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(pending.length, 1, "the deletion asks the person");
      await ok(running.call("POST", "/api/confirmations/decide", { id: pending[0].id, approve: true }), "accept");
      assert.equal((await deleting).isError, undefined);
      assert.equal((await ok(running.call("GET", "/api/document"), "document")).document.nodes.scratch, undefined);
      // Undo the agent's latest change, the accepted deletion (a revert by the person), then undo
      // and redo that revert.
      const deletion = (await ok(running.call("GET", "/api/history"), "history")).entries.at(-1);
      assert.equal(deletion.tool, "delete_layers");
      const scratchExists = async () => (await ok(running.call("GET", "/api/document"), "document")).document.nodes.scratch !== undefined;
      await ok(running.call("POST", "/api/revert", { transactionId: deletion.transactionId }), "revert the agent's deletion");
      assert.equal(await scratchExists(), true, "the reverted deletion brings the layer back");
      await ok(running.call("POST", "/api/undo"), "undo the revert");
      assert.equal(await scratchExists(), false);
      await ok(running.call("POST", "/api/redo"), "redo the revert");
      assert.equal(await scratchExists(), true);
      // Persist and reopen: exact, and the agent's credential still works.
      const before = await exactState(running.call, root, "agentic");
      running = await reopen(running, root, "agentic");
      assert.deepEqual(await exactState(running.call, root, "agentic"), before, `seed ${seed}: the agent session reopens exactly`);
      agent = mcpClient(running.host.mcpUrl, token);
      const agentText = (await ok(running.call("GET", "/api/document"), "document")).document.nodes.title.props.text;
      assert.equal((await agent.tool("layer_details", { nodeId: "title" })).structuredContent.props.text, agentText);
      assert.equal(agentChange.intent.length > 0, true);
    } finally {
      await running.host.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** A host in a child process, so it can be killed outright. */
async function startChild(projects) {
  const child = spawn(process.execPath, ["tests/support/host-child.mjs", projects], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve(signal ?? code)));
  for (let tries = 0; tries < 500 && !out.includes("\n"); tries += 1) {
    if (child.exitCode !== null) throw new Error(`the host exited: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const info = JSON.parse(out.split("\n")[0]);
  return { child, exited, call: client(info.url, info.token), kill: async () => { child.kill("SIGKILL"); return exited; }, stop: async () => { child.kill("SIGTERM"); return exited; } };
}

test("Journey E: a crash during a burst of edits recovers every confirmed change, and nothing partial", async () => {
  for (const seed of propertySeeds(RUNS)) {
    const projects = scratch();
    let host = await startChild(projects);
    try {
      const prng = createPrng(seed);
      await ok(host.call("POST", "/api/projects/create", { name: "crashy" }), "create");
      await generatedSession(host.call, prng, 15);
      let confirmed = (await ok(host.call("GET", "/api/document"), "document")).revision;
      // A burst of edits, killed once part of it is confirmed.
      let stopped = false;
      const burst = (async () => {
        for (let index = 0; index < 500 && !stopped; index += 1) {
          const result = await host.call("POST", "/api/edit", { baseRevision: confirmed, intent: `Burst ${index}`, operations: [{ type: "insert-node", node: { id: `b${index}`, type: "frame", props: { name: `B${index}` } }, parentId: null }] }).catch(() => null);
          if (result === null || result.status !== 200) return;
          confirmed = result.json.revision;
        }
      })();
      const start = confirmed;
      const deadline = Date.now() + 10_000;
      while (confirmed < start + prng.int(1, 5) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      await host.kill();
      stopped = true;
      await burst;
      assert.ok(confirmed > start, `seed ${seed}: part of the burst was confirmed before the crash`);
      // The interrupted write left torn at the end of the journal.
      const journal = join(projects, "crashy", PROJECT_FILES.directory, "journal.log");
      const complete = readFileSync(journal, "utf8").trim().split("\n").length;
      appendFileSync(journal, '{"seq":999999,"entry":{"transaction":{"id":"torn');
      // Restart: the dead session's lock is taken over with a reason; the torn tail is discarded.
      host = await startChild(projects);
      const refused = await host.call("POST", "/api/projects/open", { name: "crashy" });
      assert.notEqual(refused.status, 200, "a stale lock is not taken over silently");
      await ok(host.call("POST", "/api/projects/open", { name: "crashy", breakStaleLock: { reason: "Journey E crash" } }), "recover");
      const recovered = await exactState(host.call, projects, "crashy");
      assert.ok(recovered.revision >= confirmed, `seed ${seed}: every confirmed change survived (confirmed ${confirmed}, recovered ${recovered.revision})`);
      assert.equal(recovered.revision, complete, `seed ${seed}: the recovered revision is every complete journal entry`);
      assert.ok(!recovered.journal.includes('"torn'), "nothing half-written is left in the journal");
      // Recovery is deterministic: a clean restart reads the very same state.
      await ok(host.call("POST", "/api/projects/close"), "close");
      await host.stop();
      host = await startChild(projects);
      await ok(host.call("POST", "/api/projects/open", { name: "crashy" }), "reopen after recovery");
      assert.deepEqual(await exactState(host.call, projects, "crashy"), recovered, `seed ${seed}: recovery is deterministic`);
      // And the project keeps working.
      await ok(host.call("POST", "/api/edit", { baseRevision: recovered.revision, intent: "After the crash", operations: [{ type: "insert-node", node: { id: "after", type: "frame", props: { name: "After" } }, parentId: null }] }), "edit after recovery");
    } finally {
      await host.stop();
      rmSync(projects, { recursive: true, force: true });
    }
  }
});
