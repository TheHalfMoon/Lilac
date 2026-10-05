import { canonicalStringify } from "@lilac/agent-runtime";
import { normalizeAccessPolicy } from "./access.ts";
import { CollaborationConflictError, CollaborationPersistenceError, CollaborationValidationError } from "./errors.ts";
import { assertAllowedKeys, assertBoundedString, assertPlainObject, assertSchemaVersion, assertTimestamp, normalizeMetadata } from "./validation.ts";
import {
  COLLABORATION_SCHEMA_VERSION,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_LOG_BYTES,
  MAX_LOG_ENTRIES,
  MAX_STATE_BYTES,
  type CollaborationFact,
  type CollaborationFactKind,
  type CollaborationLog,
  type CollaborationPersistentState,
  type DurableActorIdentity,
} from "./types.ts";

const FACT_KINDS = new Set<CollaborationFactKind>([
  "transaction-committed",
  "comment-created",
  "comment-replied",
  "comment-resolved",
  "access-changed",
  "agent-work-linked",
  "reconnect-recovered",
]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeDurableActor(value: DurableActorIdentity, label = "fact.actor"): DurableActorIdentity {
  assertPlainObject(value, label);
  assertAllowedKeys(value, label, ["actorId", "kind", "accessClass", "displayName", "ownerActorId"]);
  assertBoundedString(value.actorId, `${label}.actorId`);
  if (value.kind !== "user" && value.kind !== "agent") {
    throw new CollaborationValidationError(`${label}.kind is unsupported`);
  }
  if (value.accessClass !== "member" && value.accessClass !== "guest" && value.accessClass !== "service") throw new CollaborationValidationError(`${label}.accessClass is unsupported`);
  assertBoundedString(value.displayName, `${label}.displayName`, MAX_DISPLAY_NAME_LENGTH);
  if (value.ownerActorId !== undefined) assertBoundedString(value.ownerActorId, `${label}.ownerActorId`);
  if (value.kind === "user" && value.ownerActorId !== undefined) {
    throw new CollaborationValidationError(`${label} user cannot declare ownerActorId`);
  }
  return structuredClone(value);
}

function normalizeFact(
  fact: CollaborationFact,
  documentId: string,
  expectedSequence?: number,
): CollaborationFact {
  assertPlainObject(fact, "fact");
  assertAllowedKeys(fact, "fact", ["version", "documentId", "id", "sequence", "kind", "actor", "at", "data"]);
  assertSchemaVersion(fact.version, "fact");
  assertBoundedString(fact.documentId, "fact.documentId");
  if (fact.documentId !== documentId) throw new CollaborationValidationError("fact belongs to another document");
  assertBoundedString(fact.id, "fact.id");
  if (!Number.isSafeInteger(fact.sequence) || fact.sequence <= 0) {
    throw new CollaborationValidationError("fact.sequence must be a positive safe integer");
  }
  if (expectedSequence !== undefined && fact.sequence !== expectedSequence) {
    throw new CollaborationConflictError(`durable sequence ${fact.sequence} does not match expected ${expectedSequence}`);
  }
  if (!FACT_KINDS.has(fact.kind)) throw new CollaborationValidationError("fact.kind is unsupported");
  const actor = normalizeDurableActor(fact.actor);
  assertTimestamp(fact.at, "fact.at");
  const data = normalizeMetadata(fact.data, "fact.data");
  return {
    version: COLLABORATION_SCHEMA_VERSION,
    documentId,
    id: fact.id,
    sequence: fact.sequence,
    kind: fact.kind,
    actor,
    at: fact.at,
    data,
  };
}

export function createCollaborationLog(documentId: string): CollaborationLog {
  assertBoundedString(documentId, "log.documentId");
  return { version: COLLABORATION_SCHEMA_VERSION, documentId, nextSequence: 1, facts: [] };
}

export function normalizeCollaborationLog(log: CollaborationLog): CollaborationLog {
  assertPlainObject(log, "log");
  assertAllowedKeys(log, "log", ["version", "documentId", "nextSequence", "facts"]);
  assertSchemaVersion(log.version, "log");
  assertBoundedString(log.documentId, "log.documentId");
  if (!Array.isArray(log.facts) || log.facts.length > MAX_LOG_ENTRIES) {
    throw new CollaborationValidationError(`log.facts exceeds ${MAX_LOG_ENTRIES} entries`);
  }
  const facts: CollaborationFact[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < log.facts.length; index += 1) {
    const fact = normalizeFact(log.facts[index], log.documentId, index + 1);
    if (ids.has(fact.id)) throw new CollaborationConflictError(`duplicate durable fact id ${fact.id}`);
    ids.add(fact.id);
    facts.push(fact);
  }
  if (!Number.isSafeInteger(log.nextSequence) || log.nextSequence !== facts.length + 1) {
    throw new CollaborationValidationError("log.nextSequence does not match contiguous durable facts");
  }
  const normalized = { version: COLLABORATION_SCHEMA_VERSION, documentId: log.documentId, nextSequence: log.nextSequence, facts };
  if (byteLength(canonicalStringify(normalized)) > MAX_LOG_BYTES) {
    throw new CollaborationValidationError(`collaboration log exceeds ${MAX_LOG_BYTES} bytes`);
  }
  return normalized;
}

export type NewCollaborationFact = Omit<CollaborationFact, "version" | "documentId" | "sequence">;

export function appendCollaborationFact(logInput: CollaborationLog, input: NewCollaborationFact): CollaborationLog {
  const log = normalizeCollaborationLog(logInput);
  if (log.facts.length >= MAX_LOG_ENTRIES) throw new CollaborationPersistenceError("collaboration log is full");
  if (log.facts.some((fact) => fact.id === input.id)) throw new CollaborationConflictError(`duplicate durable fact id ${input.id}`);
  const fact = normalizeFact({
    ...input,
    version: COLLABORATION_SCHEMA_VERSION,
    documentId: log.documentId,
    sequence: log.nextSequence,
  }, log.documentId, log.nextSequence);
  return normalizeCollaborationLog({
    ...log,
    nextSequence: log.nextSequence + 1,
    facts: [...log.facts, fact],
  });
}

export function applyRemoteFact(logInput: CollaborationLog, factInput: CollaborationFact): CollaborationLog {
  const log = normalizeCollaborationLog(logInput);
  if (log.facts.some((fact) => fact.id === factInput.id)) {
    throw new CollaborationConflictError(`duplicate durable fact id ${factInput.id}`);
  }
  const fact = normalizeFact(factInput, log.documentId, log.nextSequence);
  return normalizeCollaborationLog({ ...log, nextSequence: log.nextSequence + 1, facts: [...log.facts, fact] });
}

export function serializeCollaborationLog(log: CollaborationLog): string {
  return canonicalStringify(normalizeCollaborationLog(log));
}

export function deserializeCollaborationLog(serialized: string): CollaborationLog {
  if (typeof serialized !== "string" || byteLength(serialized) > MAX_LOG_BYTES) {
    throw new CollaborationPersistenceError("serialized collaboration log is invalid or oversized");
  }
  try {
    return normalizeCollaborationLog(JSON.parse(serialized) as CollaborationLog);
  } catch (error) {
    if (error instanceof CollaborationValidationError || error instanceof CollaborationConflictError) throw error;
    throw new CollaborationPersistenceError("serialized collaboration log is malformed");
  }
}

export function normalizePersistentState(state: CollaborationPersistentState): CollaborationPersistentState {
  assertPlainObject(state, "state");
  assertAllowedKeys(state, "state", ["version", "documentId", "policy", "log"]);
  assertSchemaVersion(state.version, "state");
  assertBoundedString(state.documentId, "state.documentId");
  const policy = normalizeAccessPolicy(state.policy);
  const log = normalizeCollaborationLog(state.log);
  if (policy.documentId !== state.documentId || log.documentId !== state.documentId) {
    throw new CollaborationValidationError("persistent collaboration state document identity mismatch");
  }
  return { version: COLLABORATION_SCHEMA_VERSION, documentId: state.documentId, policy, log };
}

export function serializePersistentState(state: CollaborationPersistentState): string {
  const serialized = canonicalStringify(normalizePersistentState(state));
  if (byteLength(serialized) > MAX_STATE_BYTES) {
    throw new CollaborationPersistenceError(`persistent collaboration state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  return serialized;
}

export function deserializePersistentState(serialized: string): CollaborationPersistentState {
  if (typeof serialized !== "string" || byteLength(serialized) > MAX_STATE_BYTES) {
    throw new CollaborationPersistenceError("serialized collaboration state is invalid or oversized");
  }
  try {
    return normalizePersistentState(JSON.parse(serialized) as CollaborationPersistentState);
  } catch (error) {
    if (error instanceof CollaborationValidationError || error instanceof CollaborationConflictError) throw error;
    throw new CollaborationPersistenceError("serialized collaboration state is malformed");
  }
}
