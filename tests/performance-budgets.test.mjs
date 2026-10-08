import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOCUMENT_LIMITS,
  DocumentInvariantError,
  createDocument,
  parseDocument,
  serializeDocument,
  validateDocument,
} from "../packages/document-model/src/index.mjs";
import { commitTransaction, createHistoryState, redo, undo } from "../packages/history/src/index.mjs";
import { createProject, openProject } from "../packages/persistence/src/index.ts";

// Budgets for the model, history and persistence paths on large documents.
// Absolute budgets carry about 3x headroom over the times recorded in
// docs/evidence/P06_G3_PERFORMANCE_BUDGETS_2026-10-07.md, so slower CI runners
// pass; the scaling guard compares 50k with 10k on the same machine, which
// catches quadratic regressions whatever the machine speed.

const AT = "2026-10-07T09:00:00.000Z";

// Pages of 100 frames, each frame with the props a layout node typically has.
function largeDocument(nodeCount) {
  const nodes = [];
  for (let page = 0; nodes.length < nodeCount; page += 1) {
    const children = [];
    for (let index = 0; index < 100 && nodes.length + children.length + 1 < nodeCount; index += 1) children.push(`f${page}-${index}`);
    nodes.push({ id: `p${page}`, type: "page", children });
    for (const id of children) {
      nodes.push({ id, type: "frame", parentId: `p${page}`, props: { x: 1, y: 2, width: 100, height: 50, fill: "#ffffff", text: "label" } });
    }
  }
  return createDocument({ id: "doc-large", nodes });
}

function best(runs, fn) {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    fn();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

const setProps = (id, revision, value) => ({ id, actor: "user-1", baseRevision: revision, operations: [{ type: "set-props", nodeId: "f0-0", set: { x: value } }] });

function measureModel(nodeCount) {
  const document = largeDocument(nodeCount);
  const text = serializeDocument(document);
  const history = createHistoryState(document);
  const committed = commitTransaction(history, setProps("t1", document.revision, 9));
  const undone = undo(committed);
  return {
    validate: best(3, () => validateDocument(document)),
    serialize: best(3, () => serializeDocument(document)),
    parse: best(3, () => parseDocument(text)),
    commit: best(3, () => commitTransaction(history, setProps("t1", document.revision, 9))),
    undo: best(3, () => undo(committed)),
    redo: best(3, () => redo(undone)),
  };
}

const MODEL_BUDGETS_50K = { validate: 500, serialize: 1500, parse: 3000, commit: 2000, undo: 2000, redo: 2000 };

test("model and history operations on 50k nodes stay within budget and scale linearly", () => {
  const small = measureModel(10_000);
  const large = measureModel(50_000);
  for (const [name, budget] of Object.entries(MODEL_BUDGETS_50K)) {
    assert.ok(large[name] <= budget, `${name} on 50k nodes took ${large[name].toFixed(0)} ms; budget ${budget} ms`);
  }
  for (const name of ["validate", "serialize", "commit"]) {
    // 5x the nodes; linear work stays near 5x, quadratic work would be near 25x.
    // The 20 ms floor keeps a GC pause in a very fast 10k run from tripping the guard.
    const ratio = large[name] / Math.max(small[name], 20);
    assert.ok(ratio <= 10, `${name} grew ${ratio.toFixed(1)}x from 10k to 50k nodes`);
  }
});

test("persisted commits and reopen with replay on 10k nodes stay within budget", () => {
  const root = mkdtempSync(join(tmpdir(), "ninerr-budget-"));
  try {
    const document = largeDocument(10_000);
    createProject(root, { projectId: "budget", document, createdAt: AT });
    const store = openProject(root, { owner: "writer-1", at: AT });
    let revision = document.revision;
    const commitMs = best(3, () => { store.commit(setProps(`c${revision}`, revision, revision)); revision += 1; });
    store.close();
    const reopenMs = best(2, () => openProject(root, { owner: "writer-1", at: AT }).close());
    assert.ok(commitMs <= 1500, `persisted commit on 10k nodes took ${commitMs.toFixed(0)} ms; budget 1500 ms`);
    assert.ok(reopenMs <= 3000, `reopen with ${revision - document.revision} replayed entries took ${reopenMs.toFixed(0)} ms; budget 3000 ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("documents beyond the node limit are refused", () => {
  const document = largeDocument(1_000);
  const missing = DOCUMENT_LIMITS.maxNodes + 1 - Object.keys(document.nodes).length;
  for (let index = 0; index < missing; index += 1) {
    const id = `extra-${index}`;
    document.nodes[id] = { id, type: "frame", parentId: null, children: [], props: {}, metadata: {} };
    document.rootIds.push(id);
  }
  assert.throws(() => validateDocument(document), /nodes; the limit is 100000/u);
});

test("parseDocument refuses text over the byte limit before parsing", () => {
  const text = `{"pad":"${"x".repeat(DOCUMENT_LIMITS.maxDocumentBytes)}"}`;
  const started = performance.now();
  assert.throws(() => parseDocument(text), (error) => error instanceof DocumentInvariantError && /exceeds/u.test(error.message));
  assert.ok(performance.now() - started < 100, "the size check runs before JSON.parse");
  // Text under the limit in UTF-16 units but over it in UTF-8 bytes: 2-byte,
  // 3-byte and 4-byte (surrogate pair) characters.
  const limit = DOCUMENT_LIMITS.maxDocumentBytes;
  for (const [character, bytes] of [["\u00e9", 2], ["\u20ac", 3], ["\u{1f600}", 4]]) {
    const over = `"${character.repeat(Math.floor(limit / bytes) + 1)}"`;
    assert.throws(() => parseDocument(over), /exceeds/u, `${bytes}-byte text over the limit`);
  }
});

test("parseDocument refuses deep bracket nesting before JSON.parse", () => {
  const text = `{"a":${"[".repeat(10_000_000)}${"]".repeat(10_000_000)}}`;
  const started = performance.now();
  assert.throws(() => parseDocument(text), /nests deeper than 257 levels/u);
  assert.ok(performance.now() - started < 1000, "rejected by the pre-scan, not after a full parse");
  // Brackets and escaped quotes inside strings do not count.
  const quoted = serializeDocument(createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame", props: { s: `\\"${"[".repeat(1000)}` } }] }));
  assert.equal(parseDocument(quoted).nodes.n.props.s.length, 1002);
});

test("serializeDocument refuses output over the byte limit", () => {
  const document = createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] });
  document.nodes.n.props.big = "a".repeat(DOCUMENT_LIMITS.maxDocumentBytes);
  assert.throws(() => serializeDocument(document), /serialized document exceeds/u);
});

// A chain at the depth limit, and a deep wide tree (a 64-level spine with 150
// leaves per level), both validate within budget.
test("deep trees validate within budget", () => {
  const depth = DOCUMENT_LIMITS.maxTreeDepth;
  const deep = createDocument({ id: "doc-deep", nodes: Array.from({ length: depth }, (_, index) => ({
    id: `c${index}`, type: "frame", parentId: index === 0 ? null : `c${index - 1}`, children: index === depth - 1 ? [] : [`c${index + 1}`],
  })) });
  const chainMs = best(3, () => validateDocument(deep));
  assert.ok(chainMs <= 200, `validating a ${depth}-deep chain took ${chainMs.toFixed(0)} ms; budget 200 ms`);

  const nodes = [];
  for (let level = 0; level < 64; level += 1) {
    const leaves = Array.from({ length: 150 }, (_, leaf) => `l${level}-${leaf}`);
    const children = level < 63 ? [`s${level + 1}`, ...leaves] : leaves;
    nodes.push({ id: `s${level}`, type: "group", parentId: level === 0 ? null : `s${level - 1}`, children });
    for (const id of leaves) nodes.push({ id, type: "frame", parentId: `s${level}`, props: { x: 1 } });
  }
  const wideDeep = createDocument({ id: "doc-wide-deep", nodes });
  const wideMs = best(3, () => validateDocument(wideDeep));
  assert.ok(wideMs <= 300, `validating a 64-deep tree of ${nodes.length} nodes took ${wideMs.toFixed(0)} ms; budget 300 ms`);
});

test("the nesting pre-scan never refuses the serializer's own deepest output", () => {
  const nested = (levels) => {
    let value = [];
    for (let level = 1; level < levels; level += 1) value = [value];
    return value;
  };
  const document = createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame", props: { p: nested(253) } }] });
  const text = serializeDocument(document);
  assert.equal(serializeDocument(parseDocument(text)), text, "the deepest serializable document round-trips");
  document.nodes.n.props.p = nested(254);
  assert.throws(() => serializeDocument(document), /nested deeper than 256/u, "one level deeper is refused by serialize");
});
