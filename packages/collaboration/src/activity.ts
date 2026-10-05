import { normalizeCollaborationLog } from "./durable.ts";
import { CollaborationValidationError } from "./errors.ts";
import { assertBoundedString, assertPlainObject } from "./validation.ts";
import type { ActivityRecord, CollaborationFact, CollaborationLog, TransactionSummary } from "./types.ts";

function transactionSummary(fact: CollaborationFact): TransactionSummary {
  assertPlainObject(fact.data, "transaction-committed.data");
  assertPlainObject(fact.data.summary, "transaction-committed.data.summary");
  const summary = fact.data.summary as unknown as TransactionSummary;
  assertBoundedString(summary.transactionId, "transactionSummary.transactionId");
  if (!Number.isSafeInteger(summary.historyRevision) || summary.historyRevision < 0) {
    throw new CollaborationValidationError("transactionSummary.historyRevision must be non-negative");
  }
  if (!Array.isArray(summary.affectedNodeIds) || !Array.isArray(summary.sourceBindings)) {
    throw new CollaborationValidationError("transaction summary collections are malformed");
  }
  return structuredClone(summary);
}

export function replayTransactionSummaries(logInput: CollaborationLog): TransactionSummary[] {
  const log = normalizeCollaborationLog(logInput);
  return log.facts
    .filter((fact) => fact.kind === "transaction-committed")
    .map(transactionSummary);
}

export function deriveActivity(logInput: CollaborationLog): ActivityRecord[] {
  const log = normalizeCollaborationLog(logInput);
  return log.facts.map((fact) => {
    const base = {
      id: `activity:${fact.id}`,
      sequence: fact.sequence,
      documentId: fact.documentId,
      actor: structuredClone(fact.actor),
      at: fact.at,
      detail: structuredClone(fact.data),
    };
    if (fact.kind === "transaction-committed") {
      const summary = transactionSummary(fact);
      return {
        ...base,
        kind: "document-transaction" as const,
        transactionId: summary.transactionId,
        ...(summary.operationId === undefined ? {} : { operationId: summary.operationId }),
      };
    }
    if (fact.kind === "comment-created" || fact.kind === "comment-replied" || fact.kind === "comment-resolved") {
      assertPlainObject(fact.data, `${fact.kind}.data`);
      const commentId = fact.kind === "comment-resolved"
        ? fact.data.commentId
        : (fact.data.comment as Record<string, unknown> | undefined)?.id;
      if (typeof commentId !== "string") throw new CollaborationValidationError("comment activity is missing comment id");
      return { ...base, kind: "comment" as const, commentId };
    }
    if (fact.kind === "access-changed") return { ...base, kind: "access" as const };
    if (fact.kind === "agent-work-linked") {
      assertPlainObject(fact.data, "agent-work-linked.data");
      const operationId = fact.data.operationId;
      if (typeof operationId !== "string") throw new CollaborationValidationError("agent work activity is missing operationId");
      return { ...base, kind: "agent-work" as const, operationId };
    }
    if (fact.kind === "reconnect-recovered") return { ...base, kind: "reconnect" as const };
    throw new CollaborationValidationError(`unsupported activity fact kind ${fact.kind}`);
  });
}
