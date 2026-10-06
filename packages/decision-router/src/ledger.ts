import { DecisionConflictError, DecisionValidationError } from "./errors.ts";
import { DECISION_SCHEMA_VERSION, type DecisionRequest, type DecisionRequestLedger } from "./types.ts";
import { canonicalDecisionStringify, normalizeDecisionRequest, sha256Text } from "./validation.ts";

export function createDecisionRequestLedger(): DecisionRequestLedger {
  return { schemaVersion: DECISION_SCHEMA_VERSION, entries: {} };
}

function intentHash(request: DecisionRequest): string {
  return sha256Text(canonicalDecisionStringify({
    actorId: request.actorId,
    intent: request.intent,
    inputs: request.inputs,
    dimensions: request.dimensions,
    policy: request.policy,
  }));
}

export function recordDecisionRequest(
  ledgerInput: DecisionRequestLedger,
  requestInput: DecisionRequest,
  recordId: string,
): { ledger: DecisionRequestLedger; reused: boolean } {
  if (ledgerInput.schemaVersion !== DECISION_SCHEMA_VERSION || ledgerInput.entries === null || typeof ledgerInput.entries !== "object") {
    throw new DecisionValidationError("decision ledger is malformed");
  }
  const request = normalizeDecisionRequest(requestInput);
  if (Object.keys(ledgerInput.entries).length >= 1024 && ledgerInput.entries[request.requestId] === undefined) {
    throw new DecisionValidationError("decision ledger exceeds its bounded entry budget");
  }
  const normalized = structuredClone(ledgerInput);
  const next = {
    requestId: request.requestId,
    intentSha256: intentHash(request),
    inputSha256: sha256Text(canonicalDecisionStringify({ inputs: request.inputs, dimensions: request.dimensions })),
    recordId,
  };
  const current = normalized.entries[request.requestId];
  if (current) {
    if (
      current.intentSha256 !== next.intentSha256
      || current.inputSha256 !== next.inputSha256
      || current.recordId !== next.recordId
    ) {
      throw new DecisionConflictError(`decision request id ${request.requestId} was reused with conflicting input or intent`);
    }
    return { ledger: normalized, reused: true };
  }
  normalized.entries[request.requestId] = next;
  normalized.entries = Object.fromEntries(Object.entries(normalized.entries).sort(([a], [b]) => a.localeCompare(b)));
  return { ledger: normalized, reused: false };
}
