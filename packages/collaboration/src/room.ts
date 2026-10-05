import { deriveActivity, replayTransactionSummaries } from "./activity.ts";
import { evaluateAccess, normalizeAccessPolicy, requireAccess, updateAccessPolicy } from "./access.ts";
import { linkAgentMention, type AgentLinkProof } from "./agent-link.ts";
import { createRootComment, getCommentThread, paginateCommentThread, replayComments, replyToComment, resolveComment } from "./comments.ts";
import { appendCollaborationFact, normalizePersistentState } from "./durable.ts";
import { CollaborationAuthorizationError, CollaborationProtocolError } from "./errors.ts";
import { applyPresenceUpdate, createPresence, type PresenceUpdate } from "./presence.ts";
import { commitCollaborativeTransaction } from "./transactions.ts";
import { assertBoundedString, assertTimestamp, durableActor, normalizeActor } from "./validation.ts";
import {
  MAX_EPHEMERAL_UPDATES_PER_WINDOW,
  EPHEMERAL_RATE_WINDOW_MS,
  MAX_ROOM_SESSIONS,
  type AccessGrant,
  type CollaboratorActor,
  type CollaborationCapability,
  type CollaborationPersistentState,
  type CollaborationTransport,
  type CommentAnchor,
  type PresenceSession,
  type SourceRangeBinding,
} from "./types.ts";

interface ActiveSession {
  presence: PresenceSession;
  linkGrantId?: string;
}

interface RateState {
  windowStart: number;
  count: number;
}

export interface RoomSnapshot {
  documentId: string;
  policyRevision: number;
  cursor: number;
  comments: ReturnType<typeof replayComments>;
  transactions: ReturnType<typeof replayTransactionSummaries>;
  activity: ReturnType<typeof deriveActivity>;
  presence: PresenceSession[];
}

export class LocalCollaborationRoom {
  #state: CollaborationPersistentState;
  #sessions = new Map<string, ActiveSession>();
  #generations = new Map<string, number>();
  #rate = new Map<string, RateState>();

  constructor(state: CollaborationPersistentState) {
    this.#state = normalizePersistentState(state);
  }

  exportState(): CollaborationPersistentState {
    return structuredClone(this.#state);
  }

  #snapshot(): RoomSnapshot {
    return {
      documentId: this.#state.documentId,
      policyRevision: this.#state.policy.policyRevision,
      cursor: this.#state.log.nextSequence - 1,
      comments: replayComments(this.#state.log),
      transactions: replayTransactionSummaries(this.#state.log),
      activity: deriveActivity(this.#state.log),
      presence: [...this.#sessions.values()].map((entry) => structuredClone(entry.presence)),
    };
  }

  authorize(input: {
    actor: CollaboratorActor;
    capability: CollaborationCapability;
    transport: CollaborationTransport;
    at: string;
    linkGrantId?: string;
  }) {
    return requireAccess(this.#state.policy, input);
  }

  join(input: { actor: CollaboratorActor; sessionId: string; at: string; linkGrantId?: string }): {
    presence: PresenceSession;
    snapshot: RoomSnapshot;
  } {
    const actor = normalizeActor(input.actor);
    assertBoundedString(input.sessionId, "room.sessionId");
    assertTimestamp(input.at, "room.join.at");
    requireAccess(this.#state.policy, { actor, capability: "read", transport: "realtime", at: input.at, linkGrantId: input.linkGrantId });
    requireAccess(this.#state.policy, { actor, capability: "presence", transport: "realtime", at: input.at, linkGrantId: input.linkGrantId });
    if (!this.#sessions.has(actor.actorId) && this.#sessions.size >= MAX_ROOM_SESSIONS) throw new CollaborationProtocolError(`room session limit ${MAX_ROOM_SESSIONS} reached`);
    const generation = (this.#generations.get(actor.actorId) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new CollaborationProtocolError("presence generation exhausted safe integer range");
    this.#generations.set(actor.actorId, generation);
    const presence = createPresence({ documentId: this.#state.documentId, actor, sessionId: input.sessionId, generation, at: input.at });
    this.#sessions.set(actor.actorId, { presence, ...(input.linkGrantId === undefined ? {} : { linkGrantId: input.linkGrantId }) });
    this.#rate.delete(actor.actorId);
    return { presence: structuredClone(presence), snapshot: this.#snapshot() };
  }

  publishPresence(input: {
    actorId: string;
    sessionId: string;
    generation: number;
    update: PresenceUpdate;
  }): PresenceSession {
    assertBoundedString(input.actorId, "room.actorId");
    assertBoundedString(input.sessionId, "room.sessionId");
    const active = this.#sessions.get(input.actorId);
    if (!active || active.presence.sessionId !== input.sessionId || active.presence.generation !== input.generation) {
      throw new CollaborationProtocolError("presence update belongs to a missing or superseded session");
    }
    const at = input.update.at;
    requireAccess(this.#state.policy, {
      actor: active.presence.actor,
      capability: "presence",
      transport: "realtime",
      at,
      linkGrantId: active.linkGrantId,
    });
    const atMs = Date.parse(at);
    const rate = this.#rate.get(input.actorId);
    if (!rate || atMs - rate.windowStart >= EPHEMERAL_RATE_WINDOW_MS) {
      this.#rate.set(input.actorId, { windowStart: atMs, count: 1 });
    } else {
      if (rate.count >= MAX_EPHEMERAL_UPDATES_PER_WINDOW) {
        throw new CollaborationProtocolError("ephemeral presence rate limit exceeded");
      }
      rate.count += 1;
    }
    const presence = applyPresenceUpdate(active.presence, input.update);
    active.presence = presence;
    return structuredClone(presence);
  }

  disconnect(input: { actorId: string; sessionId: string; generation: number }): boolean {
    const active = this.#sessions.get(input.actorId);
    if (!active || active.presence.sessionId !== input.sessionId || active.presence.generation !== input.generation) return false;
    this.#sessions.delete(input.actorId);
    this.#rate.delete(input.actorId);
    return true;
  }

  getPresence(actorId: string): PresenceSession | null {
    const active = this.#sessions.get(actorId);
    return active ? structuredClone(active.presence) : null;
  }

  #sweepRevokedSessions(at: string): void {
    for (const [actorId, active] of this.#sessions) {
      const request = { actor: active.presence.actor, transport: "realtime" as const, at, linkGrantId: active.linkGrantId };
      const read = evaluateAccess(this.#state.policy, { ...request, capability: "read" });
      const presence = evaluateAccess(this.#state.policy, { ...request, capability: "presence" });
      if (read.outcome !== "allowed" || presence.outcome !== "allowed") {
        this.#sessions.delete(actorId);
        this.#rate.delete(actorId);
      }
    }
  }

  updatePolicy(input: {
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    at: string;
    expectedRevision: number;
    grants?: AccessGrant[];
    deleted?: boolean;
    linkGrantId?: string;
  }) {
    const actor = normalizeActor(input.actor);
    requireAccess(this.#state.policy, { actor, capability: "admin", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    const policy = updateAccessPolicy(this.#state.policy, {
      expectedRevision: input.expectedRevision,
      ...(input.grants === undefined ? {} : { grants: input.grants }),
      ...(input.deleted === undefined ? {} : { deleted: input.deleted }),
    });
    const log = appendCollaborationFact(this.#state.log, {
      id: `access:${policy.policyRevision}`,
      kind: "access-changed",
      actor: durableActor(actor),
      at: input.at,
      data: {
        policyRevision: policy.policyRevision,
        deleted: policy.deleted,
        grantCount: policy.grants.length,
      },
    });
    this.#state = normalizePersistentState({ ...this.#state, policy, log });
    this.#sweepRevokedSessions(input.at);
    return structuredClone(policy);
  }

  readCommentThread(input: {
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    commentId: string;
    at: string;
    linkGrantId?: string;
  }) {
    this.authorize({ actor: input.actor, capability: "read", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    return getCommentThread(this.#state.log, input.commentId);
  }

  readCommentPage(input: {
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    commentId: string;
    at: string;
    cursor?: number;
    limit?: number;
    linkGrantId?: string;
  }) {
    this.authorize({ actor: input.actor, capability: "read", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    return paginateCommentThread(this.#state.log, input.commentId, { cursor: input.cursor, limit: input.limit });
  }

  createComment(input: {
    id: string;
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    anchor: CommentAnchor;
    text: string;
    at: string;
    nodeExists?: (nodeId: string) => boolean;
    linkGrantId?: string;
  }) {
    this.authorize({ actor: input.actor, capability: "comments", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    const result = createRootComment(this.#state.log, input);
    this.#state = { ...this.#state, log: result.log };
    return result.comment;
  }

  replyComment(input: {
    id: string;
    parentId: string;
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    text: string;
    at: string;
    linkGrantId?: string;
  }) {
    this.authorize({ actor: input.actor, capability: "comments", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    const result = replyToComment(this.#state.log, input);
    this.#state = { ...this.#state, log: result.log };
    return result.comment;
  }

  resolveComment(input: {
    commentId: string;
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    at: string;
    linkGrantId?: string;
  }) {
    this.authorize({ actor: input.actor, capability: "comments", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    const result = resolveComment(this.#state.log, input);
    this.#state = { ...this.#state, log: result.log };
    return result.resolved;
  }

  commitTransaction(input: {
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    history: any;
    transaction: Record<string, unknown> & { id: string; actor?: string; metadata?: Record<string, unknown> };
    at: string;
    operationId?: string;
    workerTaskId?: string;
    sourceBindings?: SourceRangeBinding[];
    linkGrantId?: string;
  }) {
    this.authorize({ actor: input.actor, capability: "document-write", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    const result = commitCollaborativeTransaction(input.history, this.#state.log, input);
    this.#state = { ...this.#state, log: result.log };
    return { history: result.history, summary: result.summary };
  }

  linkAgentWork(input: {
    linkId: string;
    commentId: string;
    requester: CollaboratorActor;
    transport: CollaborationTransport;
    targetAgentId: string;
    operationId: string;
    eventIds: string[];
    transactionIds?: string[];
    workerTaskId?: string;
    at: string;
    linkGrantId?: string;
    proof: AgentLinkProof;
  }): void {
    this.authorize({ actor: input.requester, capability: "comments", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    this.#state = { ...this.#state, log: linkAgentMention(this.#state.log, input) };
  }


  readSnapshot(input: {
    actor: CollaboratorActor;
    transport: CollaborationTransport;
    at: string;
    linkGrantId?: string;
  }): RoomSnapshot {
    this.authorize({ actor: input.actor, capability: "read", transport: input.transport, at: input.at, linkGrantId: input.linkGrantId });
    return this.#snapshot();
  }

  reconnect(input: {
    actor: CollaboratorActor;
    sessionId: string;
    at: string;
    previousCursor: number;
    linkGrantId?: string;
  }): { presence: PresenceSession; snapshot: RoomSnapshot } {
    if (!Number.isSafeInteger(input.previousCursor) || input.previousCursor < 0 || input.previousCursor > this.#state.log.nextSequence - 1) {
      throw new CollaborationProtocolError("reconnect cursor is invalid");
    }
    const joined = this.join(input);
    try {
      const actor = normalizeActor(input.actor);
      const log = appendCollaborationFact(this.#state.log, {
        id: `reconnect:${actor.actorId}:${joined.presence.generation}:${input.previousCursor}`,
        kind: "reconnect-recovered",
        actor: durableActor(actor),
        at: input.at,
        data: { previousCursor: input.previousCursor, recoveredCursor: this.#state.log.nextSequence - 1 },
      });
      this.#state = { ...this.#state, log };
      return { presence: joined.presence, snapshot: this.#snapshot() };
    } catch (error) {
      this.disconnect({ actorId: joined.presence.actor.actorId, sessionId: joined.presence.sessionId, generation: joined.presence.generation });
      throw error;
    }
  }
}
