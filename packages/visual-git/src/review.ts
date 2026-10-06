import { VisualGitConflictError, VisualGitValidationError } from "./errors.ts";
import {
  VISUAL_GIT_HARD_LIMITS,
  type DesignCodeLink,
  type DesignSnapshot,
  type ReviewComment,
  type SourceRange,
} from "./types.ts";
import {
  assertAllowedKeys,
  assertBoundedArray,
  assertBoundedString,
  assertCommit,
  assertPlainObject,
  assertStableId,
  assertTimestamp,
  nodeIndex,
  normalizeSnapshot,
} from "./validation.ts";

const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;

function assertAnchor(snapshot: DesignSnapshot, ids: Set<string>, anchorId: string, label: string): void {
  if (!ids.has(anchorId)) {
    throw new VisualGitValidationError(`${label} ${anchorId} does not exist in snapshot ${snapshot.snapshotId}`);
  }
}

export function assertRepoRelativePath(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, VISUAL_GIT_HARD_LIMITS.maxPathLength);
  const segments = value.split("/");
  for (const segment of segments) {
    if (
      segment === "" || segment === "." || segment === ".." || segment.startsWith("-") ||
      segment.toLowerCase() === ".git" || !PATH_SEGMENT.test(segment)
    ) {
      throw new VisualGitValidationError(`${label} must be a normalized repository-relative path`);
    }
  }
}

function normalizeRange(value: unknown): SourceRange | null {
  if (value === null) return null;
  assertPlainObject(value, "link.range");
  assertAllowedKeys(value, ["startLine", "endLine"], "link.range");
  const { startLine, endLine } = value;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || (startLine as number) < 1 || (endLine as number) < (startLine as number)) {
    throw new VisualGitValidationError("link.range must be a positive ordered line range");
  }
  return { startLine: startLine as number, endLine: endLine as number };
}

function nodeIds(snapshot: DesignSnapshot): Set<string> {
  return new Set(nodeIndex(snapshot).keys());
}

export function anchorComment(snapshotInput: unknown, input: unknown): ReviewComment {
  const snapshot = normalizeSnapshot(snapshotInput);
  return anchorCommentIn(snapshot, nodeIds(snapshot), input);
}

function anchorCommentIn(snapshot: DesignSnapshot, ids: Set<string>, input: unknown): ReviewComment {
  assertPlainObject(input, "comment");
  assertAllowedKeys(input, ["commentId", "snapshotId", "anchorId", "authorId", "body", "createdAt", "resolved"], "comment");
  assertStableId(input.commentId, "comment.commentId");
  if (input.snapshotId !== snapshot.snapshotId) {
    throw new VisualGitValidationError("comment.snapshotId must match the snapshot it anchors to");
  }
  assertStableId(input.anchorId, "comment.anchorId");
  assertAnchor(snapshot, ids, input.anchorId, "comment anchor");
  assertBoundedString(input.authorId, "comment.authorId", 256);
  assertBoundedString(input.body, "comment.body", VISUAL_GIT_HARD_LIMITS.maxCommentLength);
  assertTimestamp(input.createdAt, "comment.createdAt");
  if (typeof input.resolved !== "boolean") throw new VisualGitValidationError("comment.resolved must be a boolean");
  return {
    commentId: input.commentId,
    snapshotId: snapshot.snapshotId,
    anchorId: input.anchorId,
    authorId: input.authorId,
    body: input.body,
    createdAt: input.createdAt,
    resolved: input.resolved,
  };
}

export function anchorComments(snapshotInput: unknown, inputs: unknown): ReviewComment[] {
  assertBoundedArray(inputs, "comments", VISUAL_GIT_HARD_LIMITS.maxComments);
  const snapshot = normalizeSnapshot(snapshotInput);
  const ids = nodeIds(snapshot);
  const seen = new Set<string>();
  return inputs.map((input) => {
    const comment = anchorCommentIn(snapshot, ids, input);
    if (seen.has(comment.commentId)) throw new VisualGitConflictError(`comment ${comment.commentId} is duplicated`);
    seen.add(comment.commentId);
    return comment;
  });
}

export function linkDesignToCode(snapshotInput: unknown, input: unknown): DesignCodeLink {
  const snapshot = normalizeSnapshot(snapshotInput);
  return linkDesignToCodeIn(snapshot, nodeIds(snapshot), input);
}

function linkDesignToCodeIn(snapshot: DesignSnapshot, ids: Set<string>, input: unknown): DesignCodeLink {
  assertPlainObject(input, "link");
  assertAllowedKeys(input, ["linkId", "snapshotId", "nodeId", "file", "symbol", "sourceCommit", "range"], "link");
  assertStableId(input.linkId, "link.linkId");
  if (input.snapshotId !== snapshot.snapshotId) {
    throw new VisualGitValidationError("link.snapshotId must match the snapshot it binds");
  }
  assertStableId(input.nodeId, "link.nodeId");
  assertAnchor(snapshot, ids, input.nodeId, "link node");
  assertRepoRelativePath(input.file, "link.file");
  assertBoundedString(input.symbol, "link.symbol", VISUAL_GIT_HARD_LIMITS.maxSymbolLength);
  if (!SYMBOL.test(input.symbol)) throw new VisualGitValidationError("link.symbol must be a dotted code identifier");
  assertCommit(input.sourceCommit, "link.sourceCommit");
  return {
    linkId: input.linkId,
    snapshotId: snapshot.snapshotId,
    nodeId: input.nodeId,
    file: input.file,
    symbol: input.symbol,
    sourceCommit: input.sourceCommit,
    range: normalizeRange(input.range ?? null),
  };
}

export function linkDesignToCodeAll(snapshotInput: unknown, inputs: unknown): DesignCodeLink[] {
  assertBoundedArray(inputs, "links", VISUAL_GIT_HARD_LIMITS.maxLinks);
  const snapshot = normalizeSnapshot(snapshotInput);
  const ids = nodeIds(snapshot);
  const seen = new Set<string>();
  return inputs.map((input) => {
    const link = linkDesignToCodeIn(snapshot, ids, input);
    if (seen.has(link.linkId)) throw new VisualGitConflictError(`link ${link.linkId} is duplicated`);
    seen.add(link.linkId);
    return link;
  });
}
