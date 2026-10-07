export const DOCUMENT_SCHEMA_VERSION = 1;

export const NODE_TYPES = Object.freeze([
  "page",
  "frame",
  "group",
  "element",
  "text",
  "vector",
  "image",
  "media",
  "code-component",
  "component-definition",
  "token-reference",
  "interaction",
  "asset-reference",
  "source-binding",
]);

const NODE_TYPE_SET = new Set(NODE_TYPES);

export class DocumentInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentInvariantError";
  }
}

function cloneData(value) {
  return structuredClone(value);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DocumentInvariantError(`${label} must be a non-empty string`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DocumentInvariantError(`${label} must be a plain object`);
  }
}

function assertUniqueStrings(values, label) {
  if (!Array.isArray(values)) {
    throw new DocumentInvariantError(`${label} must be an array`);
  }
  const seen = new Set();
  for (const value of values) {
    assertNonEmptyString(value, `${label} entry`);
    if (seen.has(value)) {
      throw new DocumentInvariantError(`${label} contains duplicate id ${value}`);
    }
    seen.add(value);
  }
}

// Code-unit order: unlike localeCompare, it does not depend on the process locale.
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function sortNodeRecord(nodes) {
  return Object.fromEntries(
    Object.entries(nodes).sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

const MAX_SERIALIZE_DEPTH = 256;

function canonicalValue(value, depth) {
  if (depth > MAX_SERIALIZE_DEPTH) {
    throw new DocumentInvariantError(`cannot serialize values nested deeper than ${MAX_SERIALIZE_DEPTH}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DocumentInvariantError("cannot serialize a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new DocumentInvariantError("cannot serialize a sparse array");
      parts.push(canonicalValue(value[index], depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DocumentInvariantError("cannot serialize a non-plain object");
    }
    const body = Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => {
        if (value[key] === undefined) {
          throw new DocumentInvariantError(`cannot serialize undefined at key ${JSON.stringify(key).slice(0, 80)}`);
        }
        return `${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1)}`;
      })
      .join(",");
    return `{${body}}`;
  }
  throw new DocumentInvariantError(`cannot serialize a ${typeof value} value`);
}

/**
 * Canonical JSON for a valid document: keys in code-unit order at every depth,
 * no whitespace, -0 written as 0. Values JSON cannot represent faithfully are refused.
 */
export function serializeDocument(document) {
  validateDocument(document);
  return canonicalValue(document, 0);
}

/**
 * Parse canonical document text. Only the exact canonical form is accepted, so one
 * document has exactly one byte representation.
 */
export function parseDocument(text) {
  if (typeof text !== "string") throw new DocumentInvariantError("document text must be a string");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DocumentInvariantError("document text is not valid JSON");
  }
  if (serializeDocument(value) !== text) {
    throw new DocumentInvariantError("document text is not in canonical form");
  }
  return normalizeDocument(value);
}

export function createNode({
  id,
  type,
  parentId = null,
  children = [],
  props = {},
  metadata = {},
}) {
  assertNonEmptyString(id, "node.id");
  if (!NODE_TYPE_SET.has(type)) {
    throw new DocumentInvariantError(`Unsupported node type ${String(type)}`);
  }
  if (parentId !== null) {
    assertNonEmptyString(parentId, "node.parentId");
  }
  assertUniqueStrings(children, "node.children");
  assertPlainObject(props, "node.props");
  assertPlainObject(metadata, "node.metadata");

  return {
    id,
    type,
    parentId,
    children: [...children],
    props: cloneData(props),
    metadata: cloneData(metadata),
  };
}

export function createDocument({
  id,
  name = "Untitled",
  nodes = [],
  rootIds = null,
  metadata = {},
  revision = 0,
} = {}) {
  assertNonEmptyString(id, "document.id");
  assertNonEmptyString(name, "document.name");
  assertPlainObject(metadata, "document.metadata");
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new DocumentInvariantError("document.revision must be a non-negative safe integer");
  }

  const record = {};
  const sourceNodes = Array.isArray(nodes) ? nodes : Object.values(nodes);
  for (const input of sourceNodes) {
    const node = createNode(input);
    if (record[node.id]) {
      throw new DocumentInvariantError(`Duplicate node id ${node.id}`);
    }
    record[node.id] = node;
  }

  const resolvedRoots = rootIds === null
    ? Object.values(record).filter((node) => node.parentId === null).map((node) => node.id)
    : [...rootIds];

  const document = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id,
    name,
    revision,
    rootIds: resolvedRoots,
    nodes: sortNodeRecord(record),
    metadata: cloneData(metadata),
  };

  validateDocument(document);
  return document;
}

export function cloneDocument(document) {
  validateDocument(document);
  return cloneData(document);
}

export function normalizeDocument(document) {
  const copy = cloneDocument(document);
  copy.nodes = sortNodeRecord(copy.nodes);
  return copy;
}

export function getNode(document, nodeId) {
  const node = document.nodes[nodeId];
  if (!node) {
    throw new DocumentInvariantError(`Unknown node id ${nodeId}`);
  }
  return node;
}

export function getSubtreeNodeIds(document, nodeId) {
  getNode(document, nodeId);
  const result = [];
  const visit = (id) => {
    result.push(id);
    for (const childId of document.nodes[id].children) {
      visit(childId);
    }
  };
  visit(nodeId);
  return result;
}

export function getNodeIndex(document, nodeId) {
  const node = getNode(document, nodeId);
  const siblings = node.parentId === null
    ? document.rootIds
    : getNode(document, node.parentId).children;
  const index = siblings.indexOf(nodeId);
  if (index < 0) {
    throw new DocumentInvariantError(`Node ${nodeId} is detached from its declared parent`);
  }
  return index;
}

export function isDescendant(document, ancestorId, candidateId) {
  getNode(document, ancestorId);
  getNode(document, candidateId);
  let cursor = document.nodes[candidateId];
  while (cursor.parentId !== null) {
    if (cursor.parentId === ancestorId) return true;
    cursor = getNode(document, cursor.parentId);
  }
  return false;
}

export function validateDocument(document) {
  assertPlainObject(document, "document");
  if (document.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new DocumentInvariantError(
      `Unsupported document schema version ${String(document.schemaVersion)}`,
    );
  }
  assertNonEmptyString(document.id, "document.id");
  assertNonEmptyString(document.name, "document.name");
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) {
    throw new DocumentInvariantError("document.revision must be a non-negative safe integer");
  }
  assertUniqueStrings(document.rootIds, "document.rootIds");
  assertPlainObject(document.nodes, "document.nodes");
  assertPlainObject(document.metadata, "document.metadata");

  const rootSet = new Set(document.rootIds);
  for (const [id, node] of Object.entries(document.nodes)) {
    assertNonEmptyString(id, "document node key");
    assertPlainObject(node, `node ${id}`);
    if (node.id !== id) {
      throw new DocumentInvariantError(`Node record key ${id} does not match node.id ${String(node.id)}`);
    }
    if (!NODE_TYPE_SET.has(node.type)) {
      throw new DocumentInvariantError(`Node ${id} has unsupported type ${String(node.type)}`);
    }
    if (node.parentId !== null && !document.nodes[node.parentId]) {
      throw new DocumentInvariantError(`Node ${id} references missing parent ${node.parentId}`);
    }
    assertUniqueStrings(node.children, `node ${id}.children`);
    assertPlainObject(node.props, `node ${id}.props`);
    assertPlainObject(node.metadata, `node ${id}.metadata`);

    if (node.parentId === null && !rootSet.has(id)) {
      throw new DocumentInvariantError(`Root node ${id} is missing from document.rootIds`);
    }
    if (node.parentId !== null && rootSet.has(id)) {
      throw new DocumentInvariantError(`Non-root node ${id} appears in document.rootIds`);
    }

    for (const childId of node.children) {
      const child = document.nodes[childId];
      if (!child) {
        throw new DocumentInvariantError(`Node ${id} references missing child ${childId}`);
      }
      if (child.parentId !== id) {
        throw new DocumentInvariantError(
          `Child ${childId} declares parent ${String(child.parentId)} instead of ${id}`,
        );
      }
    }
  }

  for (const rootId of document.rootIds) {
    const root = document.nodes[rootId];
    if (!root) {
      throw new DocumentInvariantError(`document.rootIds references missing node ${rootId}`);
    }
    if (root.parentId !== null) {
      throw new DocumentInvariantError(`Root node ${rootId} must have parentId null`);
    }
  }

  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.parentId !== null) {
      const occurrences = document.nodes[node.parentId].children.filter((childId) => childId === id).length;
      if (occurrences !== 1) {
        throw new DocumentInvariantError(
          `Parent ${node.parentId} must reference child ${id} exactly once`,
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      throw new DocumentInvariantError(`Cycle detected at node ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const childId of document.nodes[id].children) visit(childId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const rootId of document.rootIds) visit(rootId);

  if (visited.size !== Object.keys(document.nodes).length) {
    const unreachable = Object.keys(document.nodes).filter((id) => !visited.has(id));
    throw new DocumentInvariantError(`Unreachable nodes: ${unreachable.join(", ")}`);
  }

  return true;
}
