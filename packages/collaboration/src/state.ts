import { createAccessPolicy, normalizeAccessPolicy } from "./access.ts";
import { CollaborationValidationError } from "./errors.ts";
import { createCollaborationLog, normalizePersistentState } from "./durable.ts";
import { assertBoundedString } from "./validation.ts";
import { COLLABORATION_SCHEMA_VERSION, type AccessGrant, type CollaborationPersistentState, type DocumentAccessPolicy } from "./types.ts";

export function createCollaborationState(documentId: string, grants: AccessGrant[] = []): CollaborationPersistentState {
  assertBoundedString(documentId, "state.documentId");
  return normalizePersistentState({
    version: COLLABORATION_SCHEMA_VERSION,
    documentId,
    policy: createAccessPolicy(documentId, grants),
    log: createCollaborationLog(documentId),
  });
}

export function replaceStatePolicy(state: CollaborationPersistentState, policy: DocumentAccessPolicy): CollaborationPersistentState {
  const normalizedPolicy = normalizeAccessPolicy(policy);
  if (normalizedPolicy.documentId !== state.documentId) throw new CollaborationValidationError("policy belongs to another document");
  return normalizePersistentState({ ...state, policy: normalizedPolicy });
}
