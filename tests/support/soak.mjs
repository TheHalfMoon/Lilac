// P08-G5 (#230, founder section P08.5): a long session through the studio host, to find what
// only time shows: drift in latency, memory or handles that leak, temporary files left behind,
// growth on disk, and runs of the same seed that end differently. The session stays the same
// size while it runs (layers are added and removed in balance), so a change in latency is the
// host's, not a larger document's (#252). It is driven as the editor and an agent use it: the
// person's edits, undo and redo, an agent's edits through MCP, reading and exporting, an HTML
// import and its removal, a write-back to a connected codebase, checkpoints, and closing and
// reopening the project in a new host.
//
//   node tests/support/soak.mjs [rounds, default 20000] [seed] [--json <file>]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { hostPool, mcpClient, ok } from "./host-api.mjs";
import { createPrng } from "./prng.mjs";

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc");

const COMPONENT = `export function Notice() {
  return (
    <section className="notice">
      <h2>Notice</h2>
      <p title="Body">Original text</p>
    </section>
  );
}
`;
const PAGE = (index) => `<!doctype html><html><body><main><h1>Imported ${index}</h1><ul>${Array.from({ length: 20 }, (_, item) => `<li>Item ${item}</li>`).join("")}</ul></main></body></html>`;

/** Everything under `dir`, as paths relative to it, with their sizes. */
function files(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...files(path, `${prefix}${entry.name}/`));
    else found.push({ path: `${prefix}${entry.name}`, bytes: statSync(path).size });
  }
  return found;
}

/** The kinds of resources keeping the process alive (sockets, servers, child processes, timers), counted. */
export function resources() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/** A document with its ids replaced by their place in the tree, so runs that draw random ids compare. */
export function canonical(document) {
  const names = new Map();
  const visit = (id, path) => {
    names.set(id, path);
    document.nodes[id].children.forEach((child, index) => visit(child, `${path}.${index}`));
  };
  document.rootIds.forEach((id, index) => visit(id, `${index}`));
  const rename = (value) => (typeof value === "string" && names.has(value) ? names.get(value) : value);
  const props = (value) => JSON.parse(JSON.stringify(value, (key, item) => rename(item)));
  return document.rootIds.map(function tree(id) {
    const node = document.nodes[id];
    return { type: node.type, props: props(node.props), children: node.children.map(tree) };
  });
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * A soak of `rounds` actions from `seed`. Every `window` rounds it records the person's edit
 * latency, the heap after a full collection, the store's size on disk and the process's
 * active resources. Returns those windows, a tally of the actions, the final document in
 * canonical form, and what was left on disk and running once the hosts closed.
 */
export async function soak({ rounds, seed, window = 100 }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-soak-")));
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  writeFileSync(join(code, "Notice.jsx"), COMPONENT);
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();
  const before = resources();
  const prng = createPrng(seed);
  const pool = hostPool(now);
  const tally = {};
  const count = (what) => {
    tally[what] = (tally[what] ?? 0) + 1;
  };
  const windows = [];
  try {
    let running = await pool.open(projects);
    await ok(running.call("POST", "/api/projects/create", { name: "soak" }), "create");
    const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Soak agent" }), "connect an agent");
    const connectAgent = async () => {
      const agent = mcpClient(running.host.mcpUrl, token);
      await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "soak", version: "1" } });
      return agent;
    };
    let agent = await connectAgent();
    await ok(running.call("POST", "/api/codebase/connect", { folder: code }), "connect the codebase");
    await ok(running.call("POST", "/api/codebase/import", { file: "Notice.jsx", component: "Notice" }), "bring in");
    const document = async () => ok(running.call("GET", "/api/document"), "document");
    // The person's own layers in the document, in the order they were added, so picks follow
    // this run and not the host's order (undo and redo add and remove them too).
    const mine = (current) => Object.keys(current.nodes).filter((id) => id.startsWith("soak-")).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    let next = 0;
    let edits = [];
    for (let round = 1; round <= rounds; round += 1) {
      const roll = prng.next();
      if (roll < 0.45) {
        // The person edits: adds a layer while there are few, removes one while there are many,
        // otherwise changes one.
        const { document: current, revision } = await document();
        const layers = mine(current);
        let operations;
        if (layers.length < 40 || (layers.length < 80 && prng.next() < 0.5)) {
          const id = `soak-${next++}`;
          operations = [{ type: "insert-node", node: { id, type: "text", props: { name: `Layer ${id}`, tag: "p", text: "New" } }, parentId: null }];
          count("insert");
        } else if (prng.next() < 0.3) {
          operations = [{ type: "remove-node", nodeId: prng.pick(layers) }];
          count("remove");
        } else {
          operations = [{ type: "set-props", nodeId: prng.pick(layers), set: { text: `Text ${prng.int(0, 9999)}`, style: { color: prng.pick(["#112233", "red"]), padding: `${prng.int(0, 32)}px` } } }];
          count("change");
        }
        const started = performance.now();
        await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Soak edit", operations }), "edit");
        edits.push(performance.now() - started);
      } else if (roll < 0.55) {
        const layers = mine((await document()).document);
        const result = await agent.tool("set_text", { nodeId: prng.pick(layers.length > 0 ? layers : ["missing"]), text: `Agent ${prng.int(0, 9999)}` });
        count(result.isError ? "agent refused" : "agent edit");
      } else if (roll < 0.63) {
        const undone = await running.call("POST", "/api/undo");
        count(undone.status === 200 ? "undo" : "nothing to undo");
      } else if (roll < 0.69) {
        const redone = await running.call("POST", "/api/redo");
        count(redone.status === 200 ? "redo" : "nothing to redo");
      } else if (roll < 0.79) {
        await document();
        count("read");
      } else if (roll < 0.84) {
        const { document: current } = await document();
        await ok(running.call("POST", "/api/code/export", { nodeId: current.rootIds[0] }), "export");
        count("export");
      } else if (roll < 0.88) {
        // An HTML import, committed, then removed with every other imported page (undoing an
        // earlier removal brings one back), so imports do not pile up.
        const review = await ok(running.call("POST", "/api/import", { html: PAGE(round), name: `Page ${round}` }), "import review");
        const { revision } = await ok(running.call("POST", "/api/import/commit", { proposalId: review.proposalId }), "import commit");
        const { document: current } = await document();
        const pages = current.rootIds.filter((id) => id.startsWith("page-import-"));
        await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Remove the imports", operations: pages.map((nodeId) => ({ type: "remove-node", nodeId })) }), "remove the imports");
        count("import");
      } else if (roll < 0.93) {
        // A write-back: change the component's paragraph, preview, write. The person's undo can
        // take back bringing it in; then it is brought in again first.
        let { document: current, revision } = await document();
        if (!Object.values(current.nodes).some((node) => node.props.codeSource?.file === "Notice.jsx")) {
          await ok(running.call("POST", "/api/codebase/import", { file: "Notice.jsx", component: "Notice" }), "bring in again");
          ({ document: current, revision } = await document());
          count("bring in again");
        }
        const paragraph = Object.values(current.nodes).find((node) => node.props.codeSource?.file === "Notice.jsx" && node.props.tag === "p");
        const section = Object.values(current.nodes).find((node) => node.props.codeSource?.file === "Notice.jsx" && node.props.tag === "section");
        await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: "Retext", operations: [{ type: "set-props", nodeId: paragraph.id, set: { text: `Written ${round}` } }] }), "retext");
        const preview = await ok(running.call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview");
        await ok(running.call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "write");
        count("write-back");
      } else if (roll < 0.99) {
        await ok(running.call("POST", "/api/checkpoint"), "checkpoint");
        count("checkpoint");
      } else {
        // Close, and reopen in a new host: the document comes back exactly.
        const { document: closing, revision } = await document();
        await ok(running.call("POST", "/api/projects/close"), "close");
        await pool.close(running.host);
        running = await pool.open(projects);
        await ok(running.call("POST", "/api/projects/open", { name: "soak" }), "reopen");
        const reopened = await document();
        assert.equal(reopened.revision, revision, `round ${round}: the revision after a reopen`);
        assert.deepStrictEqual(reopened.document, closing, `round ${round}: the document after a reopen`);
        agent = await connectAgent();
        count("reopen");
      }
      if (round % window === 0) {
        collect();
        const store = files(projects);
        const { document: sized } = await document();
        windows.push({
          round,
          layers: Object.keys(sized.nodes).length,
          editMs: Math.round(median(edits) * 10) / 10,
          heapMiB: Math.round((process.memoryUsage().heapUsed / 2 ** 20) * 10) / 10,
          rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
          journalKiB: Math.round(store.filter((file) => file.path.endsWith("journal.log")).reduce((sum, file) => sum + file.bytes, 0) / 1024),
          objectsKiB: Math.round(store.filter((file) => file.path.includes("objects/")).reduce((sum, file) => sum + file.bytes, 0) / 1024),
          resources: Object.values(resources()).reduce((sum, value) => sum + value, 0),
        });
        edits = [];
      }
    }
    const { document: last } = await document();
    await pool.closeAll();
    // Give closed sockets a turn of the event loop to go.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      windows,
      tally,
      document: canonical(last),
      left: { resourcesBefore: before, resourcesAfter: resources(), projectFiles: files(projects).map((file) => file.path), codeFiles: files(code).map((file) => file.path) },
    };
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The platform the numbers were taken on. */
export const platform = () => `${process.platform} ${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"} × ${cpus().length}, Node ${process.versions.node}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rounds = Number(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : 20_000);
  const seed = Number(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : 230_005);
  const started = performance.now();
  const report = { platform: platform(), rounds, seed, ...(await soak({ rounds, seed, window: Math.max(100, Math.round(rounds / 40)) })), seconds: Math.round((performance.now() - started) / 1000) };
  delete report.document;
  console.log(JSON.stringify(report, null, 1));
  const at = process.argv.indexOf("--json");
  if (at > 0) writeFileSync(process.argv[at + 1], JSON.stringify(report, null, 2));
}
