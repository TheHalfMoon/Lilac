import { VisualGitValidationError } from "./errors.ts";
import {
  CHANGED_FIELDS,
  CONFLICT_KINDS,
  type ConflictKind,
  type ConflictReport,
  type DesignNode,
  type MergeConflict,
} from "./types.ts";
import { nodeIndex, normalizeSnapshot } from "./validation.ts";

const COMPARED_FIELDS = [...CHANGED_FIELDS, "parentId"] as const;

function sameNode(left: DesignNode | undefined, right: DesignNode | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return COMPARED_FIELDS.every((field) => left[field] === right[field]);
}

function bothChanged(base: DesignNode, ours: DesignNode, theirs: DesignNode, field: (typeof COMPARED_FIELDS)[number]): boolean {
  return ours[field] !== base[field] && theirs[field] !== base[field] && ours[field] !== theirs[field];
}

function nodeKinds(base: DesignNode | undefined, ours: DesignNode | undefined, theirs: DesignNode | undefined): ConflictKind[] {
  if (sameNode(base, ours) || sameNode(base, theirs) || sameNode(ours, theirs)) return [];
  if (base === undefined) return ["add-add"];
  if (ours === undefined || theirs === undefined) return ["delete-modify"];
  const kinds: ConflictKind[] = [];
  if (CHANGED_FIELDS.some((field) => bothChanged(base, ours, theirs, field))) kinds.push("content");
  if (bothChanged(base, ours, theirs, "parentId")) kinds.push("parent");
  return kinds;
}

function orphanedChildren(
  base: Map<string, DesignNode>,
  side: Map<string, DesignNode>,
  other: Map<string, DesignNode>,
): string[] {
  const orphaned: string[] = [];
  for (const node of side.values()) {
    if (node.parentId === null) continue;
    const previous = base.get(node.id);
    const placedHere = previous === undefined || previous.parentId !== node.parentId;
    if (placedHere && base.has(node.parentId) && !other.has(node.parentId)) orphaned.push(node.id);
  }
  return orphaned;
}

interface ProjectedNode {
  kind: DesignNode["kind"];
  parentId: string | null;
}

// Field-level projection of a clean merge for nodes without node-level conflicts:
// each field takes whichever side changed it from base.
function projectStructure(
  ids: Set<string>,
  base: Map<string, DesignNode>,
  ours: Map<string, DesignNode>,
  theirs: Map<string, DesignNode>,
  conflicted: Set<string>,
): Map<string, ProjectedNode> {
  const projected = new Map<string, ProjectedNode>();
  for (const id of ids) {
    if (conflicted.has(id)) continue;
    const before = base.get(id);
    const left = ours.get(id);
    const right = theirs.get(id);
    if (before === undefined) {
      const added = left ?? right;
      if (added) projected.set(id, { kind: added.kind, parentId: added.parentId });
      continue;
    }
    if (left === undefined || right === undefined) continue;
    projected.set(id, {
      kind: left.kind !== before.kind ? left.kind : right.kind,
      parentId: left.parentId !== before.parentId ? left.parentId : right.parentId,
    });
  }
  return projected;
}

// Structural invariants of the projected merge. Walks stop at conflicted nodes, whose
// merged shape is undecided, so these kinds only flag otherwise-clean nodes.
function structuralConflicts(
  projected: Map<string, ProjectedNode>,
  add: (id: string, kind: ConflictKind) => void,
): void {
  const settled = new Set<string>();
  for (const start of projected.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null && !settled.has(cursor) && projected.has(cursor)) {
      if (onPath.has(cursor)) {
        for (const id of path.slice(path.indexOf(cursor))) add(id, "cycle");
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      cursor = (projected.get(cursor) as ProjectedNode).parentId;
    }
    for (const id of path) settled.add(id);
  }
  for (const [id, node] of projected) {
    if ((node.kind === "page") !== (node.parentId === null)) {
      add(id, "invalid-nesting");
      continue;
    }
    const parent = node.parentId === null ? undefined : projected.get(node.parentId);
    if (parent?.kind === "node" && node.kind !== "node") add(id, "invalid-nesting");
  }
}

export function detectConflicts(baseInput: unknown, oursInput: unknown, theirsInput: unknown): ConflictReport {
  const base = normalizeSnapshot(baseInput);
  const ours = normalizeSnapshot(oursInput);
  const theirs = normalizeSnapshot(theirsInput);
  if (new Set([base.snapshotId, ours.snapshotId, theirs.snapshotId]).size !== 3) {
    throw new VisualGitValidationError("conflict detection requires three distinct snapshots");
  }
  const baseNodes = nodeIndex(base);
  const ourNodes = nodeIndex(ours);
  const theirNodes = nodeIndex(theirs);
  const kindsById = new Map<string, Set<ConflictKind>>();
  const add = (id: string, kind: ConflictKind): void => {
    const kinds = kindsById.get(id) ?? new Set<ConflictKind>();
    kinds.add(kind);
    kindsById.set(id, kinds);
  };
  const ids = new Set([...baseNodes.keys(), ...ourNodes.keys(), ...theirNodes.keys()]);
  for (const id of ids) {
    for (const kind of nodeKinds(baseNodes.get(id), ourNodes.get(id), theirNodes.get(id))) add(id, kind);
  }
  for (const id of orphanedChildren(baseNodes, ourNodes, theirNodes)) add(id, "orphaned-child");
  for (const id of orphanedChildren(baseNodes, theirNodes, ourNodes)) add(id, "orphaned-child");
  structuralConflicts(projectStructure(ids, baseNodes, ourNodes, theirNodes, new Set(kindsById.keys())), add);
  const conflicts: MergeConflict[] = [...kindsById.keys()].sort().map((id) => ({
    nodeId: id,
    kinds: CONFLICT_KINDS.filter((kind) => kindsById.get(id)?.has(kind)),
    base: baseNodes.get(id) ?? null,
    ours: ourNodes.get(id) ?? null,
    theirs: theirNodes.get(id) ?? null,
  }));
  return {
    baseSnapshotId: base.snapshotId,
    oursSnapshotId: ours.snapshotId,
    theirsSnapshotId: theirs.snapshotId,
    conflicts,
    mergeable: conflicts.length === 0,
  };
}
