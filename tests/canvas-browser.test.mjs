import test from "node:test";
import assert from "node:assert/strict";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { applyTransaction } from "../packages/history/src/index.mjs";
import { TEST_ORIGIN, browserTestOptions, launchPage } from "./support/browser.mjs";

// PC3 (#146): the canvas in Chromium, driven by real pointer, wheel and keyboard input.
// Selection, hit testing under pan and zoom, and drag/resize/nudge/delete that end in
// history operations, applied and re-rendered incrementally. Closes PC gate 2.

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#c{position:absolute;left:40px;top:30px;width:800px;height:600px}</style></head><body><div id="c"></div>
<script type="module">
  import * as canvasModule from "/packages/canvas/src/index.mjs";
  window.commits = [];
  window.selections = [];
  window.canvas = await canvasModule.mountCanvas(document.getElementById("c"), {
    onCommit: (operations, intent, meta) => window.commits.push({ operations, intent, meta }),
    onSelect: (ids) => window.selections.push(ids),
  });
  window.worldToScreen = canvasModule.worldToScreen;
  // The page coordinates of a rendered node's centre, through the frame and the viewport.
  window.screenOf = (id) => {
    const rect = window.canvas.renderer.elementFor(id).getBoundingClientRect();
    const stage = window.canvas.stage.getBoundingClientRect();
    const p = canvasModule.worldToScreen(window.canvas.viewport, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    return { x: stage.left + p.x, y: stage.top + p.y };
  };
  window.ready = true;
</script></body></html>`;

const baseDocument = () => createDocument({
  id: "doc",
  nodes: [
    { id: "page", type: "frame", children: ["card", "badge"], props: { tag: "main", style: { position: "relative", width: "600px", height: "400px" } } },
    { id: "card", type: "element", parentId: "page", children: ["title"], props: { tag: "section", style: { position: "absolute", left: "40px", top: "40px", width: "200px", height: "120px", background: "#eef" } } },
    { id: "title", type: "text", parentId: "card", props: { tag: "h2", text: "Pricing", style: { margin: "8px" } } },
    { id: "badge", type: "element", parentId: "page", props: { tag: "span", text: "New", style: { position: "absolute", left: "320px", top: "60px", width: "60px", height: "24px", background: "#fde" } } },
  ],
});

async function harness(initial = baseDocument()) {
  const session = await launchPage({ extraRoutes: { "/harness.html": { status: 200, contentType: "text/html", body: HARNESS } } });
  await session.page.setViewportSize({ width: 900, height: 700 });
  await session.page.goto(`${TEST_ORIGIN}/harness.html`);
  await session.page.waitForFunction(() => window.ready === true);
  let doc = initial;
  await session.page.evaluate((d) => window.canvas.setDocument(d), doc);
  // Apply the canvas's latest commit through history, as the editor will through the host.
  const commit = async () => {
    const pending = await session.page.evaluate(() => window.commits.shift());
    assert.ok(pending, "the interaction produced a commit");
    assert.equal(pending.meta.revision, doc.revision, "the commit names the revision it was computed from");
    const result = applyTransaction(doc, { id: `t${Math.random()}`, actor: "local-user", operations: pending.operations, intent: pending.intent });
    doc = result.document;
    const stats = await session.page.evaluate(({ d, affected }) => {
      const before = { ...window.canvas.renderer.stats };
      window.canvas.update(d, affected);
      return { created: window.canvas.renderer.stats.created - before.created };
    }, { d: doc, affected: result.affectedNodeIds });
    return { ...pending, doc, stats };
  };
  return { ...session, commit, get doc() { return doc; } };
}

test("clicking selects through hit testing, with shift-extend and click-away clear", browserTestOptions(), async () => {
  const h = await harness();
  try {
    const { page } = h;
    let point = await page.evaluate(() => window.screenOf("title"));
    await page.mouse.click(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), ["title"], "the innermost rendered node is hit");
    assert.equal(await page.evaluate(() => document.querySelectorAll("[data-lilac-selection]").length), 1, "the selection is drawn");
    point = await page.evaluate(() => window.screenOf("badge"));
    await page.keyboard.down("Shift");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("Shift");
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), ["title", "badge"]);
    await page.mouse.click(820, 600); // empty canvas, outside the page
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), []);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("hit testing stays correct after zooming about the cursor and panning", browserTestOptions(), async () => {
  const h = await harness();
  try {
    const { page } = h;
    const start = await page.evaluate(() => window.screenOf("badge"));
    // Ctrl+wheel zooms about the cursor: the badge stays under the pointer.
    await page.mouse.move(start.x, start.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    const zoomed = await page.evaluate(() => ({ zoom: window.canvas.viewport.zoom, at: window.screenOf("badge") }));
    assert.ok(zoomed.zoom > 2.5, `zoomed to ${zoomed.zoom}`);
    assert.ok(Math.abs(zoomed.at.x - start.x) < 2 && Math.abs(zoomed.at.y - start.y) < 2, "the point under the cursor stays fixed");
    // A plain wheel pans; pan the zoomed-in card back into view.
    const beforePan = await page.evaluate(() => window.canvas.viewport);
    await page.mouse.wheel(-500, -40);
    const afterPan = await page.evaluate(() => window.canvas.viewport);
    assert.deepEqual([afterPan.x - beforePan.x, afterPan.y - beforePan.y, afterPan.zoom], [500, 40, beforePan.zoom], "the wheel pans by its deltas");
    const panned = await page.evaluate(() => window.screenOf("title"));
    assert.ok(panned.x > 40 && panned.x < 840 && panned.y > 30 && panned.y < 630, `the title is on the stage at ${JSON.stringify(panned)}`);
    await page.mouse.click(panned.x, panned.y);
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), ["title"], "hit testing follows the transformed canvas");
  } finally {
    await h.close();
  }
});

test("drag-move, resize, nudge and delete commit operations that re-render incrementally", browserTestOptions(), async () => {
  const h = await harness();
  try {
    const { page } = h;
    // Drag the card by (60, 30) screen pixels at zoom 1.
    const card = await page.evaluate(() => window.screenOf("card"));
    await page.mouse.move(card.x, card.y + 30);
    await page.mouse.down();
    await page.mouse.move(card.x + 30, card.y + 45, { steps: 3 });
    await page.mouse.move(card.x + 60, card.y + 60, { steps: 3 });
    assert.equal(await page.evaluate(() => window.commits.length), 0, "dragging previews without committing");
    await page.mouse.up();
    let result = await h.commit();
    assert.equal(result.intent, "Move layer");
    assert.equal(result.doc.nodes.card.props.style.left, "100px");
    assert.equal(result.doc.nodes.card.props.style.top, "70px");
    assert.equal(result.stats.created, 0, "the move is a patch, not a rebuild");
    assert.equal(await page.evaluate(() => window.canvas.renderer.elementFor("card").style.translate), "", "the preview is cleared");

    // Resize from the handle by (40, 20).
    const handle = await page.evaluate(() => {
      const rect = document.querySelector("[data-lilac-handle]").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 40, handle.y + 20, { steps: 4 });
    await page.mouse.up();
    result = await h.commit();
    assert.equal(result.intent, "Resize layer");
    assert.equal(result.doc.nodes.card.props.style.width, "240px");
    assert.equal(result.doc.nodes.card.props.style.height, "140px");

    // Keyboard: arrows nudge (shift for ten), Delete removes, Escape clears.
    await page.keyboard.press("ArrowRight");
    result = await h.commit();
    assert.equal(result.doc.nodes.card.props.style.left, "101px");
    await page.keyboard.press("Shift+ArrowDown");
    result = await h.commit();
    assert.equal(result.doc.nodes.card.props.style.top, "80px");
    await page.keyboard.press("Delete");
    result = await h.commit();
    assert.equal(result.intent, "Delete layer");
    assert.equal(result.doc.nodes.card, undefined);
    assert.equal(result.doc.nodes.title, undefined);
    assert.equal(await page.evaluate(() => window.canvas.renderer.elementFor("card")), null, "the deleted subtree is gone from the canvas");
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), [], "the selection drops deleted nodes");
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

const geometryDocument = () => createDocument({
  id: "doc",
  nodes: [
    // The page's padding keeps the heading's margin from collapsing through it: taking a node
    // out of flow reflows what is around it, which no placement can compensate for.
    { id: "page", type: "frame", children: ["heading", "padded", "plain"], props: { tag: "main", style: { position: "relative", width: "600px", height: "400px", padding: "16px" } } },
    { id: "heading", type: "text", parentId: "page", props: { tag: "h2", text: "Flow heading", style: { margin: "8px", width: "184px" } } },
    { id: "padded", type: "element", parentId: "page", props: { tag: "section", style: { position: "absolute", left: "300px", top: "100px", width: "100px", height: "50px", padding: "10px", border: "2px solid #000" } } },
    // A heading whose top margin collapses through a plain parent, and an inline span.
    { id: "plain", type: "element", parentId: "page", children: ["collapsing", "inline"], props: { tag: "div", style: { position: "relative", width: "300px" } } },
    { id: "collapsing", type: "text", parentId: "plain", props: { tag: "h3", text: "Collapsing", style: { margin: "20px 0px" } } },
    { id: "inline", type: "text", parentId: "plain", props: { tag: "span", text: "Inline words", style: { padding: "3px" } } },
  ],
});
const rectOf = (page, id) => page.evaluate((nodeId) => {
  const rect = window.canvas.renderer.elementFor(nodeId).getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}, id);

test("moves and resizes commit the geometry the user saw, for margins, padding and borders", browserTestOptions(), async () => {
  const h = await harness(geometryDocument());
  try {
    const { page } = h;
    // A flow heading with a margin, dragged by (10, 0): it moves by exactly that, keeping its size.
    const before = await rectOf(page, "heading");
    const start = await page.evaluate(() => window.screenOf("heading"));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 5, start.y, { steps: 2 });
    await page.mouse.move(start.x + 10, start.y, { steps: 2 });
    await page.mouse.up();
    let result = await h.commit();
    assert.equal(result.intent, "Move layer");
    const after = await rectOf(page, "heading");
    assert.deepEqual([after.x - before.x, after.y - before.y, after.width, after.height], [10, 0, before.width, before.height], "the margined flow node lands where it was dragged, at its size");
    // A padded, bordered box resized by (20, 10) from the handle grows by exactly that.
    await page.evaluate(() => window.canvas.select(["padded"]));
    const padded = await rectOf(page, "padded");
    const handle = await page.evaluate(() => {
      const rect = document.querySelector("[data-lilac-handle]").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 20, handle.y + 10, { steps: 4 });
    await page.mouse.up();
    result = await h.commit();
    assert.equal(result.doc.nodes.padded.props.style.width, "120px");
    assert.equal(result.doc.nodes.padded.props.style.height, "60px");
    const grown = await rectOf(page, "padded");
    assert.deepEqual([grown.width - padded.width, grown.height - padded.height], [20, 10]);

    // A heading whose margin collapsed through its parent also lands exactly where dragged.
    await page.keyboard.press("Escape");
    const collapsing = await rectOf(page, "collapsing");
    const grip = await page.evaluate(() => window.screenOf("collapsing"));
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 10, grip.y, { steps: 3 });
    await page.mouse.up();
    // The preview holds the node in place until the host's update arrives: no snap-back.
    const held = await rectOf(page, "collapsing");
    assert.deepEqual([held.x - collapsing.x, held.y - collapsing.y], [10, 0], "the preview is held until the update");
    result = await h.commit();
    const placed = await rectOf(page, "collapsing");
    assert.deepEqual([placed.x - collapsing.x, placed.y - collapsing.y], [10, 0], "the collapsed-margin heading lands where it was dragged");
    assert.equal(await page.evaluate(() => window.canvas.renderer.elementFor("collapsing").style.translate), "", "the update replaced the held preview");

    // An inline span resized from the handle gets real lengths, never NaN.
    await page.evaluate(() => window.canvas.select(["inline"]));
    const inline = await rectOf(page, "inline");
    const inlineHandle = await page.evaluate(() => {
      const rect = document.querySelector("[data-lilac-handle]").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(inlineHandle.x, inlineHandle.y);
    await page.mouse.down();
    await page.mouse.move(inlineHandle.x + 30, inlineHandle.y + 12, { steps: 3 });
    await page.mouse.up();
    result = await h.commit();
    const { width, height } = result.doc.nodes.inline.props.style;
    assert.match(width, /^\d+(\.\d+)?px$/u);
    assert.match(height, /^\d+(\.\d+)?px$/u);
    assert.equal(Number.parseFloat(width), Math.round((inline.width - 6 + 30) * 100) / 100, "content width plus the drag");
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("cancelled, abandoned and tiny drags never commit or leave a preview behind", browserTestOptions(), async () => {
  const h = await harness();
  try {
    const { page } = h;
    const card = await page.evaluate(() => window.screenOf("card"));
    // A click with a 1px jitter selects and commits nothing.
    await page.mouse.move(card.x, card.y + 30);
    await page.mouse.down();
    await page.mouse.move(card.x + 1, card.y + 30);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), ["card"]);
    assert.equal(await page.evaluate(() => window.commits.length), 0, "a jittered click is not a move");
    // A cancelled pointer abandons the drag: the preview is cleared and a later hover does nothing.
    await page.mouse.down();
    await page.mouse.move(card.x + 60, card.y + 60, { steps: 3 });
    await page.evaluate(() => window.canvas.stage.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
    await page.mouse.up();
    await page.mouse.move(card.x + 120, card.y + 90, { steps: 3 });
    assert.equal(await page.evaluate(() => window.canvas.renderer.elementFor("card").style.translate), "", "no preview after a cancel");
    assert.equal(await page.evaluate(() => window.commits.length), 0, "a cancelled drag commits nothing");
    // A resize released outside the stage still ends, and commits, because the stage holds capture.
    const handle = await page.evaluate(() => {
      const rect = document.querySelector("[data-lilac-handle]").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(870, 680, { steps: 5 }); // past the stage's right and bottom edges
    await page.mouse.up();
    const result = await h.commit();
    assert.equal(result.intent, "Resize layer");
    assert.equal(await page.evaluate(() => window.commits.length), 0);
    const width = await page.evaluate(() => window.canvas.renderer.elementFor("card").style.width);
    assert.equal(width, result.doc.nodes.card.props.style.width, "the element shows the committed size, not a stale preview");
    // A right-click neither selects nor arms a drag.
    await page.keyboard.press("Escape");
    const badge = await page.evaluate(() => window.screenOf("badge"));
    await page.mouse.click(badge.x, badge.y, { button: "right" });
    assert.deepEqual(await page.evaluate(() => window.canvas.selection), []);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
