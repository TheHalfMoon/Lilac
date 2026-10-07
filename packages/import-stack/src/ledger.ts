import { ImportConflictError, ImportValidationError } from "./errors.ts";
import { IMPORT_SCHEMA_VERSION, type ImportRequest, type ImportRequestLedger } from "./types.ts";
import { canonicalImportStringify, compareCodeUnits, normalizeImportRequest, sha256Text } from "./validation.ts";

export function createImportRequestLedger(): ImportRequestLedger {
  return { schemaVersion: IMPORT_SCHEMA_VERSION, entries: {} };
}

function intentHash(request: ImportRequest): string {
  return sha256Text(canonicalImportStringify({
    actorId: request.actorId,
    intent: request.intent,
    source: request.source,
    policy: request.policy,
  }));
}

export function recordImportRequest(
  ledgerInput: ImportRequestLedger,
  requestInput: ImportRequest,
  inputSha256: string,
  proposalId: string,
): { ledger: ImportRequestLedger; reused: boolean } {
  if (ledgerInput.schemaVersion !== IMPORT_SCHEMA_VERSION || ledgerInput.entries === null || typeof ledgerInput.entries !== "object") {
    throw new ImportValidationError("import ledger is malformed");
  }
  const request = normalizeImportRequest(requestInput);
  const normalized = structuredClone(ledgerInput);
  const next = {
    requestId: request.requestId,
    intentSha256: intentHash(request),
    inputSha256,
    proposalId,
  };
  const current = normalized.entries[request.requestId];
  if (current) {
    if (
      current.intentSha256 !== next.intentSha256
      || current.inputSha256 !== next.inputSha256
      || current.proposalId !== next.proposalId
    ) {
      throw new ImportConflictError(`import request id ${request.requestId} was reused with conflicting input or intent`);
    }
    return { ledger: normalized, reused: true };
  }
  normalized.entries[request.requestId] = next;
  normalized.entries = Object.fromEntries(Object.entries(normalized.entries).sort(([a], [b]) => compareCodeUnits(a, b)));
  return { ledger: normalized, reused: false };
}
