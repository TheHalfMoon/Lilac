import assert from "node:assert/strict";
import test from "node:test";

import {
  DocumentInvariantError,
  createDocument,
  createNode,
  validateDocument,
} from "../packages/document-model/src/index.mjs";
import {
  TransactionError,
  applyTransaction,
  canRedo,
  canUndo,
  commitTransaction,
  createHistoryState,
  createTransaction,
  redo,
  undo,
} from "../packages/history/src/index.mjs";

function wiredBaseDocument() {
  return createDocument({
    id: "doc-1",
    name: "Fixture",
    nodes: [
      createNode({ id: "page-1", type: "page", children: ["frame-1"] }),
      createNode({
        id: "frame-1",
        type: "frame",
        parentId: "page-1",
        children: ["text-1"],
        props: { x: 0, y: 0 },
      }),
      createNode({
        id: "text-1",
        type: "text",
        parentId: "frame-1",
        props: { text: "Hello" },
      }),
    ],
    rootIds: ["page-1"],
  });
}

function structuralSnapshot(document) {
  return {
    id: document.id,
    name: document.name,
    rootIds: document.rootIds,
    nodes: document.nodes,
    metadata: document.metadata,
  };
}

test("document validation rejects inconsistent parent/child links", () => {
  assert.throws(() => createDocument({
    id: "invalid-doc",
    nodes: [
      createNode({ id: "page-1", type: "page" }),
      createNode({ id: "frame-1", type: "frame", parentId: "page-1" }),
    ],
    rootIds: ["page-1"],
  }), DocumentInvariantError);
});

test("canonical graph validates a connected ordered tree", () => {
  const document = wiredBaseDocument();
  assert.equal(validateDocument(document), true);
  assert.equal(document.revision, 0);
  assert.deepEqual(document.rootIds, ["page-1"]);
});

test("transaction inserts nodes and records deterministic provenance", () => {
  const document = wiredBaseDocument();
  const transaction = createTransaction({
    id: "tx-insert",
    actor: "human:fixture",
    baseRevision: 0,
    intent: "Add a button",
    tool: "canvas",
    timestamp: "2026-10-03T00:00:00.000Z",
    operations: [
      {
        type: "insert-node",
        parentId: "frame-1",
        index: 1,
        node: { id: "button-1", type: "element", props: { tag: "button" } },
      },
    ],
  });

  const result = applyTransaction(document, transaction);
  assert.equal(result.document.revision, 1);
  assert.deepEqual(result.document.nodes["frame-1"].children, ["text-1", "button-1"]);
  assert.equal(result.document.nodes["button-1"].parentId, "frame-1");
  assert.deepEqual(result.affectedNodeIds, ["button-1", "frame-1"]);
  assert.equal(result.inverse.metadata.sourceTransactionId, "tx-insert");
  assert.equal(document.nodes["button-1"], undefined, "input document must remain immutable");
});

test("stale transactions fail instead of silently rebasing", () => {
  const document = wiredBaseDocument();
  const transaction = createTransaction({
    id: "tx-stale",
    actor: "agent:test",
    baseRevision: 9,
    operations: [{ type: "set-props", nodeId: "text-1", set: { text: "Changed" } }],
  });
  assert.throws(() => applyTransaction(document, transaction), TransactionError);
});

test("set-props undo restores overwritten and removed values", () => {
  let history = createHistoryState(wiredBaseDocument());
  history = commitTransaction(history, createTransaction({
    id: "tx-props",
    actor: "agent:copy",
    baseRevision: 0,
    operations: [
      {
        type: "set-props",
        nodeId: "text-1",
        set: { text: "World", opacity: 0.5 },
        unset: [],
      },
    ],
  }));

  assert.equal(history.document.nodes["text-1"].props.text, "World");
  assert.equal(history.document.nodes["text-1"].props.opacity, 0.5);
  assert.equal(canUndo(history), true);

  history = undo(history);
  assert.equal(history.document.nodes["text-1"].props.text, "Hello");
  assert.equal("opacity" in history.document.nodes["text-1"].props, false);
  assert.equal(canRedo(history), true);

  history = redo(history);
  assert.equal(history.document.nodes["text-1"].props.text, "World");
  assert.equal(history.document.nodes["text-1"].props.opacity, 0.5);
  assert.equal(history.document.revision, 3, "revisions remain monotonic across commit/undo/redo");
});

test("removing a subtree is exactly reversible except for monotonic revision", () => {
  const initial = wiredBaseDocument();
  let history = createHistoryState(initial);
  history = commitTransaction(history, createTransaction({
    id: "tx-remove-frame",
    actor: "human:fixture",
    baseRevision: 0,
    operations: [{ type: "remove-node", nodeId: "frame-1" }],
  }));

  assert.deepEqual(Object.keys(history.document.nodes), ["page-1"]);
  assert.deepEqual(history.past.at(-1).affectedNodeIds, ["frame-1", "page-1", "text-1"]);
  history = undo(history);
  assert.deepEqual(structuralSnapshot(history.document), structuralSnapshot(initial));
  assert.equal(history.document.revision, 2);
});

test("move-node preserves ordering and cannot create a cycle", () => {
  let document = wiredBaseDocument();
  let result = applyTransaction(document, createTransaction({
    id: "tx-insert-frame",
    actor: "human:fixture",
    baseRevision: 0,
    operations: [{
      type: "insert-node",
      parentId: "page-1",
      index: 1,
      node: { id: "frame-2", type: "frame" },
    }],
  }));
  document = result.document;

  result = applyTransaction(document, createTransaction({
    id: "tx-move-text",
    actor: "human:fixture",
    baseRevision: 1,
    operations: [{ type: "move-node", nodeId: "text-1", parentId: "frame-2", index: 0 }],
  }));
  assert.deepEqual(result.document.nodes["frame-1"].children, []);
  assert.deepEqual(result.document.nodes["frame-2"].children, ["text-1"]);
  assert.deepEqual(result.affectedNodeIds, ["frame-1", "frame-2", "text-1"]);

  assert.throws(() => applyTransaction(result.document, createTransaction({
    id: "tx-cycle",
    actor: "human:fixture",
    baseRevision: 2,
    operations: [{ type: "move-node", nodeId: "page-1", parentId: "text-1", index: 0 }],
  })), TransactionError);
});

test("new commits after undo clear the redo branch", () => {
  let history = createHistoryState(wiredBaseDocument());
  history = commitTransaction(history, createTransaction({
    id: "tx-a",
    actor: "agent:test",
    baseRevision: 0,
    operations: [{ type: "set-props", nodeId: "text-1", set: { text: "A" } }],
  }));
  history = undo(history);
  assert.equal(canRedo(history), true);

  history = commitTransaction(history, createTransaction({
    id: "tx-b",
    actor: "agent:test",
    baseRevision: history.document.revision,
    operations: [{ type: "set-props", nodeId: "text-1", set: { text: "B" } }],
  }));
  assert.equal(canRedo(history), false);
  assert.equal(history.document.nodes["text-1"].props.text, "B");
});

test("long undo/redo sequence returns to the same structural state", () => {
  const initial = wiredBaseDocument();
  let history = createHistoryState(initial);
  for (let index = 0; index < 50; index += 1) {
    history = commitTransaction(history, createTransaction({
      id: `tx-${index}`,
      actor: "agent:property-test",
      baseRevision: history.document.revision,
      operations: [{ type: "set-props", nodeId: "frame-1", set: { x: index + 1 } }],
    }));
  }
  assert.equal(history.document.nodes["frame-1"].props.x, 50);

  for (let index = 0; index < 50; index += 1) history = undo(history);
  assert.deepEqual(structuralSnapshot(history.document), structuralSnapshot(initial));

  for (let index = 0; index < 50; index += 1) history = redo(history);
  assert.equal(history.document.nodes["frame-1"].props.x, 50);
  assert.equal(history.document.revision, 150);
});
