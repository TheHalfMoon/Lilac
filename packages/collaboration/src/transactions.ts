import { commitTransaction } from "@ninerr/history";
import { appendCollaborationFact, normalizeCollaborationLog } from "./durable.ts";
import { CollaborationConflictError, CollaborationValidationError } from "./errors.ts";
import { assertBoundedString, assertPlainObject, assertTimestamp, durableActor, normalizeActor, normalizeAnchor } from "./validation.ts";
import type { CollaboratorActor, CollaborationLog, SourceRangeBinding, TransactionSummary } from "./types.ts";

function normalizeSourceBindings(documentId: string, values: SourceRangeBinding[] = []): SourceRangeBinding[] {
  if (!Array.isArray(values)) throw new CollaborationValidationError("sourceBindings must be an array");
  return values.map((source) => normalizeAnchor({ documentId, source }, documentId).source!);
}

export function commitCollaborativeTransaction(
  history: any,
  logInput: CollaborationLog,
  input: {
    actor: CollaboratorActor;
    transaction: Record<string, unknown> & { id: string; actor?: string; metadata?: Record<string, unknown> };
    at: string;
    operationId?: string;
    workerTaskId?: string;
    sourceBindings?: SourceRangeBinding[];
  },
): { history: any; log: CollaborationLog; summary: TransactionSummary } {
  const log = normalizeCollaborationLog(logInput);
  const actor = normalizeActor(input.actor);
  assertTimestamp(input.at, "transaction.at");
  assertPlainObject(input.transaction, "transaction");
  assertBoundedString(input.transaction.id, "transaction.id");
  if (history?.document?.id !== log.documentId) throw new CollaborationConflictError("history document does not match collaboration document");
  if (input.transaction.actor !== undefined && input.transaction.actor !== actor.actorId) {
    throw new CollaborationValidationError("transaction actor cannot differ from collaboration actor");
  }
  if (input.operationId !== undefined) assertBoundedString(input.operationId, "transaction.operationId");
  if (input.workerTaskId !== undefined) assertBoundedString(input.workerTaskId, "transaction.workerTaskId");
  const sourceBindings = normalizeSourceBindings(log.documentId, input.sourceBindings);
  const metadata = input.transaction.metadata ?? {};
  assertPlainObject(metadata, "transaction.metadata");
  const correlation = {
    documentId: log.documentId,
    actorKind: actor.kind,
    ...(actor.ownerActorId === undefined ? {} : { ownerActorId: actor.ownerActorId }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.workerTaskId === undefined ? {} : { workerTaskId: input.workerTaskId }),
  };
  const transaction = {
    ...input.transaction,
    actor: actor.actorId,
    timestamp: input.at,
    metadata: { ...metadata, collaboration: correlation },
  };
  const nextHistory = commitTransaction(history, transaction);
  const entry = nextHistory.past.at(-1);
  if (!entry || entry.transaction.id !== input.transaction.id) {
    throw new CollaborationConflictError("history did not publish the expected transaction");
  }
  const summary: TransactionSummary = {
    transactionId: entry.transaction.id,
    historyRevision: nextHistory.document.revision,
    ...(entry.transaction.intent === null || entry.transaction.intent === undefined ? {} : { intent: entry.transaction.intent }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.workerTaskId === undefined ? {} : { workerTaskId: input.workerTaskId }),
    affectedNodeIds: [...entry.affectedNodeIds].sort(),
    sourceBindings,
  };
  const nextLog = appendCollaborationFact(log, {
    id: `transaction:${summary.transactionId}:committed`,
    kind: "transaction-committed",
    actor: durableActor(actor),
    at: input.at,
    data: { summary },
  });
  return { history: nextHistory, log: nextLog, summary };
}
