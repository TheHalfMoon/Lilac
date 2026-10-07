import {
  cloneDocument,
  createNode,
  getNode,
  getNodeIndex,
  getSubtreeNodeIds,
  isDescendant,
  jsonDataProblem,
  validateDocument,
  withSortedNodes,
} from "../../document-model/src/index.mjs";

export class TransactionError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransactionError";
  }
}

function cloneData(value) {
  return structuredClone(value);
}

function assertPlainObject(value, label) {
  const prototype = value === null || typeof value !== "object" ? undefined : Object.getPrototypeOf(value);
  if (Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new TransactionError(`${label} must be a plain object`);
  }
}

function assertJsonData(value, label) {
  assertPlainObject(value, label);
  const problem = jsonDataProblem(value);
  if (problem !== null) throw new TransactionError(`${label} ${problem}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TransactionError(`${label} must be a non-empty string`);
  }
}

function normalizeIndex(index, length) {
  if (index === undefined || index === null) return length;
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new TransactionError(`index must be an integer between 0 and ${length}`);
  }
  return index;
}

export function createTransaction({
  id,
  actor,
  operations,
  baseRevision = null,
  intent = null,
  tool = null,
  timestamp = null,
  metadata = {},
}) {
  assertNonEmptyString(id, "transaction.id");
  assertNonEmptyString(actor, "transaction.actor");
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TransactionError("transaction.operations must be a non-empty array");
  }
  if (baseRevision !== null && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) {
    throw new TransactionError("transaction.baseRevision must be null or a non-negative safe integer");
  }
  if (intent !== null && typeof intent !== "string") {
    throw new TransactionError("transaction.intent must be null or a string");
  }
  if (tool !== null && typeof tool !== "string") {
    throw new TransactionError("transaction.tool must be null or a string");
  }
  if (timestamp !== null && typeof timestamp !== "string") {
    throw new TransactionError("transaction.timestamp must be null or a string");
  }
  assertJsonData(metadata, "transaction.metadata");

  return {
    id,
    actor,
    baseRevision,
    intent,
    tool,
    timestamp,
    metadata: cloneData(metadata),
    operations: cloneData(operations),
  };
}

// Define an own data property. Plain assignment would treat a "__proto__" key
// (an ordinary own key in parsed JSON) as a prototype change and drop the value.
function setOwn(record, key, value) {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}

function detachNode(document, nodeId) {
  const node = getNode(document, nodeId);
  const siblings = node.parentId === null
    ? document.rootIds
    : getNode(document, node.parentId).children;
  const index = siblings.indexOf(nodeId);
  if (index < 0) {
    throw new TransactionError(`Node ${nodeId} is detached from its declared parent`);
  }
  siblings.splice(index, 1);
  return { parentId: node.parentId, index };
}

function attachNode(document, nodeId, parentId, index) {
  if (parentId === null) {
    const resolvedIndex = normalizeIndex(index, document.rootIds.length);
    document.rootIds.splice(resolvedIndex, 0, nodeId);
    document.nodes[nodeId].parentId = null;
    return resolvedIndex;
  }

  const parent = getNode(document, parentId);
  const resolvedIndex = normalizeIndex(index, parent.children.length);
  parent.children.splice(resolvedIndex, 0, nodeId);
  document.nodes[nodeId].parentId = parentId;
  return resolvedIndex;
}

function applyInsertNode(document, operation) {
  assertPlainObject(operation.node, "insert-node.node");
  const node = createNode(operation.node);
  if (Object.hasOwn(document.nodes, node.id)) {
    throw new TransactionError(`Cannot insert duplicate node id ${node.id}`);
  }
  if (node.children.length !== 0) {
    throw new TransactionError("insert-node only accepts leaf nodes; use restore-subtree for snapshots");
  }
  const parentId = operation.parentId ?? null;
  if (parentId !== null) getNode(document, parentId);

  node.parentId = parentId;
  setOwn(document.nodes, node.id, node);
  attachNode(document, node.id, parentId, operation.index);
  return { type: "remove-node", nodeId: node.id };
}

function applyRemoveNode(document, operation) {
  const nodeId = operation.nodeId;
  assertNonEmptyString(nodeId, "remove-node.nodeId");
  getNode(document, nodeId);
  const { parentId, index } = detachNode(document, nodeId);
  const subtreeIds = getSubtreeNodeIds(document, nodeId);
  const nodes = subtreeIds.map((id) => cloneData(document.nodes[id]));
  for (const id of subtreeIds) delete document.nodes[id];

  return {
    type: "restore-subtree",
    rootId: nodeId,
    parentId,
    index,
    nodes,
  };
}

function applyRestoreSubtree(document, operation) {
  assertNonEmptyString(operation.rootId, "restore-subtree.rootId");
  if (!Array.isArray(operation.nodes) || operation.nodes.length === 0) {
    throw new TransactionError("restore-subtree.nodes must be a non-empty array");
  }
  const snapshot = operation.nodes.map((input) => createNode(input));
  const snapshotIds = new Set(snapshot.map((node) => node.id));
  if (!snapshotIds.has(operation.rootId)) {
    throw new TransactionError("restore-subtree.nodes does not contain rootId");
  }
  for (const node of snapshot) {
    if (Object.hasOwn(document.nodes, node.id)) {
      throw new TransactionError(`Cannot restore existing node id ${node.id}`);
    }
    for (const childId of node.children) {
      if (!snapshotIds.has(childId)) {
        throw new TransactionError(`Restore snapshot is missing child ${childId}`);
      }
    }
  }
  const parentId = operation.parentId ?? null;
  if (parentId !== null) getNode(document, parentId);

  for (const node of snapshot) setOwn(document.nodes, node.id, node);
  document.nodes[operation.rootId].parentId = parentId;
  attachNode(document, operation.rootId, parentId, operation.index);
  return { type: "remove-node", nodeId: operation.rootId };
}

function applySetProps(document, operation) {
  const node = getNode(document, operation.nodeId);
  const set = operation.set ?? {};
  const unset = operation.unset ?? [];
  assertJsonData(set, "set-props.set");
  if (!Array.isArray(unset) || unset.some((key) => typeof key !== "string" || key === "")) {
    throw new TransactionError("set-props.unset must be an array of non-empty strings");
  }
  const touched = new Set([...Object.keys(set), ...unset]);
  const inverseSet = {};
  const inverseUnset = [];

  for (const key of touched) {
    if (Object.prototype.hasOwnProperty.call(node.props, key)) {
      setOwn(inverseSet, key, cloneData(node.props[key]));
    } else {
      inverseUnset.push(key);
    }
  }

  for (const key of unset) delete node.props[key];
  for (const [key, value] of Object.entries(set)) setOwn(node.props, key, cloneData(value));

  return {
    type: "set-props",
    nodeId: operation.nodeId,
    set: inverseSet,
    unset: inverseUnset,
  };
}

function applyMoveNode(document, operation) {
  const nodeId = operation.nodeId;
  assertNonEmptyString(nodeId, "move-node.nodeId");
  const newParentId = operation.parentId ?? null;
  getNode(document, nodeId);
  if (newParentId !== null) {
    getNode(document, newParentId);
    if (newParentId === nodeId || isDescendant(document, nodeId, newParentId)) {
      throw new TransactionError(`Cannot move node ${nodeId} into its own subtree`);
    }
  }

  const oldParentId = document.nodes[nodeId].parentId;
  const oldIndex = getNodeIndex(document, nodeId);
  detachNode(document, nodeId);

  try {
    attachNode(document, nodeId, newParentId, operation.index);
  } catch (error) {
    attachNode(document, nodeId, oldParentId, oldIndex);
    throw error;
  }

  return {
    type: "move-node",
    nodeId,
    parentId: oldParentId,
    index: oldIndex,
  };
}

function applyOperation(document, operation) {
  assertPlainObject(operation, "operation");
  switch (operation.type) {
    case "insert-node":
      return applyInsertNode(document, operation);
    case "remove-node":
      return applyRemoveNode(document, operation);
    case "restore-subtree":
      return applyRestoreSubtree(document, operation);
    case "set-props":
      return applySetProps(document, operation);
    case "move-node":
      return applyMoveNode(document, operation);
    default:
      throw new TransactionError(`Unsupported operation type ${String(operation.type)}`);
  }
}

function collectAffectedNodeIds(document, operation, ids) {
  const add = (value) => {
    if (typeof value === "string" && value !== "") ids.add(value);
  };

  switch (operation.type) {
    case "insert-node":
      add(operation.node?.id);
      add(operation.parentId);
      break;
    case "remove-node": {
      const node = getNode(document, operation.nodeId);
      add(node.parentId);
      for (const id of getSubtreeNodeIds(document, operation.nodeId)) add(id);
      break;
    }
    case "restore-subtree":
      add(operation.parentId);
      for (const node of operation.nodes ?? []) add(node?.id);
      break;
    case "set-props":
      add(operation.nodeId);
      break;
    case "move-node": {
      const node = getNode(document, operation.nodeId);
      add(operation.nodeId);
      add(node.parentId);
      add(operation.parentId);
      break;
    }
  }
}

export function getAffectedNodeIds(transaction) {
  const ids = new Set();
  for (const operation of transaction.operations) {
    if (typeof operation.nodeId === "string") ids.add(operation.nodeId);
    if (operation.node && typeof operation.node.id === "string") ids.add(operation.node.id);
    if (Array.isArray(operation.nodes)) {
      for (const node of operation.nodes) {
        if (node && typeof node.id === "string") ids.add(node.id);
      }
    }
  }
  return [...ids].sort();
}

export function applyTransaction(document, transaction, { enforceBaseRevision = true } = {}) {
  validateDocument(document);
  const normalizedTransaction = createTransaction(transaction);
  if (
    enforceBaseRevision
    && normalizedTransaction.baseRevision !== null
    && normalizedTransaction.baseRevision !== document.revision
  ) {
    throw new TransactionError(
      `Stale transaction ${normalizedTransaction.id}: expected revision ${normalizedTransaction.baseRevision}, current revision ${document.revision}`,
    );
  }

  // The input was validated above, so a private structured clone suffices;
  // cloneDocument/normalizeDocument would validate and clone it twice more.
  const working = cloneData(document);
  const inverseOperations = [];
  const affectedNodeIds = new Set();
  for (const operation of normalizedTransaction.operations) {
    collectAffectedNodeIds(working, operation, affectedNodeIds);
    const inverse = applyOperation(working, operation);
    inverseOperations.unshift(inverse);
  }
  working.revision = document.revision + 1;
  const normalizedDocument = withSortedNodes(working);
  validateDocument(normalizedDocument);

  const inverse = createTransaction({
    id: `undo:${normalizedTransaction.id}`,
    actor: "history",
    operations: inverseOperations,
    baseRevision: normalizedDocument.revision,
    intent: `Undo ${normalizedTransaction.id}`,
    tool: "history",
    timestamp: normalizedTransaction.timestamp,
    metadata: { sourceTransactionId: normalizedTransaction.id },
  });

  return {
    document: normalizedDocument,
    inverse,
    transaction: normalizedTransaction,
    affectedNodeIds: [...affectedNodeIds].sort(),
  };
}

export function createHistoryState(document) {
  validateDocument(document);
  return {
    document: cloneDocument(document),
    past: [],
    future: [],
  };
}

export function canUndo(history) {
  return history.past.length > 0;
}

export function canRedo(history) {
  return history.future.length > 0;
}

export function commitTransaction(history, transaction) {
  const result = applyTransaction(history.document, transaction);
  const entry = {
    transaction: result.transaction,
    inverse: result.inverse,
    affectedNodeIds: result.affectedNodeIds,
  };
  return {
    document: result.document,
    past: [...history.past, entry],
    future: [],
  };
}

export function undo(history) {
  if (!canUndo(history)) return history;
  const past = history.past.slice();
  const entry = past.pop();
  const result = applyTransaction(
    history.document,
    { ...entry.inverse, baseRevision: history.document.revision },
    { enforceBaseRevision: false },
  );
  return {
    document: result.document,
    past,
    future: [...history.future, entry],
  };
}

export function redo(history) {
  if (!canRedo(history)) return history;
  const future = history.future.slice();
  const entry = future.pop();
  const result = applyTransaction(
    history.document,
    { ...entry.transaction, baseRevision: history.document.revision },
    { enforceBaseRevision: false },
  );
  return {
    document: result.document,
    past: [...history.past, entry],
    future,
  };
}
