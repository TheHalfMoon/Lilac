export const DOCUMENT_SCHEMA_VERSION = 1;

// Hard limits; documents beyond them are refused rather than processed slowly.
// maxDocumentBytes matches persistence's object size limit.
export const DOCUMENT_LIMITS = Object.freeze({
  maxNodes: 100_000,
  maxTreeDepth: 1_024,
  maxDocumentBytes: 64 * 1024 * 1024,
});

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
      const shownValue = value.length > 80 ? `${value.slice(0, 77)}...` : value;
      throw new DocumentInvariantError(`${label} contains duplicate id ${shownValue}`);
    }
    seen.add(value);
  }
}

// Code-unit order: unlike localeCompare, it does not depend on the process locale.
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// In-memory key order is a convenience: JS always enumerates integer-like keys
// first. The canonical order is the one serializeDocument writes.
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

// UTF-8 byte length without Buffer, so the model stays environment-neutral.
function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Parse canonical document text. Only the exact canonical form is accepted, so one
 * document has exactly one byte representation.
 */
export function parseDocument(text) {
  if (typeof text !== "string") throw new DocumentInvariantError("document text must be a string");
  // UTF-16 length bounds UTF-8 bytes from below (x1) and above (x3); count exactly only near the limit.
  if (text.length > DOCUMENT_LIMITS.maxDocumentBytes
    || (text.length * 3 > DOCUMENT_LIMITS.maxDocumentBytes && utf8Length(text) > DOCUMENT_LIMITS.maxDocumentBytes)) {
    throw new DocumentInvariantError(`document text exceeds ${DOCUMENT_LIMITS.maxDocumentBytes} bytes`);
  }
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
    // Own-key check and data definition: a node id such as "__proto__" or
    // "constructor" is an ordinary key, not an inherited member.
    if (Object.hasOwn(record, node.id)) {
      throw new DocumentInvariantError(`Duplicate node id ${node.id}`);
    }
    Object.defineProperty(record, node.id, { value: node, writable: true, enumerable: true, configurable: true });
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

/**
 * Canonical node order for a document the caller already owns (for example a
 * private working copy): no validation and no clone, so it is cheap on large
 * documents. Returns a new top-level object; node objects are shared.
 */
export function withSortedNodes(document) {
  return { ...document, nodes: sortNodeRecord(document.nodes) };
}

export function getNode(document, nodeId) {
  // Same key coercion as a property lookup (so getNode(doc, 5) still finds
  // node "5"), but own keys only: inherited names such as toString are not nodes.
  const key = typeof nodeId === "symbol" ? undefined : String(nodeId);
  const node = key !== undefined && Object.hasOwn(document.nodes, key) ? document.nodes[key] : undefined;
  if (!node) {
    let shown = "(symbol)";
    if (key !== undefined) shown = key.length > 80 ? `${key.slice(0, 77)}...` : key;
    throw new DocumentInvariantError(`Unknown node id ${shown}`);
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

  // Own-key lookups only: an id such as "toString" or "__proto__" must not
  // resolve through Object.prototype. Ids are shortened in messages so an
  // oversized id cannot produce an oversized error.
  const nodes = document.nodes;
  const lookup = (id) => (typeof id === "string" && Object.hasOwn(nodes, id) ? nodes[id] : undefined);
  const shown = (id) => {
    const text = String(id);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };

  const nodeTotal = Object.keys(nodes).length;
  if (nodeTotal > DOCUMENT_LIMITS.maxNodes) {
    throw new DocumentInvariantError(`document has ${nodeTotal} nodes; the limit is ${DOCUMENT_LIMITS.maxNodes}`);
  }

  const rootSet = new Set(document.rootIds);
  const referenced = new Set();
  for (const [id, node] of Object.entries(nodes)) {
    assertNonEmptyString(id, "document node key");
    assertPlainObject(node, `node ${shown(id)}`);
    if (node.id !== id) {
      throw new DocumentInvariantError(`Node record key ${shown(id)} does not match node.id ${shown(node.id)}`);
    }
    if (!NODE_TYPE_SET.has(node.type)) {
      throw new DocumentInvariantError(`Node ${shown(id)} has unsupported type ${shown(node.type)}`);
    }
    if (node.parentId !== null && !lookup(node.parentId)) {
      throw new DocumentInvariantError(`Node ${shown(id)} references missing parent ${shown(node.parentId)}`);
    }
    assertUniqueStrings(node.children, `node ${shown(id)}.children`);
    assertPlainObject(node.props, `node ${shown(id)}.props`);
    assertPlainObject(node.metadata, `node ${shown(id)}.metadata`);

    if (node.parentId === null && !rootSet.has(id)) {
      throw new DocumentInvariantError(`Root node ${shown(id)} is missing from document.rootIds`);
    }
    if (node.parentId !== null && rootSet.has(id)) {
      throw new DocumentInvariantError(`Non-root node ${shown(id)} appears in document.rootIds`);
    }

    for (const childId of node.children) {
      const child = lookup(childId);
      if (!child) {
        throw new DocumentInvariantError(`Node ${shown(id)} references missing child ${shown(childId)}`);
      }
      if (child.parentId !== id) {
        throw new DocumentInvariantError(
          `Child ${shown(childId)} declares parent ${shown(child.parentId)} instead of ${shown(id)}`,
        );
      }
      // Children are unique per parent and each child names one parent, so a
      // child is referenced at most once overall.
      referenced.add(childId);
    }
  }

  for (const rootId of document.rootIds) {
    const root = lookup(rootId);
    if (!root) {
      throw new DocumentInvariantError(`document.rootIds references missing node ${shown(rootId)}`);
    }
    if (root.parentId !== null) {
      throw new DocumentInvariantError(`Root node ${shown(rootId)} must have parentId null`);
    }
  }

  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId !== null && !referenced.has(id)) {
      throw new DocumentInvariantError(
        `Parent ${shown(node.parentId)} must reference child ${shown(id)} exactly once`,
      );
    }
  }

  // Iterative depth-first walk, so a long parent chain cannot overflow the stack.
  const visited = new Set();
  const onPath = new Set();
  for (const rootId of document.rootIds) {
    if (visited.has(rootId)) continue;
    const stack = [[rootId, 0]];
    onPath.add(rootId);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = nodes[frame[0]].children;
      if (frame[1] < children.length) {
        const childId = children[frame[1]];
        frame[1] += 1;
        if (onPath.has(childId)) throw new DocumentInvariantError(`Cycle detected at node ${shown(childId)}`);
        if (visited.has(childId)) continue;
        if (stack.length >= DOCUMENT_LIMITS.maxTreeDepth) {
          throw new DocumentInvariantError(`document tree is deeper than ${DOCUMENT_LIMITS.maxTreeDepth} levels`);
        }
        onPath.add(childId);
        stack.push([childId, 0]);
      } else {
        stack.pop();
        onPath.delete(frame[0]);
        visited.add(frame[0]);
      }
    }
  }

  if (visited.size !== nodeTotal) {
    const unreachable = Object.keys(nodes).filter((id) => !visited.has(id));
    const listed = unreachable.slice(0, 10).map(shown).join(", ");
    const more = unreachable.length > 10 ? ` (and ${unreachable.length - 10} more)` : "";
    throw new DocumentInvariantError(`Unreachable nodes: ${listed}${more}`);
  }

  return true;
}
