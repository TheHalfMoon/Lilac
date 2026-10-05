import { canonicalStringify } from "@lilac/agent-runtime";
import { appendCollaborationFact, normalizeCollaborationLog } from "./durable.ts";
import { CollaborationCommentError, CollaborationValidationError } from "./errors.ts";
import { assertAllowedKeys, assertBoundedString, assertPlainObject, assertTimestamp, durableActor, normalizeActor, normalizeAnchor, normalizeCommentText } from "./validation.ts";
import {
  COLLABORATION_SCHEMA_VERSION,
  DEFAULT_COMMENT_PAGE_SIZE,
  MAX_COMMENT_PAGE_SIZE,
  MAX_DISPLAY_NAME_LENGTH,
  type CollaboratorActor,
  type CollaborationFact,
  type CollaborationLog,
  type CommentAnchor,
  type CommentRecord,
  type DurableActorIdentity,
} from "./types.ts";

function normalizeStoredActor(value: DurableActorIdentity, label: string): DurableActorIdentity {
  assertPlainObject(value, label);
  assertAllowedKeys(value, label, ["actorId", "kind", "accessClass", "displayName", "ownerActorId"]);
  assertBoundedString(value.actorId, `${label}.actorId`);
  if (value.kind !== "user" && value.kind !== "agent") throw new CollaborationValidationError(`${label}.kind is unsupported`);
  if (value.accessClass !== "member" && value.accessClass !== "guest" && value.accessClass !== "service") throw new CollaborationValidationError(`${label}.accessClass is unsupported`);
  assertBoundedString(value.displayName, `${label}.displayName`, MAX_DISPLAY_NAME_LENGTH);
  if (value.ownerActorId !== undefined) assertBoundedString(value.ownerActorId, `${label}.ownerActorId`);
  if (value.kind === "user" && value.ownerActorId !== undefined) throw new CollaborationValidationError(`${label} user cannot declare ownerActorId`);
  return structuredClone(value);
}

function normalizeComment(value: CommentRecord, documentId: string): CommentRecord {
  assertPlainObject(value, "comment");
  assertAllowedKeys(value, "comment", ["version", "id", "documentId", "rootId", "parentId", "anchor", "author", "text", "at", "resolvedAt", "resolvedBy"]);
  if (value.version !== COLLABORATION_SCHEMA_VERSION) throw new CollaborationValidationError("comment version is unsupported");
  assertBoundedString(value.id, "comment.id");
  assertBoundedString(value.documentId, "comment.documentId");
  if (value.documentId !== documentId) throw new CollaborationValidationError("comment belongs to another document");
  assertBoundedString(value.rootId, "comment.rootId");
  if (value.parentId !== undefined) assertBoundedString(value.parentId, "comment.parentId");
  const anchor = normalizeAnchor(value.anchor, documentId);
  const author = normalizeStoredActor(value.author, "comment.author");
  const text = normalizeCommentText(value.text);
  assertTimestamp(value.at, "comment.at");
  if (value.resolvedAt !== undefined) assertTimestamp(value.resolvedAt, "comment.resolvedAt");
  const resolvedBy = value.resolvedBy === undefined ? undefined : normalizeStoredActor(value.resolvedBy, "comment.resolvedBy");
  if ((value.resolvedAt === undefined) !== (resolvedBy === undefined)) {
    throw new CollaborationValidationError("comment resolution requires both resolvedAt and resolvedBy");
  }
  return { ...structuredClone(value), anchor, author, text, ...(resolvedBy === undefined ? {} : { resolvedBy }) };
}

function commentFromFact(fact: CollaborationFact): CommentRecord {
  assertPlainObject(fact.data, `${fact.kind}.data`);
  assertAllowedKeys(fact.data, `${fact.kind}.data`, ["comment"]);
  const comment = normalizeComment(fact.data.comment as CommentRecord, fact.documentId);
  if (comment.author.actorId !== fact.actor.actorId || comment.at !== fact.at) {
    throw new CollaborationValidationError("comment fact attribution does not match embedded comment");
  }
  return comment;
}

function resolutionFromFact(fact: CollaborationFact): { commentId: string; resolvedAt: string; resolvedBy: DurableActorIdentity } {
  assertPlainObject(fact.data, "comment-resolved.data");
  assertAllowedKeys(fact.data, "comment-resolved.data", ["commentId", "resolvedAt", "resolvedBy"]);
  assertBoundedString(fact.data.commentId, "comment-resolved.data.commentId");
  assertTimestamp(fact.data.resolvedAt, "comment-resolved.data.resolvedAt");
  const resolvedBy = normalizeStoredActor(fact.data.resolvedBy as DurableActorIdentity, "comment-resolved.data.resolvedBy");
  if (resolvedBy.actorId !== fact.actor.actorId || fact.at !== fact.data.resolvedAt) {
    throw new CollaborationValidationError("comment resolution attribution does not match fact actor/time");
  }
  return { commentId: fact.data.commentId, resolvedAt: fact.data.resolvedAt, resolvedBy };
}

export function replayComments(logInput: CollaborationLog): CommentRecord[] {
  const log = normalizeCollaborationLog(logInput);
  const comments: CommentRecord[] = [];
  const byId = new Map<string, CommentRecord>();
  for (const fact of log.facts) {
    if (fact.kind === "comment-created" || fact.kind === "comment-replied") {
      const comment = commentFromFact(fact);
      if (byId.has(comment.id)) throw new CollaborationCommentError(`duplicate comment id ${comment.id}`);
      if (fact.kind === "comment-created") {
        if (comment.rootId !== comment.id || comment.parentId !== undefined) {
          throw new CollaborationCommentError("root comment must root to itself without parentId");
        }
      } else {
        const root = byId.get(comment.rootId);
        if (!root || root.rootId !== root.id) throw new CollaborationCommentError("reply root does not exist");
        if (comment.parentId !== root.id) throw new CollaborationCommentError("replies must be one level deep under root");
        if (canonicalStringify(comment.anchor) !== canonicalStringify(root.anchor)) {
          throw new CollaborationCommentError("reply anchor must equal root anchor");
        }
        if (root.resolvedAt !== undefined) throw new CollaborationCommentError("resolved root cannot accept replies");
      }
      comments.push(comment);
      byId.set(comment.id, comment);
      continue;
    }
    if (fact.kind === "comment-resolved") {
      const resolution = resolutionFromFact(fact);
      const target = byId.get(resolution.commentId);
      if (!target) throw new CollaborationCommentError("cannot resolve unknown comment");
      const targets = target.rootId === target.id
        ? comments.filter((comment) => comment.rootId === target.id)
        : [target];
      for (const comment of targets) {
        if (comment.resolvedAt !== undefined) continue;
        comment.resolvedAt = resolution.resolvedAt;
        comment.resolvedBy = structuredClone(resolution.resolvedBy);
      }
    }
  }
  return comments.map((comment) => structuredClone(comment));
}

export function getComment(log: CollaborationLog, commentId: string): CommentRecord | null {
  assertBoundedString(commentId, "commentId");
  return replayComments(log).find((comment) => comment.id === commentId) ?? null;
}

export interface CommentPage {
  items: CommentRecord[];
  nextCursor: number | null;
}

export function paginateCommentThread(
  log: CollaborationLog,
  commentId: string,
  { cursor = 0, limit = DEFAULT_COMMENT_PAGE_SIZE }: { cursor?: number; limit?: number } = {},
): CommentPage {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new CollaborationValidationError("comment cursor must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_COMMENT_PAGE_SIZE) throw new CollaborationValidationError(`comment page limit must be between 1 and ${MAX_COMMENT_PAGE_SIZE}`);
  const comment = getComment(log, commentId);
  if (!comment) return { items: [], nextCursor: null };
  const thread = replayComments(log).filter((candidate) => candidate.rootId === comment.rootId);
  const items = thread.slice(cursor, cursor + limit);
  const next = cursor + items.length;
  return { items, nextCursor: next < thread.length ? next : null };
}

export function getCommentThread(log: CollaborationLog, commentId: string): CommentRecord[] {
  return paginateCommentThread(log, commentId, { limit: MAX_COMMENT_PAGE_SIZE }).items;
}

export function createRootComment(
  logInput: CollaborationLog,
  input: {
    id: string;
    actor: CollaboratorActor;
    anchor: CommentAnchor;
    text: string;
    at: string;
    nodeExists?: (nodeId: string) => boolean;
  },
): { log: CollaborationLog; comment: CommentRecord } {
  const log = normalizeCollaborationLog(logInput);
  assertBoundedString(input.id, "comment.id");
  const actor = normalizeActor(input.actor);
  const anchor = normalizeAnchor(input.anchor, log.documentId);
  if (anchor.nodeId !== undefined) {
    if (!input.nodeExists || !input.nodeExists(anchor.nodeId)) {
      throw new CollaborationCommentError("comment node anchor is not proven to belong to this document");
    }
  }
  const comment: CommentRecord = {
    version: COLLABORATION_SCHEMA_VERSION,
    id: input.id,
    documentId: log.documentId,
    rootId: input.id,
    anchor,
    author: durableActor(actor),
    text: normalizeCommentText(input.text),
    at: input.at,
  };
  assertTimestamp(comment.at, "comment.at");
  const nextLog = appendCollaborationFact(log, {
    id: `comment:${comment.id}:created`,
    kind: "comment-created",
    actor: comment.author,
    at: comment.at,
    data: { comment },
  });
  return { log: nextLog, comment: structuredClone(comment) };
}

export function replyToComment(
  logInput: CollaborationLog,
  input: { id: string; parentId: string; actor: CollaboratorActor; text: string; at: string },
): { log: CollaborationLog; comment: CommentRecord } {
  const log = normalizeCollaborationLog(logInput);
  assertBoundedString(input.id, "reply.id");
  assertBoundedString(input.parentId, "reply.parentId");
  const actor = normalizeActor(input.actor);
  const parent = getComment(log, input.parentId);
  if (!parent) throw new CollaborationCommentError("reply parent does not exist");
  const root = getComment(log, parent.rootId);
  if (!root) throw new CollaborationCommentError("reply root does not exist");
  if (root.resolvedAt !== undefined) throw new CollaborationCommentError("resolved thread cannot accept replies");
  assertTimestamp(input.at, "reply.at");
  const comment: CommentRecord = {
    version: COLLABORATION_SCHEMA_VERSION,
    id: input.id,
    documentId: log.documentId,
    rootId: root.id,
    parentId: root.id,
    anchor: structuredClone(root.anchor),
    author: durableActor(actor),
    text: normalizeCommentText(input.text),
    at: input.at,
  };
  const nextLog = appendCollaborationFact(log, {
    id: `comment:${comment.id}:replied`,
    kind: "comment-replied",
    actor: comment.author,
    at: comment.at,
    data: { comment },
  });
  return { log: nextLog, comment: structuredClone(comment) };
}

export function resolveComment(
  logInput: CollaborationLog,
  input: { commentId: string; actor: CollaboratorActor; at: string },
): { log: CollaborationLog; resolved: CommentRecord[] } {
  const log = normalizeCollaborationLog(logInput);
  const target = getComment(log, input.commentId);
  if (!target) throw new CollaborationCommentError("cannot resolve unknown comment");
  const actor = durableActor(normalizeActor(input.actor));
  assertTimestamp(input.at, "comment.resolve.at");
  if (target.resolvedAt !== undefined) return { log, resolved: getCommentThread(log, target.id).filter((comment) => comment.resolvedAt !== undefined) };
  const nextLog = appendCollaborationFact(log, {
    id: `comment:${target.id}:resolved`,
    kind: "comment-resolved",
    actor,
    at: input.at,
    data: { commentId: target.id, resolvedAt: input.at, resolvedBy: actor },
  });
  const resolved = replayComments(nextLog).filter((comment) => {
    if (target.rootId === target.id) return comment.rootId === target.id && comment.resolvedAt !== undefined;
    return comment.id === target.id && comment.resolvedAt !== undefined;
  });
  return { log: nextLog, resolved };
}
