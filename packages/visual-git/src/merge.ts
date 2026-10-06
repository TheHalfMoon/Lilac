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
