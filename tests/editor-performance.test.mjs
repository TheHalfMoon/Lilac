import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { browserTestOptions } from "./support/browser.mjs";
import { openEditor, waitRevision } from "./support/editor.mjs";

// PC8 (#168): large-document canvas and render performance through the editor, in headless
// Chromium against a real studio host, on a 10,000-node project. Budgets (MASTER_PLAN PC
// gate 13): first render at most 2 s; applying a single-node change at most 100 ms at p95,
// from receipt of the change-stream event; the end-to-end edit (request, persisted commit,
// event, patch) at most 750 ms at p95. Measured with the editor's own User Timing marks.
// Closes PC gate 13.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();
const NODES = 10_000;
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test("a 10,000-node project renders, applies changes and edits within the gate-13 budgets", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-perf-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const call = (path, body) => fetch(`${host.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
  // A page of 9,999 absolutely positioned cards: 10,000 nodes in one transaction.
  await call("/api/projects/create", { name: "large" });
  const page = { id: "page", type: "frame", parentId: null, children: [], props: { tag: "div", name: "Large page", style: { position: "relative", width: "4000px", height: "6000px" } }, metadata: {} };
  const nodes = [page];
  for (let index = 1; index < NODES; index += 1) {
    const id = `n${index}`;
    page.children.push(id);
    nodes.push({ id, type: "element", parentId: "page", children: [], props: { tag: "div", text: `Card ${index}`, style: { position: "absolute", left: `${(index % 100) * 40}px`, top: `${Math.floor(index / 100) * 60}px`, width: "36px", height: "50px", background: "#eef" } }, metadata: {} });
  }
  // Requests are limited to 1 MiB, so the page is added in batches: the frame, then cards.
  let created = await call("/api/edit", { baseRevision: 0, intent: "Large page", operations: [{ type: "insert-node", node: { ...page, children: [] }, parentId: null, index: 0 }] });
  for (let start = 1; start < NODES; start += 2500) {
    const batch = nodes.slice(start, start + 2500).map((node, offset) => ({ type: "insert-node", node: { ...node, parentId: undefined, children: [] }, parentId: "page", index: start - 1 + offset }));
    created = await call("/api/edit", { baseRevision: created.revision, intent: "Cards", operations: batch });
    assert.ok(Number.isInteger(created.revision), JSON.stringify(created).slice(0, 200));
  }
  assert.equal(Object.keys(host.session.document.nodes).length, NODES);
  await call("/api/projects/close", {});
  const editor = await openEditor(host);
  try {
    const { page: tab } = editor;
    // First render: opening the project, from the request to the drawn canvas.
    await tab.locator("#dialog[open] [data-project=large]").click();
    await waitRevision(tab, created.revision);
    const rendered = await tab.evaluate(() => document.querySelector("iframe").contentDocument.querySelectorAll("[data-lilac-id]").length);
    assert.equal(rendered, NODES);
    const firstRender = await tab.evaluate(() => performance.getEntriesByName("lilac:render-project", "measure").at(-1).duration);
    assert.ok(firstRender <= 2000, `first render of ${NODES} nodes took ${firstRender.toFixed(0)} ms (budget 2000)`);

    // Changes from elsewhere (another client): applying each, from the event's arrival.
    let revision = created.revision;
    for (let index = 0; index < 40; index += 1) {
      const id = `n${1 + index * 37}`;
      const event = await call("/api/edit", { baseRevision: revision, intent: "Recolour", operations: [{ type: "set-props", nodeId: id, set: { style: { position: "absolute", left: "0px", top: `${index * 60}px`, width: "36px", height: "50px", background: index % 2 ? "#fde" : "#dfe" } } }] });
      revision = event.revision;
      await waitRevision(tab, revision);
    }
    const applied = await tab.evaluate(() => performance.getEntriesByName("lilac:apply-change", "measure").map((entry) => entry.duration));
    // A change that lands while a refresh is in flight is replayed, not timed from arrival.
    assert.ok(applied.length >= 35, `${applied.length} changes measured`);
    const applyP95 = p95(applied);
    assert.ok(applyP95 <= 100, `applying a change: p95 ${applyP95.toFixed(1)} ms (budget 100)`);

    // Edits made in the editor: Shift+Arrow on the canvas moves the selected card 10 px.
    await tab.evaluate(() => window.scrollTo(0, 0));
    await tab.locator("#layers [role=treeitem][data-node-id=page] > .row").click();
    await tab.keyboard.press("ArrowRight");
    await tab.locator("#layers [role=treeitem][data-node-id=n1] > .row").click();
    await tab.locator("[role=application]").focus();
    for (let index = 0; index < 30; index += 1) {
      await tab.keyboard.press("Shift+ArrowRight");
      revision += 1;
      await waitRevision(tab, revision);
    }
    const edits = await tab.evaluate(() => performance.getEntriesByName("lilac:edit", "measure").map((entry) => entry.duration));
    assert.equal(edits.length, 30);
    const editP95 = p95(edits);
    assert.ok(editP95 <= 750, `end-to-end edit: p95 ${editP95.toFixed(0)} ms (budget 750)`);
    assert.equal(host.session.document.nodes.n1.props.style.left, "300px", "the first recolour set left to 0px; 30 nudges of 10 px");
    // The measurements, for the record.
    process.stdout.write(`# PC8 gate 13: first render ${firstRender.toFixed(0)} ms; apply p95 ${applyP95.toFixed(1)} ms over ${applied.length}; edit p95 ${editP95.toFixed(0)} ms over ${edits.length}\n`);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
