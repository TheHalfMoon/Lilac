import { createHash } from "node:crypto";
import { types } from "node:util";
import { VisualGitValidationError } from "./errors.ts";
import {
  NODE_KINDS,
  VISUAL_GIT_HARD_LIMITS,
  VISUAL_GIT_SCHEMA_VERSION,
  type DesignNode,
  type DesignSnapshot,
  type NodeKind,
} from "./types.ts";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/u;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalVisualGitStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new VisualGitValidationError("visual-git value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalVisualGitStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalVisualGitStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
}

// Checked before any other operation on the value, so no proxy trap ever runs.
function assertNotProxy(value: unknown, label: string): void {
  if (value !== null && typeof value === "object" && types.isProxy(value)) {
    throw new VisualGitValidationError(`${label} must not be a proxy`);
  }
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assertNotProxy(value, label);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VisualGitValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new VisualGitValidationError(`${label} must not be a class instance`);
  }
  assertDataOnly(value, label);
}

// Fields are read more than once (validate, then copy). Proxies and accessors could
// answer differently per read, so only inert own data properties are accepted.
function assertDataOnly(value: object, label: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new VisualGitValidationError(`${label} must not have symbol keys`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new VisualGitValidationError(`${label} must not have accessor properties`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new VisualGitValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VisualGitValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new VisualGitValidationError(`${label} exceeds ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)) {
    throw new VisualGitValidationError(`${label} must not contain control characters`);
  }
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 128);
  if (Number.isNaN(Date.parse(value))) throw new VisualGitValidationError(`${label} must be an ISO-compatible timestamp`);
}

export function assertStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new VisualGitValidationError(`${label} must be a stable identifier`);
  }
}

export function assertCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new VisualGitValidationError(`${label} must be a full lowercase hexadecimal commit id`);
  }
}

export function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new VisualGitValidationError(`${label} must be a lowercase sha-256 hex digest`);
  }
}

export function assertBranch(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !BRANCH.test(value)) {
    throw new VisualGitValidationError(`${label} must be a bounded branch name`);
  }
  if (
    value.startsWith("/") || value.startsWith("-") || value.endsWith("/") || value.endsWith(".") ||
    value.endsWith(".lock") || value.includes("..") || value.includes("//") || value.includes("/.") ||
    value.startsWith(".")
  ) {
    throw new VisualGitValidationError(`${label} is not a valid branch name`);
  }
}

export function assertBoundedArray(value: unknown, label: string, max: number): asserts value is unknown[] {
  assertNotProxy(value, label);
  if (!Array.isArray(value)) throw new VisualGitValidationError(`${label} must be an array`);
  // A foreign prototype or own constructor would let map/iteration/species skip validation.
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new VisualGitValidationError(`${label} must be a plain array`);
  }
  if (value.length > max) throw new VisualGitValidationError(`${label} exceeds its bounded budget of ${max}`);
  assertDataOnly(value, label);
  // Exactly the dense indices plus length: no holes and no extra own keys.
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new VisualGitValidationError(`${label} must be a dense array`);
  }
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new VisualGitValidationError(`${label} must not have extra properties`);
  }
}

export function normalizeNode(value: unknown): DesignNode {
  assertPlainObject(value, "snapshot.node");
  assertAllowedKeys(value, ["id", "kind", "parentId", "name", "contentHash"], "snapshot.node");
  assertStableId(value.id, "snapshot.node.id");
  if (!NODE_KINDS.includes(value.kind as NodeKind)) {
    throw new VisualGitValidationError(`snapshot.node ${value.id} kind is unsupported`);
  }
  if (value.parentId !== null) assertStableId(value.parentId, "snapshot.node.parentId");
  assertBoundedString(value.name, "snapshot.node.name", VISUAL_GIT_HARD_LIMITS.maxNameLength);
  assertSha256(value.contentHash, "snapshot.node.contentHash");
  const kind = value.kind as NodeKind;
  if (kind === "page" && value.parentId !== null) {
    throw new VisualGitValidationError(`snapshot page ${value.id} must not have a parent`);
  }
  if (kind !== "page" && value.parentId === null) {
    throw new VisualGitValidationError(`snapshot ${kind} ${value.id} must have a parent`);
  }
  return {
    id: value.id as string,
    kind,
    parentId: value.parentId as string | null,
    name: value.name as string,
    contentHash: value.contentHash as string,
  };
}

function assertTree(nodes: Map<string, DesignNode>): void {
  const depth = new Map<string, number>();
  for (const node of nodes.values()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: DesignNode | undefined = node;
    while (cursor && !depth.has(cursor.id)) {
      if (onPath.has(cursor.id)) throw new VisualGitValidationError(`snapshot contains a parent cycle at ${cursor.id}`);
      onPath.add(cursor.id);
      path.push(cursor.id);
      if (cursor.parentId === null) break;
      const parent = nodes.get(cursor.parentId);
      if (!parent) throw new VisualGitValidationError(`snapshot node ${cursor.id} references missing parent ${cursor.parentId}`);
      if (parent.kind === "node" && cursor.kind !== "node") {
        throw new VisualGitValidationError(`snapshot ${cursor.kind} ${cursor.id} cannot be nested under node ${parent.id}`);
      }
      cursor = parent;
    }
    let base = cursor && depth.has(cursor.id) ? (depth.get(cursor.id) as number) : -1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      base += 1;
      if (base > VISUAL_GIT_HARD_LIMITS.maxDepth) {
        throw new VisualGitValidationError(`snapshot exceeds the maximum depth of ${VISUAL_GIT_HARD_LIMITS.maxDepth}`);
      }
      depth.set(path[index], base);
    }
  }
}

export function normalizeSnapshot(value: unknown): DesignSnapshot {
  assertPlainObject(value, "snapshot");
  assertAllowedKeys(value, ["schemaVersion", "snapshotId", "branch", "sourceCommit", "parentSnapshotId", "createdAt", "nodes"], "snapshot");
  if (value.schemaVersion !== VISUAL_GIT_SCHEMA_VERSION) {
    throw new VisualGitValidationError("snapshot.schemaVersion is unsupported");
  }
  assertStableId(value.snapshotId, "snapshot.snapshotId");
  assertBranch(value.branch, "snapshot.branch");
  assertCommit(value.sourceCommit, "snapshot.sourceCommit");
  if (value.parentSnapshotId !== null) {
    assertStableId(value.parentSnapshotId, "snapshot.parentSnapshotId");
    if (value.parentSnapshotId === value.snapshotId) {
      throw new VisualGitValidationError("snapshot cannot be its own parent");
    }
  }
  assertTimestamp(value.createdAt, "snapshot.createdAt");
  assertBoundedArray(value.nodes, "snapshot.nodes", VISUAL_GIT_HARD_LIMITS.maxNodes);
  const byId = new Map<string, DesignNode>();
  for (const entry of value.nodes) {
    const node = normalizeNode(entry);
    if (byId.has(node.id)) throw new VisualGitValidationError(`snapshot node id ${node.id} is not distinct`);
    byId.set(node.id, node);
  }
  assertTree(byId);
  // Ids are distinct here, so a two-way comparison is a total order.
  const nodes = [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
  return {
    schemaVersion: VISUAL_GIT_SCHEMA_VERSION,
    snapshotId: value.snapshotId as string,
    branch: value.branch as string,
    sourceCommit: value.sourceCommit as string,
    parentSnapshotId: value.parentSnapshotId as string | null,
    createdAt: value.createdAt as string,
    nodes,
  };
}

export function serializeSnapshot(snapshot: unknown): string {
  return canonicalVisualGitStringify(normalizeSnapshot(snapshot));
}

export function snapshotDigest(snapshot: unknown): string {
  return sha256Text(serializeSnapshot(snapshot));
}

export function nodeIndex(snapshot: DesignSnapshot): Map<string, DesignNode> {
  return new Map(snapshot.nodes.map((node) => [node.id, node]));
}
