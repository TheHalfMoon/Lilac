import test from "node:test";
import assert from "node:assert/strict";

import { createDocument, parseDocument, serializeDocument, validateDocument } from "../packages/document-model/src/index.mjs";
import { canRedo, canUndo, commitTransaction, createHistoryState, redo, replayTransactions, undo } from "../packages/history/src/index.mjs";
import { createPrng, propertySeeds } from "./support/prng.mjs";

// Generated undo/redo properties over every history operation type. A failure
// names its seed; replay it with NINERR_PROPERTY_SEED=<seed>.

const PROP_KEYS = ["x", "y", "fill", "text", "__proto__", "constructor", "toString", "a.b", ""];

// Content without the revision counter, which every apply (including undo) advances.
function content(document) {
  return serializeDocument({ ...document, revision: 0 });
}

function randomPropValue(prng) {
  return prng.pick([0, -1, 2.5, "s", "", null, true, [1, "two"], { nested: { deep: [null] } }]);
}

function nodeIds(document) {
  return Object.keys(document.nodes);
}

function randomOperation(prng, document, counter) {
  const ids = nodeIds(document);
  // Weighted: inserts and prop edits twice as often as removes and moves.
  const kind = prng.pick(["insert-node", "insert-node", "set-props", "set-props", "remove-node", "move-node"]);
  const anyParent = () => (prng.next() < 0.25 || ids.length === 0 ? null : prng.pick(ids));
  if (kind === "insert-node" || ids.length === 0) {
    const reserved = prng.next() < 0.1;
    const insertedId = reserved ? prng.pick(["__proto__", "constructor", "toString"]) : `n${counter.next++}`;
    return {
      type: "insert-node",
      parentId: anyParent(),
      index: prng.pick([undefined, 0, 1, 99]),
      node: { id: insertedId, type: prng.pick(["frame", "text", "group"]), props: { x: prng.int(0, 9) } },
    };
  }
  const nodeId = prng.pick(ids);
  if (kind === "remove-node") return { type: "remove-node", nodeId };
  if (kind === "move-node") return { type: "move-node", nodeId, parentId: anyParent(), index: prng.pick([undefined, 0, 1, 99]) };
  // Built from JSON, as a transaction arriving over a wire would be, so a
  // "__proto__" key is an own property rather than a prototype assignment.
  const entries = prng.shuffle(PROP_KEYS).slice(0, prng.int(0, 3)).filter((key) => key !== "");
  const set = JSON.parse(`{${entries.map((key) => `${JSON.stringify(key)}:${JSON.stringify(randomPropValue(prng))}`).join(",")}}`);
  const unset = prng.shuffle(PROP_KEYS.filter((key) => key !== "")).slice(0, prng.int(0, 2));
  return { type: "set-props", nodeId, set, unset };
}

function randomTransaction(prng, history, counter, step) {
  // Operations are generated against a scratch history so multi-op transactions stay mostly valid.
  let scratch = history;
  const operations = [];
  for (let index = 0; index < prng.int(1, 3); index += 1) {
    const operation = randomOperation(prng, scratch.document, counter);
    operations.push(operation);
    try {
      scratch = commitTransaction(scratch, { id: `scratch-${step}-${index}`, actor: "gen", operations: [operation] });
    } catch {
      break;
    }
  }
  return { id: `tx-${step}`, actor: "user-1", baseRevision: history.document.revision, operations };
}

function initialDocument() {
  return createDocument({
    id: "doc-1",
    nodes: [
      { id: "root", type: "page", children: ["a", "b"] },
      { id: "a", type: "frame", parentId: "root", children: ["c"], props: { x: 1 } },
      { id: "b", type: "frame", parentId: "root" },
      { id: "c", type: "text", parentId: "a", props: { text: "hi" } },
    ],
  });
}

function runSeed(seed, stats) {
  let currentStep = "setup";
  try {
    runSteps(seed, stats, (step) => { currentStep = step; });
  } catch (error) {
    // Assertion messages already carry seed and step; anything else thrown by
    // undo, redo or validation is attributed here so the seed can be replayed.
    if (String(error?.message).startsWith(`seed ${seed}`)) throw error;
    throw new Error(`seed ${seed} step ${currentStep}: ${error?.message}`, { cause: error });
  }
}

function runSteps(seed, stats, setStep) {
  const prng = createPrng(seed);
  const counter = { next: 0 };
  let history = createHistoryState(initialDocument());
  const contents = [content(history.document)];
  const where = (step, detail) => `seed ${seed} step ${step}: ${detail}`;

  for (let step = 0; step < 25; step += 1) {
    setStep(step);
    const action = prng.next();
    if (action < 0.55 || !canUndo(history)) {
      const transaction = randomTransaction(prng, history, counter, step);
      const before = structuredClone(history);
      let next;
      try {
        next = commitTransaction(history, transaction);
      } catch {
        assert.deepEqual(history, before, where(step, "a rejected transaction must leave history untouched"));
        stats.rejected += 1;
        continue;
      }
      for (const operation of transaction.operations) stats[operation.type] += 1;
      if (transaction.operations.length > 1) stats.multiOperation += 1;
      validateDocument(next.document);
      assert.equal(next.document.revision, history.document.revision + 1, where(step, "commit advances revision by one"));
      const [only] = transaction.operations;
      if (transaction.operations.length === 1 && only.type === "set-props") {
        const props = next.document.nodes[only.nodeId].props;
        for (const [key, value] of Object.entries(only.set)) {
          assert.ok(Object.hasOwn(props, key), where(step, `set-props stores ${JSON.stringify(key)} as an own prop`));
          assert.deepEqual(props[key], value, where(step, `set-props stores the value of ${JSON.stringify(key)}`));
        }
        for (const key of only.unset) {
          if (!Object.hasOwn(only.set, key)) assert.equal(Object.hasOwn(props, key), false, where(step, `unset removes ${JSON.stringify(key)}`));
        }
      }
      assert.equal(canRedo(next), false, where(step, "a commit clears redo"));
      contents.length = history.past.length + 1; // a commit discards the redo branch
      contents.push(content(next.document));
      history = next;
    } else if (action < 0.85) {
      const depth = history.past.length;
      if (history.past[depth - 1].inverse.operations.some((operation) => operation.type === "restore-subtree")) stats["restore-subtree"] += 1;
      const next = undo(history);
      validateDocument(next.document);
      assert.equal(next.past.length, depth - 1, where(step, "undo pops one entry"));
      assert.equal(content(next.document), contents[depth - 1], where(step, "undo restores the previous content exactly"));
      history = next;
    } else if (canRedo(history)) {
      const depth = history.past.length;
      const next = redo(history);
      validateDocument(next.document);
      assert.equal(content(next.document), contents[depth + 1], where(step, "redo reapplies the undone content exactly"));
      history = next;
    }
  }

  // Undo everything, then redo everything.
  setStep("undo-all/redo-all");
  const finalContent = content(history.document);
  const depth = history.past.length;
  while (canUndo(history)) history = undo(history);
  assert.equal(content(history.document), contents[0], `seed ${seed}: undoing all restores the initial content`);
  for (let index = 0; index < depth; index += 1) history = redo(history);
  assert.equal(content(history.document), finalContent, `seed ${seed}: redoing all restores the final content`);
}

test("undo and redo restore exact content across generated transactions", () => {
  const stats = { "insert-node": 0, "remove-node": 0, "move-node": 0, "set-props": 0, "restore-subtree": 0, multiOperation: 0, rejected: 0 };
  const seeds = propertySeeds(300);
  for (const seed of seeds) runSeed(seed, stats);
  // Guard the generator itself: a weighting change must not silently stop
  // exercising an operation type, multi-operation commits, or rejections.
  if (seeds.length > 1) {
    for (const [name, count] of Object.entries(stats)) assert.ok(count > 0, `generator never produced ${name}`);
  }
});

test("set-props keeps reserved-looking keys as own data and undo removes them", () => {
  const document = createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] });
  let history = createHistoryState(document);
  const set = JSON.parse('{"__proto__":{"polluted":true},"constructor":"c","x":1}');
  history = commitTransaction(history, { id: "t1", actor: "user-1", operations: [{ type: "set-props", nodeId: "n", set }] });
  const props = history.document.nodes.n.props;
  assert.deepEqual(Object.keys(props).sort(), ["__proto__", "constructor", "x"]);
  assert.deepEqual(props.__proto__, { polluted: true });
  assert.equal(Object.getPrototypeOf(props), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.match(serializeDocument(history.document), /"__proto__":\{"polluted":true\}/u);
  history = undo(history);
  assert.deepEqual(Object.keys(history.document.nodes.n.props), []);
  history = redo(history);
  assert.deepEqual(history.document.nodes.n.props.__proto__, { polluted: true });
});

test("reserved-looking node ids are ordinary nodes through insert, remove and undo", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    let history = createHistoryState(createDocument({ id: "doc-1", nodes: [{ id: "root", type: "frame" }] }));
    history = commitTransaction(history, { id: "t1", actor: "user-1", operations: [{ type: "insert-node", parentId: "root", node: { id, type: "text", props: { v: 1 } } }] });
    assert.ok(Object.hasOwn(history.document.nodes, id), `${id} inserted as an own node`);
    // The same document reloaded from its canonical text behaves identically.
    history = createHistoryState(parseDocument(serializeDocument(history.document)));
    history = commitTransaction(history, { id: "t2", actor: "user-1", operations: [{ type: "remove-node", nodeId: id }] });
    assert.equal(Object.hasOwn(history.document.nodes, id), false, `${id} removed`);
    history = undo(history);
    assert.deepEqual(history.document.nodes[id].props, { v: 1 }, `${id} restored by undo`);
    assert.equal(Object.getPrototypeOf(history.document.nodes), Object.prototype);
  }
  assert.equal(createDocument({ id: "doc-1", nodes: [{ id: "__proto__", type: "frame" }] }).nodes.__proto__.id, "__proto__");
});

test("replaying committed transactions in one batch gives exactly what applying them one by one gives (#251)", () => {
  for (const seed of propertySeeds(100)) {
    const prng = createPrng(seed);
    const counter = { next: 0 };
    let history = createHistoryState(initialDocument());
    const committed = [];
    for (let step = 0; step < 25; step += 1) {
      const transaction = randomTransaction(prng, history, counter, step);
      try {
        history = commitTransaction(history, transaction);
        committed.push(transaction);
      } catch {
        // A generated transaction that does not apply is not committed, as in a journal.
      }
    }
    assert.equal(serializeDocument(replayTransactions(initialDocument(), committed)), serializeDocument(history.document), `seed ${seed}`);
  }
  const start = initialDocument();
  const first = { id: "t1", actor: "u", baseRevision: 0, operations: [{ type: "set-props", nodeId: "a", set: { x: 2 } }] };
  // A transaction that does not apply, or comes on the wrong revision, is named by its index.
  assert.throws(() => replayTransactions(start, [first, { id: "t2", actor: "u", baseRevision: 1, operations: [{ type: "remove-node", nodeId: "missing" }] }]), (error) => error.index === 1);
  assert.throws(() => replayTransactions(start, [first, { id: "t3", actor: "u", baseRevision: 0, operations: [{ type: "set-props", nodeId: "a", set: { x: 3 } }] }]), (error) => error.index === 1 && /Stale/u.test(error.message));
  // A result that is not a valid document is refused as a whole.
  assert.throws(() => replayTransactions(start, [first, { id: "t4", actor: "u", baseRevision: 1, operations: [{ type: "insert-node", node: { id: "bad", type: "not-a-type", props: {} }, parentId: null }] }]));
  assert.equal(serializeDocument(start), serializeDocument(initialDocument()), "the input is not changed");
});
