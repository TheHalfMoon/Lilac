import { replayTransactionSummaries } from "./activity.ts";
import { appendCollaborationFact, normalizeCollaborationLog } from "./durable.ts";
import { getComment } from "./comments.ts";
import { CollaborationCommentError, CollaborationValidationError } from "./errors.ts";
import { assertBoundedString, assertTimestamp, durableActor, normalizeActor } from "./validation.ts";
import type { CollaboratorActor, CollaborationLog } from "./types.ts";

function normalizeIds(values: string[], label: string, allowEmpty = false): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new CollaborationValidationError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = values.map((value, index) => {
    assertBoundedString(value, `${label}[${index}]`);
    return value;
  });
  if (new Set(result).size !== result.length) throw new CollaborationValidationError(`${label} contains duplicates`);
  return result;
}

export interface AgentLinkProof {
  operationExists: (operationId: string) => boolean;
  eventExists: (eventId: string) => boolean;
  workerTaskExists?: (workerTaskId: string) => boolean;
}

export function linkAgentMention(
  logInput: CollaborationLog,
  input: {
    linkId: string;
    commentId: string;
    requester: CollaboratorActor;
    targetAgentId: string;
    operationId: string;
    eventIds: string[];
    transactionIds?: string[];
    workerTaskId?: string;
    at: string;
    proof: AgentLinkProof;
  },
): CollaborationLog {
  const log = normalizeCollaborationLog(logInput);
  const comment = getComment(log, input.commentId);
  if (!comment) throw new CollaborationCommentError("agent mention must reference an existing comment");
  if (comment.resolvedAt !== undefined) throw new CollaborationCommentError("resolved comment cannot start agent work");
  const requester = normalizeActor(input.requester);
  assertBoundedString(input.linkId, "agentLink.linkId");
  assertBoundedString(input.targetAgentId, "agentLink.targetAgentId");
  assertBoundedString(input.operationId, "agentLink.operationId");
  if (input.workerTaskId !== undefined) assertBoundedString(input.workerTaskId, "agentLink.workerTaskId");
  assertTimestamp(input.at, "agentLink.at");
  if (!input.proof || typeof input.proof.operationExists !== "function" || typeof input.proof.eventExists !== "function") {
    throw new CollaborationValidationError("agent link requires operation and event proof callbacks");
  }
  const eventIds = normalizeIds(input.eventIds, "agentLink.eventIds");
  const transactionIds = normalizeIds(input.transactionIds ?? [], "agentLink.transactionIds", true);
  if (!input.proof.operationExists(input.operationId)) {
    throw new CollaborationValidationError("agent link operation identity is not proven");
  }
  for (const eventId of eventIds) {
    if (!input.proof.eventExists(eventId)) throw new CollaborationValidationError(`agent link event ${eventId} is not proven`);
  }
  if (input.workerTaskId !== undefined) {
    if (typeof input.proof.workerTaskExists !== "function" || !input.proof.workerTaskExists(input.workerTaskId)) {
      throw new CollaborationValidationError("agent link worker task identity is not proven");
    }
  }
  const committedTransactions = new Set(replayTransactionSummaries(log).map((summary) => summary.transactionId));
  for (const transactionId of transactionIds) {
    if (!committedTransactions.has(transactionId)) {
      throw new CollaborationValidationError(`agent link transaction ${transactionId} is not committed in this document`);
    }
  }
  return appendCollaborationFact(log, {
    id: `agent-link:${input.linkId}`,
    kind: "agent-work-linked",
    actor: durableActor(requester),
    at: input.at,
    data: {
      commentId: comment.id,
      targetAgentId: input.targetAgentId,
      operationId: input.operationId,
      eventIds,
      transactionIds,
      ...(input.workerTaskId === undefined ? {} : { workerTaskId: input.workerTaskId }),
    },
  });
}
