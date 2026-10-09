// P08-G4 (#230, founder section P08.4): what large projects cost, measured through the studio
// host as the editor and an agent use it. Measurements only: the budgets are proposed from
// them in docs/evidence, for the founder to accept at the P08 exit gate.
//   node tests/support/scale.mjs [sizes, default 1000,10000,25000,50000] [--json <file>]
// The full run also measures a crash after 2,000 edits on 1,000 layers and after 300 edits on
// 10,000. "p95" is the nearest-rank 95th percentile: with 10 or 15 samples it is the largest,
// with 30 the second largest.
// prints a Markdown report; tests/scale-report.test.mjs runs the same workloads at CI size.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PROJECT_FILES } from "../../packages/persistence/src/index.ts";
import { MAX_IMPORT_NODES } from "../../packages/studio-host/src/imports.ts";
import { client, hostPool, mcpClient } from "./host-api.mjs";

const HOST_CHILD = fileURLToPath(new URL("./host-child.mjs", import.meta.url));
const OPERATIONS_PER_EDIT = 5_000;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
/** The nearest-rank quantile: the smallest sample with at least `q` of them at or below it. */
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
};
const timed = async (task) => {
  const start = process.hrtime.bigint();
  const value = await task();
  return { value, ms: ms(start) };
};
async function expect(promise, what) {
  const result = await promise;
  if (result.status !== 200) throw new Error(`${what}: ${result.status} ${JSON.stringify(result.json)?.slice(0, 300)}`);
  return result.json;
}
/** The bytes of every file under `directory`. */
function bytesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).reduce((total, entry) => total + statSync(join(entry.parentPath ?? entry.path, entry.name)).size, 0);
}
const megabytes = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Pages of 50 frames, each frame with one text layer: `nodes` layers in all, inserted as the editor would. */
function flatOperations(nodes) {
  const operations = [];
  let made = 0;
  for (let page = 0; made < nodes; page += 1) {
    const pageId = `page-${page}`;
    operations.push({ type: "insert-node", node: { id: pageId, type: "frame", props: { name: `Page ${page}`, tag: "main", style: { width: "1200px" } } }, parentId: null });
    made += 1;
    for (let frame = 0; frame < 50 && made < nodes; frame += 1) {
      const frameId = `${pageId}-f${frame}`;
      operations.push({ type: "insert-node", node: { id: frameId, type: "frame", props: { name: `Card ${frame}`, tag: "section", style: { padding: "16px", background: "#f4f0ff" } } }, parentId: pageId });
      made += 1;
      if (made < nodes) {
        operations.push({ type: "insert-node", node: { id: `${frameId}-t`, type: "text", props: { tag: "p", text: `Text ${frame} on page ${page}` } }, parentId: frameId });
        made += 1;
      }
    }
  }
  return operations;
}

/** Commit `operations` in edits of at most OPERATIONS_PER_EDIT; returns each edit's time. */
async function commitAll(call, operations) {
  const times = [];
  for (let index = 0; index < operations.length; index += OPERATIONS_PER_EDIT) {
    const { revision } = await expect(call("GET", "/api/session"), "session");
    const { ms: took } = await timed(() => expect(call("POST", "/api/edit", { baseRevision: revision, intent: "Build", operations: operations.slice(index, index + OPERATIONS_PER_EDIT) }), "build"));
    times.push(took);
  }
  return times;
}

/** `count` one-operation edits of a layer's text; their latencies. */
async function editLatencies(call, nodeId, count) {
  const times = [];
  for (let index = 0; index < count; index += 1) {
    const { revision } = await expect(call("GET", "/api/session"), "session");
    times.push((await timed(() => expect(call("POST", "/api/edit", { baseRevision: revision, intent: "Retext", operations: [{ type: "set-props", nodeId, set: { text: `Edit ${index}` } }] }), "edit"))).ms);
  }
  return times;
}

const summary = (times) => ({ p50: Math.round(quantile(times, 0.5)), p95: Math.round(quantile(times, 0.95)), n: times.length });

/** A flat project of `nodes` layers: build, edit, undo, redo, read, agent, checkpoint, close, reopen. */
export async function measureFlat(nodes, { edits = 30 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-scale-")));
  const pool = hostPool(now);
  try {
    let { host, call } = await pool.open(root);
    await expect(call("POST", "/api/projects/create", { name: "scale" }), "create");
    const rssBefore = process.memoryUsage().rss;
    const build = await commitAll(call, flatOperations(nodes));
    const target = "page-0-f0-t";
    const edit = await editLatencies(call, target, edits);
    const undo = [];
    const redo = [];
    for (let index = 0; index < 10; index += 1) undo.push((await timed(() => expect(call("POST", "/api/undo"), "undo"))).ms);
    for (let index = 0; index < 10; index += 1) redo.push((await timed(() => expect(call("POST", "/api/redo"), "redo"))).ms);
    const read = await timed(() => expect(call("GET", "/api/document"), "document"));
    const documentBytes = Buffer.byteLength(JSON.stringify(read.value.document));
    const exported = await timed(() => expect(call("POST", "/api/code/export", { nodeId: "page-0" }), "export"));
    // An agent: its token, a read of one layer, and text edits through MCP.
    const { token } = await expect(call("POST", "/api/agents/create", { name: "Scale agent" }), "agent");
    const agent = mcpClient(host.mcpUrl, token);
    await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scale", version: "1" } });
    const details = await timed(() => agent.tool("layer_details", { nodeId: target }));
    const agentEdits = [];
    for (let index = 0; index < 10; index += 1) agentEdits.push((await timed(() => agent.tool("set_text", { nodeId: target, text: `Agent ${index}` }))).ms);
    const checkpoint = await timed(() => expect(call("POST", "/api/checkpoint"), "checkpoint"));
    const rssOpen = process.memoryUsage().rss;
    await expect(call("POST", "/api/edit", { baseRevision: (await expect(call("GET", "/api/session"), "session")).revision, intent: "Last", operations: [{ type: "set-props", nodeId: target, set: { text: "Last" } }] }), "last edit");
    const close = await timed(() => expect(call("POST", "/api/projects/close"), "close"));
    await host.close();
    const store = join(root, "scale", PROJECT_FILES.directory);
    const disk = { journalMiB: megabytes(statSync(join(store, PROJECT_FILES.journal)).size), objectsMiB: megabytes(bytesUnder(join(store, PROJECT_FILES.objects))) };
    ({ host, call } = await pool.open(root));
    const reopen = await timed(() => expect(call("POST", "/api/projects/open", { name: "scale" }), "reopen"));
    await expect(call("POST", "/api/projects/close"), "close again");
    return {
      workload: `flat, ${nodes.toLocaleString("en")} layers`,
      nodes,
      buildMs: Math.round(build.reduce((a, b) => a + b, 0)),
      buildEdits: build.length,
      editMs: summary(edit),
      undoMs: summary(undo),
      redoMs: summary(redo),
      readMs: Math.round(read.ms),
      documentMiB: megabytes(documentBytes),
      exportPageMs: Math.round(exported.ms),
      agentReadMs: Math.round(details.ms),
      agentEditMs: summary(agentEdits),
      checkpointMs: Math.round(checkpoint.ms),
      closeMs: Math.round(close.ms),
      reopenMs: Math.round(reopen.ms),
      rssGrowthMiB: megabytes(rssOpen - rssBefore),
      ...disk,
    };
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A chain of `depth` nested frames: build, an edit at the bottom, close and reopen. */
export async function measureDeep(depth) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-scale-deep-")));
  const pool = hostPool(now);
  try {
    let { host, call } = await pool.open(root);
    await expect(call("POST", "/api/projects/create", { name: "deep" }), "create");
    const operations = Array.from({ length: depth }, (_, index) => ({ type: "insert-node", node: { id: `d${index}`, type: "frame", props: { name: `Level ${index}` } }, parentId: index === 0 ? null : `d${index - 1}` }));
    const build = await commitAll(call, operations);
    const edit = await editLatencies(call, `d${depth - 1}`, 10);
    const close = await timed(() => expect(call("POST", "/api/projects/close"), "close"));
    await host.close();
    ({ host, call } = await pool.open(root));
    const reopen = await timed(() => expect(call("POST", "/api/projects/open", { name: "deep" }), "reopen"));
    return { workload: `deep, ${depth.toLocaleString("en")} levels`, buildMs: Math.round(build.reduce((a, b) => a + b, 0)), editMs: summary(edit), closeMs: Math.round(close.ms), reopenMs: Math.round(reopen.ms) };
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A host in a child process, so it can be killed outright. */
async function startChild(projects) {
  // Its errors go to this process's stderr: a pipe nobody reads could fill and stall it.
  const child = spawn(process.execPath, [HOST_CHILD, projects], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("close", resolve));
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
  try {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    for (let tries = 0; tries < 500 && !out.includes("\n") && child.exitCode === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const info = JSON.parse(out.split("\n")[0]);
    return { child, call: client(info.url, info.token), kill };
  } catch (error) {
    await kill();
    throw new Error(`the host did not start: ${error.message}`);
  }
}

/** A long history: `edits` one-operation edits on a `nodes`-layer project, then a crash and a reopen that replays them. */
export async function measureHistory(nodes, edits) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-scale-history-")));
  let host = null;
  try {
    host = await startChild(root);
    await expect(host.call("POST", "/api/projects/create", { name: "history" }), "create");
    await commitAll(host.call, flatOperations(nodes));
    const run = await timed(() => editLatencies(host.call, "page-0-f0-t", edits));
    // A crash: nothing at close, so the reopen replays every edit since the snapshot.
    await host.kill();
    host = await startChild(root);
    const reopen = await timed(() => expect(host.call("POST", "/api/projects/open", { name: "history", breakStaleLock: { reason: "scale crash" } }), "recover"));
    const journal = statSync(join(root, "history", PROJECT_FILES.directory, PROJECT_FILES.journal)).size;
    await expect(host.call("POST", "/api/projects/close"), "close");
    return { workload: `history, ${edits.toLocaleString("en")} edits on ${nodes.toLocaleString("en")} layers`, editMs: summary(run.value), replayedEntries: reopen.value.recovery.replayedEntries, crashReopenMs: Math.round(reopen.ms), journalMiB: megabytes(journal) };
  } finally {
    if (host) await host.kill().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/** An HTML page of about `nodes` DOM nodes (elements and texts; at most 80% of the import limit): review and commit. */
export async function measureImport(nodes) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-scale-import-")));
  const pool = hostPool(now);
  try {
    const { call } = await pool.open(root);
    await expect(call("POST", "/api/projects/create", { name: "import" }), "create");
    // Each card is five DOM nodes: a section, a heading, a paragraph and their two texts.
    const cards = Math.floor(Math.min(nodes, MAX_IMPORT_NODES * 0.8) / 5);
    const html = `<!doctype html><html><body><main>${Array.from({ length: cards }, (_, index) => `<section class="card"><h2>Plan ${index}</h2><p>Text ${index}</p></section>`).join("")}</main></body></html>`;
    const review = await timed(() => expect(call("POST", "/api/import", { html, name: "Big page" }), "review"));
    const commit = await timed(() => expect(call("POST", "/api/import/commit", { proposalId: review.value.proposalId }), "commit"));
    return { workload: `HTML import, ${review.value.counts.nodes.toLocaleString("en")} layers (${megabytes(Buffer.byteLength(html))} MiB)`, reviewMs: Math.round(review.ms), commitMs: Math.round(commit.ms) };
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A source file of `elements` paragraphs, within what code import accepts (#250): connect, scan, bring in, preview and write back. */
export async function measureWriteBack(elements) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-scale-code-")));
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const pool = hostPool(now);
  try {
    const items = Array.from({ length: elements }, (_, index) => `      <p title="Item ${index}">Item ${index}</p>`).join("\n");
    const source = `export function Big() {\n  return (\n    <section className="list">\n${items}\n    </section>\n  );\n}\n`;
    writeFileSync(join(code, "Big.jsx"), source);
    const { call } = await pool.open(projects);
    await expect(call("POST", "/api/projects/create", { name: "linked" }), "create");
    await expect(call("POST", "/api/codebase/connect", { folder: code }), "connect");
    const scan = await timed(() => expect(call("GET", "/api/codebase"), "scan"));
    const bring = await timed(() => expect(call("POST", "/api/codebase/import", { file: "Big.jsx", component: "Big" }), "bring in"));
    const { document, revision } = await expect(call("GET", "/api/document"), "document");
    const section = Object.values(document.nodes).find((node) => node.props?.tag === "section");
    const last = Object.values(document.nodes).filter((node) => node.props?.tag === "p").at(-1);
    await expect(call("POST", "/api/edit", { baseRevision: revision, intent: "Retext", operations: [{ type: "set-props", nodeId: last.id, set: { text: "Changed" } }] }), "edit");
    const preview = await timed(() => expect(call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview"));
    const write = await timed(() => expect(call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.value.token }), "write"));
    return { workload: `write-back, ${elements.toLocaleString("en")} elements (${Math.round(Buffer.byteLength(source) / 1024)} KiB source)`, scanMs: Math.round(scan.ms), bringInMs: Math.round(bring.ms), previewMs: Math.round(preview.ms), writeMs: Math.round(write.ms) };
  } finally {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The platform the numbers were taken on. */
export const platform = () => `${process.platform} ${process.arch}, ${cpus()[0]?.model ?? "unknown CPU"} × ${cpus().length}, Node ${process.versions.node}`;

/** Every workload at the given flat sizes. */
export async function measureAll(sizes) {
  const results = [];
  for (const nodes of sizes) results.push(await measureFlat(nodes));
  results.push(await measureDeep(1_000));
  results.push(await measureHistory(1_000, sizes.length > 2 ? 2_000 : 300));
  if (sizes.length > 2) results.push(await measureHistory(10_000, 300));
  results.push(await measureImport(Math.min(20_000, sizes.at(-1))));
  results.push(await measureWriteBack(1_000), await measureWriteBack(4_000));
  return { platform: platform(), results };
}

/** The report as Markdown. */
export function markdown({ platform, results }) {
  const lines = [`Platform: ${platform}`, ""];
  for (const result of results) {
    lines.push(`- **${result.workload}**: ${Object.entries(result).filter(([key]) => key !== "workload" && key !== "nodes").map(([key, value]) => `${key} ${typeof value === "object" ? `p50 ${value.p50} / p95 ${value.p95} (n ${value.n})` : value}`).join(", ")}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sizes = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "1000,10000,25000,50000").split(",").map(Number);
  const report = await measureAll(sizes);
  process.stdout.write(`${markdown(report)}\n`);
  const at = process.argv.indexOf("--json");
  if (at > 0) writeFileSync(process.argv[at + 1], JSON.stringify(report, null, 2));
}
