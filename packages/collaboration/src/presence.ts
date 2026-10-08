import { canonicalStringify } from "@ninerr/agent-runtime";
import { CollaborationProtocolError } from "./errors.ts";
import { assertAllowedKeys, assertBoundedString, assertPlainObject, assertTimestamp, normalizeActor, normalizeEditing, normalizePoint, normalizeStatus, normalizeViewport } from "./validation.ts";
import { COLLABORATION_SCHEMA_VERSION, MAX_EPHEMERAL_MESSAGE_BYTES, type CollaborationViewport, type PresenceSession } from "./types.ts";

export interface PresenceUpdate {
  sequence: number;
  at: string;
  cursor?: PresenceSession["cursor"] | null;
  viewport?: PresenceSession["viewport"] | null;
  activeNodeId?: string | null;
  editing?: PresenceSession["editing"];
  status?: string | null;
  operationId?: string | null;
  workerTaskId?: string | null;
}

function assertEphemeralSize(value: unknown): void {
  const encoded = canonicalStringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_EPHEMERAL_MESSAGE_BYTES) {
    throw new CollaborationProtocolError(`ephemeral message exceeds ${MAX_EPHEMERAL_MESSAGE_BYTES} bytes`);
  }
}

export function createPresence(input: {
  documentId: string;
  actor: PresenceSession["actor"];
  sessionId: string;
  generation: number;
  at: string;
}): PresenceSession {
  assertBoundedString(input.documentId, "presence.documentId");
  const actor = normalizeActor(input.actor);
  assertBoundedString(input.sessionId, "presence.sessionId");
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) throw new CollaborationProtocolError("presence generation must be a positive safe integer");
  assertTimestamp(input.at, "presence.at");
  return { version: COLLABORATION_SCHEMA_VERSION, documentId: input.documentId, actor, sessionId: input.sessionId, generation: input.generation, sequence: 0, editing: [], updatedAt: input.at };
}

export function applyPresenceUpdate(current: PresenceSession, update: PresenceUpdate): PresenceSession {
  assertPlainObject(update, "presence.update");
  assertAllowedKeys(update, "presence.update", ["sequence", "at", "cursor", "viewport", "activeNodeId", "editing", "status", "operationId", "workerTaskId"]);
  if (!Number.isSafeInteger(update.sequence) || update.sequence <= current.sequence) {
    throw new CollaborationProtocolError(`presence sequence ${String(update.sequence)} must exceed ${current.sequence}`);
  }
  assertTimestamp(update.at, "presence.updatedAt");
  if (Date.parse(update.at) < Date.parse(current.updatedAt)) throw new CollaborationProtocolError("presence timestamp moves backwards");
  const actor = { ...current.actor };
  if (update.operationId !== undefined) {
    if (update.operationId === null) delete actor.operationId;
    else { assertBoundedString(update.operationId, "presence.operationId"); actor.operationId = update.operationId; }
  }
  if (update.workerTaskId !== undefined) {
    if (update.workerTaskId === null) delete actor.workerTaskId;
    else { assertBoundedString(update.workerTaskId, "presence.workerTaskId"); actor.workerTaskId = update.workerTaskId; }
  }
  const next: PresenceSession = {
    ...structuredClone(current),
    actor,
    sequence: update.sequence,
    updatedAt: update.at,
  };
  if (update.cursor !== undefined) update.cursor === null ? delete next.cursor : next.cursor = normalizePoint(update.cursor);
  if (update.viewport !== undefined) update.viewport === null ? delete next.viewport : next.viewport = normalizeViewport(update.viewport);
  if (update.activeNodeId !== undefined) {
    if (update.activeNodeId === null) delete next.activeNodeId;
    else { assertBoundedString(update.activeNodeId, "presence.activeNodeId"); next.activeNodeId = update.activeNodeId; }
  }
  if (update.editing !== undefined) next.editing = normalizeEditing(update.editing);
  if (update.status !== undefined) update.status === null ? delete next.status : next.status = normalizeStatus(update.status);
  assertEphemeralSize(next);
  return next;
}

export function followViewport(remote: PresenceSession): CollaborationViewport | null {
  return remote.viewport === undefined ? null : normalizeViewport(remote.viewport);
}

export function locateAgent(remote: PresenceSession): { nodeId?: string; operationId?: string; workerTaskId?: string } | null {
  if (remote.actor.kind !== "agent") return null;
  const location = {
    ...(remote.activeNodeId === undefined ? {} : { nodeId: remote.activeNodeId }),
    ...(remote.actor.operationId === undefined ? {} : { operationId: remote.actor.operationId }),
    ...(remote.actor.workerTaskId === undefined ? {} : { workerTaskId: remote.actor.workerTaskId }),
  };
  return Object.keys(location).length === 0 ? null : location;
}
