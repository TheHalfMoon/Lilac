import { commitTransaction, createTransaction } from "@lilac/history";
import { AgentRuntimeError } from "./errors.ts";
import { assertNonEmptyString, assertPlainObject, cloneJson } from "./json.ts";
import type { OperationEnvelope } from "./operation.ts";
import {
  bindOperationTransaction,
  getOperation,
  validateSession,
  type AgentSession,
} from "./session.ts";

export interface HistoryLike {
  document: unknown;
  past: Array<{
    transaction: { id: string };
    affectedNodeIds: string[];
  }>;
  future: unknown[];
}

export interface DocumentTransactionInput {
  id: string;
  actor: string;
  operations: unknown[];
  baseRevision?: number | null;
  intent: string;
  tool: string;
  timestamp?: string | null;
  metadata?: Record<string, unknown>;
}

export function commitDocumentOperation(
  history: HistoryLike,
  session: AgentSession,
  operationId: string,
  transactionInput: DocumentTransactionInput,
  options: { recordedAt: string },
): { history: HistoryLike; session: AgentSession; operation: OperationEnvelope } {
  validateSession(session);
  assertNonEmptyString(operationId, "operationId");
  const operation = getOperation(session, operationId);
  if (!operation.authority.documentAffecting) {
    throw new AgentRuntimeError(`operation ${operationId} is not document-affecting`);
  }
  if (operation.authority.transactionId !== null) {
    throw new AgentRuntimeError(
      `operation ${operationId} is already bound to transaction ${operation.authority.transactionId}`,
    );
  }

  assertNonEmptyString(transactionInput.id, "transaction.id");
  if (transactionInput.actor !== operation.authority.actorId) {
    throw new AgentRuntimeError(`transaction actor must match operation ${operationId} actorId`);
  }
  if (transactionInput.intent !== operation.authority.intent) {
    throw new AgentRuntimeError(`transaction intent must match operation ${operationId} intent`);
  }
  if (transactionInput.tool !== operation.authority.toolId) {
    throw new AgentRuntimeError(`transaction tool must match operation ${operationId} toolId`);
  }
  if (!Array.isArray(transactionInput.operations) || transactionInput.operations.length === 0) {
    throw new AgentRuntimeError("transaction.operations must be a non-empty array");
  }

  const metadata = transactionInput.metadata ?? {};
  assertPlainObject(metadata, "transaction.metadata");
  if (
    Object.prototype.hasOwnProperty.call(metadata, "capabilityId")
    && metadata.capabilityId !== operation.authority.capabilityId
  ) {
    throw new AgentRuntimeError(
      "transaction metadata capabilityId conflicts with operation authority",
    );
  }

  const transaction = createTransaction({
    ...transactionInput,
    metadata: {
      ...metadata,
      agentOperationId: operation.id,
      capabilityId: operation.authority.capabilityId,
      affectedSourceIds: cloneJson(operation.authority.affectedSourceIds),
    },
  });
  const nextHistory = commitTransaction(history, transaction) as HistoryLike;
  const entry = nextHistory.past.at(-1);
  if (!entry || entry.transaction.id !== transaction.id) {
    throw new AgentRuntimeError("history did not record the committed transaction");
  }

  const bound: OperationEnvelope = {
    ...operation,
    authority: {
      ...operation.authority,
      affectedNodeIds: [...new Set([
        ...operation.authority.affectedNodeIds,
        ...entry.affectedNodeIds,
      ])].sort(),
      transactionId: transaction.id,
    },
  };
  const nextSession = bindOperationTransaction(session, bound, options.recordedAt);
  return {
    history: nextHistory,
    session: nextSession,
    operation: cloneJson(bound),
  };
}
