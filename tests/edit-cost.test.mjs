import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DocumentInvariantError, cloneDocument, cloneValidated, createDocument } from "../packages/document-model/src/index.mjs";
import { applyTransaction } from "../packages/history/src/index.mjs";
import { createProject, openProject } from "../packages/persistence/src/index.ts";
import { createPrng } from "./support/prng.mjs";

// #252: an edit copied the whole document with structuredClone and validated it four times.
// Validated documents are now copied directly, and a store skips validating its own
// document. These tests hold both to doing exactly what they replaced.

const AT = "2026-10-10T12:00:00.000Z";

/**
 * A transaction that passes every check made while its operation is applied, and leaves a
 * document only the final validation refuses: a restored subtree carrying a node that no
 * parent lists as a child.
 */
const ghost = (id, baseRevision) => ({
  id,
  actor: "u",
  baseRevision,
  operations: [{ type: "restore-subtree", rootId: "sub", parentId: "frame", nodes: [{ id: "sub", type: "frame", children: [], props: {} }, { id: "ghost", type: "element", parentId: "frame", props: {} }] }],
});
const ORPHAN = /must reference child ghost exactly once/u;

/** structuredClone's copy and cloneValidated's must be the same, in values and key order. */
function assertSameCopy(value) {
  const ours = cloneValidated(value);
  const theirs = structuredClone(value);
  assert.deepStrictEqual(ours, theirs);
  assert.equal(JSON.stringify(ours), JSON.stringify(theirs), "the same keys, in the same order");
  return ours;
}

test("for tree-shaped validated data, the copy equals structuredClone's, including the cases a plain copy gets wrong (#252)", () => {
  // "__proto__" as an own key must stay an own key, not become the copy's prototype.
  const tricky = JSON.parse('{"__proto__":{"polluted":true},"constructor":"c","b":1,"a":[1,{"x":-0}],"n":null,"z":"z"}');
  const copy = assertSameCopy(tricky);
  assert.ok(Object.hasOwn(copy, "__proto__"));
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal({}.polluted, undefined, "nothing was polluted");
  assert.ok(Object.is(copy.a[1].x, -0), "-0 stays -0");
  // An object without a prototype is copied as a plain one, as structuredClone does.
  const bare = Object.assign(Object.create(null), { k: [1, 2] });
  assert.equal(Object.getPrototypeOf(assertSameCopy(bare)), Object.prototype);
  // The copy shares nothing with what it copied.
  const nested = { a: { b: [{ c: 1 }] } };
  const deep = cloneValidated(nested);
  deep.a.b[0].c = 2;
  assert.equal(nested.a.b[0].c, 1);
});

test("random tree-shaped documents copy as structuredClone copies them (#252)", () => {
  const random = createPrng(252);
  const value = (depth) => {
    const pick = random.int(depth > 3 ? 4 : 6);
    if (pick === 0) return null;
    if (pick === 1) return random.int(2) === 0;
    if (pick === 2) return random.int(1000) - 500 + (random.int(2) === 0 ? 0.5 : 0);
    if (pick === 3) return `s${random.int(100)}`;
    if (pick === 4) return Array.from({ length: random.int(4) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: random.int(4) }, () => [random.pick(["a", "b", "__proto__", "toString", "z", "1", "0"]), value(depth + 1)]));
  };
  for (let round = 0; round < 200; round += 1) {
    const nodes = [{ id: "root", type: "frame", children: [], props: { data: value(0) } }];
    for (let index = 0; index < 1 + random.int(5); index += 1) {
      nodes[0].children.push(`n${index}`);
      nodes.push({ id: `n${index}`, type: "element", parentId: "root", props: { data: value(0) }, metadata: { m: value(0) } });
    }
    const document = createDocument({ id: `doc-${round}`, nodes });
    assertSameCopy(document);
    assert.deepStrictEqual(cloneDocument(document), structuredClone(document));
  }
});

test("skipping a store's own input check still validates what a transaction produces (#252)", () => {
  const document = createDocument({ id: "doc", nodes: [{ id: "frame", type: "frame", children: [], props: {} }] });
  // Only the final validation refuses this one; it must run whether the input was checked or not.
  for (const ownValidated of [false, true]) {
    assert.throws(() => applyTransaction(document, ghost("t1", 0), { ownValidated }), (error) => error instanceof DocumentInvariantError && ORPHAN.test(error.message));
  }
  // Without the option, an input holding values that are not JSON is refused before anything
  // is applied. (The validated copy would turn a Map or a Date into {}: that is why only a
  // caller whose document this module validated may skip the check.)
  for (const value of [new Map([["k", 1]]), new Date(0)]) {
    const broken = createDocument({ id: "doc", nodes: [{ id: "frame", type: "frame", children: [], props: {} }] });
    broken.nodes.frame.props.bad = value;
    const good = { id: "t2", actor: "u", baseRevision: 0, operations: [{ type: "set-props", nodeId: "frame", set: { name: "x" } }] };
    assert.throws(() => applyTransaction(broken, good), (error) => error instanceof DocumentInvariantError && /non-plain object/u.test(error.message));
  }
});

test("a store commits, reopens and refuses exactly as before with its own input check skipped (#252)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-edit-cost-")));
  try {
    const document = createDocument({ id: "doc", nodes: [{ id: "frame", type: "frame", children: [], props: {} }] });
    createProject(root, { projectId: "cost", document, createdAt: AT });
    const store = openProject(root, { owner: "w", at: AT });
    store.commit({ id: "t1", actor: "u", baseRevision: 0, operations: [{ type: "insert-node", node: { id: "text", type: "text", props: { text: "hi" } }, parentId: "frame" }] });
    // A transaction only the final validation refuses is refused, and nothing is written: the
    // project still opens.
    const before = store.journalSeq;
    assert.throws(() => store.commit(ghost("t2", 1)), ORPHAN);
    assert.equal(store.journalSeq, before);
    // Changing what the getter returned changes nothing in the store.
    const copy = store.document;
    copy.nodes.frame.props.name = "changed";
    store.commit({ id: "t3", actor: "u", baseRevision: 1, operations: [{ type: "set-props", nodeId: "frame", set: { title: "kept" } }] });
    const committed = store.document;
    assert.equal(committed.nodes.frame.props.name, undefined, "the store's document was never shared");
    store.close();
    const reopened = openProject(root, { owner: "w", at: AT });
    assert.deepStrictEqual(reopened.document, committed, "replay gives the same document");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
