import test from "node:test";
import assert from "node:assert/strict";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { applyTransaction } from "../packages/history/src/index.mjs";
import {
  MAX_ZOOM, MIN_ZOOM, createViewport, fitBounds, insertNode, moveBy, normalizeSelection, panBy, removeNodes,
  reorder, resizeTo, screenToWorld, selectNode, setStyle, setText, worldToScreen, zoomAt,
} from "../packages/canvas/src/index.mjs";

// PC3 (#146): the canvas's pure parts. Viewport math, selection rules, and commands that turn
// interactions into history operations (the canvas itself never mutates the document).

const doc = () => createDocument({
  id: "d",
  nodes: [
    { id: "page", type: "frame", children: ["card", "free"], props: { tag: "main" } },
    { id: "card", type: "element", parentId: "page", children: ["title"], props: { tag: "section", style: { padding: "8px" } } },
    { id: "title", type: "text", parentId: "card", props: { tag: "h2", text: "Hi" } },
    { id: "free", type: "element", parentId: "page", props: { style: { position: "absolute", left: "10px", top: "20px" } } },
  ],
});
const apply = (document, operations) => applyTransaction(document, { id: "t", actor: "u", operations }).document;

test("the viewport round-trips points and zooms about a fixed screen point", () => {
  const viewport = createViewport({ x: 30, y: -10, zoom: 2 });
  for (const point of [{ x: 0, y: 0 }, { x: 12.5, y: -7 }, { x: 1000, y: 400 }]) {
    const back = screenToWorld(viewport, worldToScreen(viewport, point));
    assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9);
  }
  const anchor = { x: 200, y: 150 };
  const before = screenToWorld(viewport, anchor);
  const zoomed = zoomAt(viewport, anchor, 1.7);
  const after = screenToWorld(zoomed, anchor);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9, "the point under the cursor stays put");
  assert.equal(zoomAt(viewport, anchor, 1e9).zoom, MAX_ZOOM);
  assert.equal(zoomAt(viewport, anchor, 1e-9).zoom, MIN_ZOOM);
  assert.deepEqual(panBy(viewport, 5, -5), { x: 35, y: -15, zoom: 2 });
  const fitted = fitBounds({ x: 0, y: 0, width: 800, height: 400 }, 448, 248, 24);
  assert.equal(fitted.zoom, 0.5);
  assert.deepEqual(worldToScreen(fitted, { x: 400, y: 200 }), { x: 224, y: 124 }, "the content is centred");
});

test("selection: replace, extend, clear, and normalize away missing and nested ids", () => {
  assert.deepEqual(selectNode([], "a"), ["a"]);
  assert.deepEqual(selectNode(["a"], "b"), ["b"]);
  assert.deepEqual(selectNode(["a"], "b", { extend: true }), ["a", "b"]);
  assert.deepEqual(selectNode(["a", "b"], "a", { extend: true }), ["b"]);
  assert.deepEqual(selectNode(["a"], null), []);
  assert.deepEqual(selectNode(["a"], null, { extend: true }), ["a"]);
  assert.deepEqual(normalizeSelection(doc(), ["title", "card", "gone", "free"]), ["card", "free"]);
});

test("commands produce history operations that apply cleanly", () => {
  let d = doc();
  d = apply(d, moveBy(d, ["free"], 5, -3));
  assert.deepEqual(d.nodes.free.props.style, { position: "absolute", left: "15px", top: "17px" }, "a positioned node moves by its offsets");
  d = apply(d, moveBy(d, ["card", "title"], 4, 6, { card: { left: 100, top: 50 } }));
  assert.deepEqual(d.nodes.card.props.style, { padding: "8px", position: "absolute", left: "104px", top: "56px" }, "a flow node is positioned at its measured offset plus the delta; the nested title is not moved separately");
  assert.equal(d.nodes.title.props.style, undefined);
  d = apply(d, resizeTo(d, "card", 240.256, 0));
  assert.equal(d.nodes.card.props.style.width, "240.26px");
  assert.equal(d.nodes.card.props.style.height, "1px", "sizes stay positive");
  d = apply(d, setStyle(d, "card", { padding: null, color: "red" }));
  assert.deepEqual(Object.keys(d.nodes.card.props.style).sort(), ["color", "height", "left", "position", "top", "width"]);
  d = apply(d, setText("title", "Plans"));
  assert.equal(d.nodes.title.props.text, "Plans");
  d = apply(d, reorder(d, "card", 1));
  assert.deepEqual(d.nodes.page.children, ["free", "card"]);
  assert.deepEqual(reorder(d, "card", 5), [], "already last");
  d = apply(d, insertNode("page", 0, { id: "new", tag: "p", text: "New" }));
  assert.deepEqual(d.nodes.page.children, ["new", "free", "card"]);
  d = apply(d, removeNodes(d, ["card", "title", "missing"]));
  assert.equal(d.nodes.card, undefined);
  assert.equal(d.nodes.title, undefined);
});
