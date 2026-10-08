import { AgentRuntimeError, OperationTransitionError } from "./errors.ts";
import {
  assertNonEmptyString,
  assertPlainObject,
  canonicalStringify,
  cloneJson,
  isThenable,
  normalizeJson,
  normalizeStringSet,
  type JsonValue,
} from "./json.ts";

export const AGENT_RUNTIME_SCHEMA_VERSION = 1;
export const UNREAL_AGENT_PROVENANCE = Object.freeze({
  repository: "unreallabsai/unreal-agent",
  revision: "1b9f778453f411c029b39b85102aaefb95e7e48d",
  license: "MIT",
  posture: "semantic-port",
});

export const OPERATION_STATUSES = Object.freeze([
  "ready",
  "awaiting",
  "canceling",
  "completed",
  "failed",
  "canceled",
] as const);

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export interface OperationAuthority {
  documentAffecting: boolean;
  actorId: string;
  intent: string;
  capabilityId: string;
  toolId: string;
  affectedNodeIds: string[];
  affectedSourceIds: string[];
  transactionId: string | null;
}

export interface OperationEnvelope {
  schemaVersion: number;
  id: string;
  type: string;
  version: number;
  status: OperationStatus;
  state: JsonValue;
  idempotency: JsonValue;
  authority: OperationAuthority;
}

const STATUS_SET = new Set<string>(OPERATION_STATUSES);
export const TERMINAL_OPERATION_STATUSES = new Set<OperationStatus>([
  "completed",
  "failed",
  "canceled",
]);

const TRANSITIONS: Readonly<Record<OperationStatus, ReadonlySet<OperationStatus>>> = Object.freeze({
  ready: new Set(["ready", "awaiting", "canceling", "completed", "failed", "canceled"]),
  awaiting: new Set(["awaiting", "ready", "canceling", "completed", "failed", "canceled"]),
  canceling: new Set(["canceling", "canceled", "failed"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  canceled: new Set(["canceled"]),
});

export function validateAuthority(value: unknown, operationId: string): OperationAuthority {
  assertPlainObject(value, `operation ${operationId}.authority`);
  if (typeof value.documentAffecting !== "boolean") {
    throw new AgentRuntimeError(
      `operation ${operationId}.authority.documentAffecting must be boolean`,
    );
  }
  assertNonEmptyString(value.actorId, `operation ${operationId}.authority.actorId`);
  assertNonEmptyString(value.intent, `operation ${operationId}.authority.intent`);
  assertNonEmptyString(value.capabilityId, `operation ${operationId}.authority.capabilityId`);
  assertNonEmptyString(value.toolId, `operation ${operationId}.authority.toolId`);
  const affectedNodeIds = normalizeStringSet(
    value.affectedNodeIds ?? [],
    `operation ${operationId}.authority.affectedNodeIds`,
  );
  const affectedSourceIds = normalizeStringSet(
    value.affectedSourceIds ?? [],
    `operation ${operationId}.authority.affectedSourceIds`,
  );
  if (value.transactionId !== null) {
    assertNonEmptyString(value.transactionId, `operation ${operationId}.authority.transactionId`);
  }
  if (!value.documentAffecting && value.transactionId !== null) {
    throw new AgentRuntimeError(`non-document operation ${operationId} cannot bind a Ninerr transaction`);
  }
  return {
    documentAffecting: value.documentAffecting,
    actorId: value.actorId,
    intent: value.intent,
    capabilityId: value.capabilityId,
    toolId: value.toolId,
    affectedNodeIds,
    affectedSourceIds,
    transactionId: value.transactionId as string | null,
  };
}

export function createOperation(input: {
  id: string;
  type: string;
  version?: number;
  status?: OperationStatus;
  state?: JsonValue;
  idempotency?: JsonValue;
  authority: OperationAuthority;
}): OperationEnvelope {
  assertNonEmptyString(input.id, "operation.id");
  assertNonEmptyString(input.type, `operation ${input.id}.type`);
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new AgentRuntimeError(`operation ${input.id}.version must be a positive safe integer`);
  }
  const status = input.status ?? "ready";
  if (!STATUS_SET.has(status)) {
    throw new AgentRuntimeError(`operation ${input.id} has unsupported status ${String(status)}`);
  }
  const authority = validateAuthority(input.authority, input.id);
  if (authority.transactionId !== null) {
    throw new AgentRuntimeError(
      `new operation ${input.id} cannot start bound to a Ninerr transaction`,
    );
  }
  const operation: OperationEnvelope = {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    id: input.id,
    type: input.type,
    version,
    status,
    state: normalizeJson(input.state ?? {}, `operation ${input.id}.state`),
    idempotency: normalizeJson(input.idempotency ?? {}, `operation ${input.id}.idempotency`),
    authority,
  };
  validateOperation(operation);
  return operation;
}

export function validateOperation(value: unknown): asserts value is OperationEnvelope {
  assertPlainObject(value, "operation");
  if (value.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION) {
    throw new AgentRuntimeError(`unsupported operation schema version ${String(value.schemaVersion)}`);
  }
  assertNonEmptyString(value.id, "operation.id");
  assertNonEmptyString(value.type, `operation ${value.id}.type`);
  if (!Number.isSafeInteger(value.version) || (value.version as number) <= 0) {
    throw new AgentRuntimeError(`operation ${value.id}.version must be a positive safe integer`);
  }
  if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) {
    throw new AgentRuntimeError(`operation ${value.id} has unsupported status ${String(value.status)}`);
  }
  normalizeJson(value.state, `operation ${value.id}.state`);
  normalizeJson(value.idempotency, `operation ${value.id}.idempotency`);
  validateAuthority(value.authority, value.id);
}

export function validateOperationUpdate(
  current: OperationEnvelope,
  next: OperationEnvelope,
  options: { allowTransactionBinding?: boolean } = {},
): void {
  validateOperation(current);
  validateOperation(next);
  if (current.id !== next.id) throw new AgentRuntimeError("operation ID is immutable");
  if (current.type !== next.type || current.version !== next.version) {
    throw new AgentRuntimeError(`operation ${current.id} type and version are immutable`);
  }
  if (!TRANSITIONS[current.status].has(next.status)) {
    throw new OperationTransitionError(
      `operation ${current.id} cannot transition from ${current.status} to ${next.status}`,
    );
  }

  for (const key of ["documentAffecting", "actorId", "intent", "capabilityId", "toolId"] as const) {
    if (current.authority[key] !== next.authority[key]) {
      throw new AgentRuntimeError(`operation ${current.id} authority.${key} is immutable`);
    }
  }
  if (
    canonicalStringify(current.authority.affectedSourceIds)
    !== canonicalStringify(next.authority.affectedSourceIds)
  ) {
    throw new AgentRuntimeError(`operation ${current.id} affectedSourceIds are immutable`);
  }

  const currentNodes = new Set(current.authority.affectedNodeIds);
  const nextNodes = new Set(next.authority.affectedNodeIds);
  const nodeIdsEqual = currentNodes.size === nextNodes.size
    && [...currentNodes].every((id) => nextNodes.has(id));
  if (!nodeIdsEqual) {
    if (!options.allowTransactionBinding) {
      throw new AgentRuntimeError(`operation ${current.id} affectedNodeIds are immutable`);
    }
    if (![...currentNodes].every((id) => nextNodes.has(id))) {
      throw new AgentRuntimeError(
        `operation ${current.id} commit binding cannot remove known affectedNodeIds`,
      );
    }
  }

  if (current.authority.transactionId !== next.authority.transactionId) {
    if (
      !options.allowTransactionBinding
      || current.authority.transactionId !== null
      || next.authority.transactionId === null
    ) {
      throw new AgentRuntimeError(`operation ${current.id} transactionId cannot be changed`);
    }
  }
}

export function assertObjectOperationState(
  state: JsonValue,
  operationId: string,
): Record<string, JsonValue> {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new AgentRuntimeError(
      `operation ${operationId} state must be an object for lifecycle annotations`,
    );
  }
  return cloneJson(state);
}

export function translateToolCall(input: {
  toolCall: JsonValue;
  translate: (
    context: { submit: (operation: Parameters<typeof createOperation>[0]) => string },
    toolCall: JsonValue,
  ) => { error?: string | null; waitingFor?: string[] } | void;
}): {
  status: { error: string | null; waitingFor: string[] };
  operations: OperationEnvelope[];
} {
  if (typeof input.translate !== "function") {
    throw new AgentRuntimeError("translate must be a function");
  }
  const operations: OperationEnvelope[] = [];
  const ids = new Set<string>();
  const context = Object.freeze({
    submit(spec: Parameters<typeof createOperation>[0]): string {
      const operation = createOperation(spec);
      if (ids.has(operation.id)) {
        throw new AgentRuntimeError(`translator submitted duplicate operation ${operation.id}`);
      }
      ids.add(operation.id);
      operations.push(operation);
      return operation.id;
    },
  });

  const result = input.translate(context, cloneJson(input.toolCall));
  if (isThenable(result)) {
    throw new AgentRuntimeError("tool translation must be synchronous and cannot return a Promise");
  }
  const normalized = result ?? {};
  assertPlainObject(normalized, "translator result");
  const error = normalized.error ?? null;
  if (error !== null) assertNonEmptyString(error, "translator result.error");
  const waitingFor = normalized.waitingFor === undefined
    ? operations.map((operation) => operation.id).sort()
    : normalizeStringSet(normalized.waitingFor, "translator result.waitingFor");

  if (error !== null && (waitingFor.length !== 0 || operations.length !== 0)) {
    throw new AgentRuntimeError("failed translation cannot submit or wait for operations");
  }
  if (error === null) {
    const operationIds = operations.map((operation) => operation.id).sort();
    if (canonicalStringify(waitingFor) !== canonicalStringify(operationIds)) {
      throw new AgentRuntimeError("translator waitingFor must exactly match submitted operations");
    }
  }
  return {
    status: { error, waitingFor },
    operations: operations.map((operation) => cloneJson(operation)),
  };
}
