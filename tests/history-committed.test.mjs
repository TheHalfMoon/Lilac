import test from "node:test";
import assert from "node:assert/strict";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { applyCommittedTransaction, applyTransaction } from "../packages/history/src/index.mjs";

// PC8 (#168): applyCommittedTransaction, the in-place apply a mirror of a committed document
// uses (the editor), produces exactly what applyTransaction does.

const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const canonical = (document) => JSON.stringify({ ...document, nodes: Object.fromEntries(Object.keys(document.nodes).sort().map((id) => [id, document.nodes[id]])) });

test("applyCommittedTransaction matches applyTransaction over random sequences", () => {
  for (let seedIndex = 1; seedIndex <= 5; seedIndex += 1) {
    const next = random(seedIndex * 7919);
    let reference = createDocument({ id: "d", nodes: [{ id: "root", type: "frame", children: [], props: {} }] });
    const mirror = structuredClone(reference);
    let counter = 0;
    let applied = 0;
    for (let step = 0; step < 150; step += 1) {
      const ids = Object.keys(reference.nodes);
      const pick = () => ids[Math.floor(next() * ids.length)];
      const choice = next();
      let operation;
      if (choice < 0.35 || ids.length < 3) {
        const parentId = pick();
        operation = { type: "insert-node", node: { id: `n${counter++}`, type: "element", props: { text: `t${step}` } }, parentId, index: reference.nodes[parentId].children.length };
      } else if (choice < 0.6) {
        operation = { type: "set-props", nodeId: pick(), set: { text: `s${step}`, style: { left: `${step}px` } }, ...(next() < 0.3 ? { unset: ["text"] } : {}) };
      } else if (choice < 0.8) {
        const nodeId = pick();
        const parentId = pick();
        if (nodeId === "root") continue;
        operation = { type: "move-node", nodeId, parentId, index: 0 };
      } else {
        const nodeId = pick();
        if (nodeId === "root") continue;
        operation = { type: "remove-node", nodeId };
      }
      let expected;
      try {
        expected = applyTransaction(reference, { id: `t${step}`, actor: "a", operations: [operation] }, { enforceBaseRevision: false });
      } catch {
        // Operations history refuses (cycles) are refused by both; skip them.
        assert.throws(() => applyCommittedTransaction(structuredClone(mirror), { operations: [operation] }));
        continue;
      }
      const actual = applyCommittedTransaction(mirror, { operations: [operation] });
      assert.deepEqual(actual.affectedNodeIds, expected.affectedNodeIds, `seed ${seedIndex} step ${step}`);
      reference = expected.document;
      assert.equal(canonical(mirror), canonical(reference), `seed ${seedIndex} step ${step}`);
      applied += 1;
    }
    assert.ok(applied >= 100, `seed ${seedIndex}: ${applied} operations applied`);
  }
});

test("applyCommittedTransaction matches applyTransaction for multi-operation transactions and undo (restore-subtree)", () => {
  let restores = 0;
  let multi = 0;
  for (let seedIndex = 1; seedIndex <= 5; seedIndex += 1) {
    const next = random(seedIndex * 104729);
    let reference = createDocument({ id: "d", nodes: [{ id: "root", type: "frame", children: [], props: {} }] });
    const mirror = structuredClone(reference);
    let counter = 0;
    let lastInverse = null;
    for (let step = 0; step < 120; step += 1) {
      const ids = Object.keys(reference.nodes);
      const pick = () => ids[Math.floor(next() * ids.length)];
      let operations;
      if (lastInverse !== null && next() < 0.25) {
        // Undo the last transaction: removals come back as restore-subtree.
        operations = lastInverse;
      } else {
        operations = [];
        const count = 1 + Math.floor(next() * 4);
        for (let index = 0; index < count; index += 1) {
          const choice = next();
          if (choice < 0.4 || ids.length < 4) {
            const parentId = pick();
            const id = `n${counter++}`;
            operations.push({ type: "insert-node", node: { id, type: "element", props: { text: `t${step}` } }, parentId, index: 0 });
            ids.push(id);
          } else if (choice < 0.65) {
            operations.push({ type: "set-props", nodeId: pick(), set: { style: { top: `${step}px` } } });
          } else if (choice < 0.8) {
            const nodeId = pick();
            if (nodeId !== "root") operations.push({ type: "move-node", nodeId, parentId: "root", index: 0 });
          } else {
            const nodeId = pick();
            if (nodeId !== "root") operations.push({ type: "remove-node", nodeId });
          }
        }
        if (operations.length === 0) continue;
      }
      let expected;
      try {
        expected = applyTransaction(reference, { id: `t${step}`, actor: "a", operations }, { enforceBaseRevision: false });
      } catch {
        assert.throws(() => applyCommittedTransaction(structuredClone(mirror), { operations }));
        continue;
      }
      if (operations.length > 1) multi += 1;
      if (operations.some((operation) => operation.type === "restore-subtree")) restores += 1;
      const actual = applyCommittedTransaction(mirror, { operations });
      assert.deepEqual(actual.affectedNodeIds, expected.affectedNodeIds, `seed ${seedIndex} step ${step}`);
      reference = expected.document;
      assert.equal(canonical(mirror), canonical(reference), `seed ${seedIndex} step ${step}`);
      lastInverse = operations === lastInverse ? null : expected.inverse.operations;
    }
  }
  assert.ok(multi >= 100, `${multi} multi-operation transactions applied`);
  assert.ok(restores >= 10, `${restores} transactions restored a subtree`);
});

test("applyCommittedTransaction refuses empty transactions and operations that do not apply", () => {
  const document = createDocument({ id: "d", nodes: [{ id: "a", type: "element", props: {} }] });
  assert.throws(() => applyCommittedTransaction(document, { operations: [] }), /non-empty/u);
  assert.throws(() => applyCommittedTransaction(document, { operations: [{ type: "set-props", nodeId: "missing", set: {} }] }));
});
