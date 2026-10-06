import { VisualGitValidationError } from "./errors.ts";
import { CHANGED_FIELDS, type ChangedField, type DesignNode, type SnapshotDiff } from "./types.ts";
import { nodeIndex, normalizeSnapshot } from "./validation.ts";

export function changedFields(before: DesignNode, after: DesignNode): ChangedField[] {
  return CHANGED_FIELDS.filter((field) => before[field] !== after[field]);
}

export function diffSnapshots(baseInput: unknown, headInput: unknown): SnapshotDiff {
  const base = normalizeSnapshot(baseInput);
  const head = normalizeSnapshot(headInput);
  if (base.snapshotId === head.snapshotId) {
    throw new VisualGitValidationError("diff requires two distinct snapshots");
  }
  const before = nodeIndex(base);
  const after = nodeIndex(head);
  const diff: SnapshotDiff = {
    baseSnapshotId: base.snapshotId,
    headSnapshotId: head.snapshotId,
    added: [],
    removed: [],
    changed: [],
    moved: [],
    summary: { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 },
  };
  for (const node of base.nodes) {
    if (!after.has(node.id)) diff.removed.push(node);
  }
  for (const node of head.nodes) {
    const previous = before.get(node.id);
    if (!previous) {
      diff.added.push(node);
      continue;
    }
    const fields = changedFields(previous, node);
    if (fields.length > 0) diff.changed.push({ id: node.id, fields, before: previous, after: node });
    if (previous.parentId !== node.parentId) {
      diff.moved.push({ id: node.id, fromParentId: previous.parentId, toParentId: node.parentId });
    }
    if (fields.length === 0 && previous.parentId === node.parentId) diff.summary.unchanged += 1;
  }
  diff.summary.added = diff.added.length;
  diff.summary.removed = diff.removed.length;
  diff.summary.changed = diff.changed.length;
  diff.summary.moved = diff.moved.length;
  return diff;
}
