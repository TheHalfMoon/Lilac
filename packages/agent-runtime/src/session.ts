import { AgentRuntimeError, IdempotencyConflictError } from "./errors.ts";
import {
  assertNonEmptyString,
  assertPlainObject,
  assertTimestamp,
  canonicalStringify,
  cloneJson,
  normalizeJson,
  normalizeStringSet,
  type JsonValue,
} from "./json.ts";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  TERMINAL_OPERATION_STATUSES,
  assertObjectOperationState,
  validateOperation,
  validateOperationUpdate,
  type OperationEnvelope,
  type OperationStatus,
} from "./operation.ts";

export const SESSION_LOG_FORMAT_VERSION = 1;
export const SESSION_ITEM_KINDS = Object.freeze([
  "fork",
  "input",
  "turn",
  "model_response",
  "tool_call_status",
] as const);
export const INPUT_KINDS = Object.freeze(["external", "control", "crash"] as const);

export type SessionItemKind = (typeof SESSION_ITEM_KINDS)[number];
export type InputKind = (typeof INPUT_KINDS)[number];

export interface InputRecord {
  id: string;
  kind: InputKind;
  payload: JsonValue;
}
export interface TurnRecord {
  id: string;
  previousTurnId: string | null;
  metadata?: JsonValue;
}
export interface ModelResponseRecord {
  turnId: string;
  response: JsonValue;
}
export interface ForkRecord {
  parentId: string;
  previousTurnId: string;
}
export interface ToolCallStatusRecord {
  turnId: string;
  callId: string;
  error: string | null;
  waitingFor: string[];
  operationSnapshots: OperationEnvelope[];
}
export interface SessionItem {
  sequence: number;
  recordedAt: string;
  kind: SessionItemKind;
  data: ForkRecord | InputRecord | TurnRecord | ModelResponseRecord | ToolCallStatusRecord;
}
export interface ItemLogRecord {
  type: "item";
  item: SessionItem;
}
export interface OperationLogRecord {
  type: "operation";
  recordedAt: string;
  operation: OperationEnvelope;
}
export type SessionLogRecord = ItemLogRecord | OperationLogRecord;
export interface AgentSession {
  schemaVersion: number;
  id: string;
  createdAt: string;
  records: SessionLogRecord[];
}
export interface ResumeState {
  session: AgentSession;
  operations: OperationEnvelope[];
  externalInputIds: string[];
}

const ITEM_KIND_SET = new Set<string>(SESSION_ITEM_KINDS);
const INPUT_KIND_SET = new Set<string>(INPUT_KINDS);

interface ReplayState {
  operations: Map<string, OperationEnvelope>;
  externalInputIds: string[];
  pendingInConversation: Set<string>;
  latestTurnId: string | null;
}

function toolKey(turnId: string, callId: string): string {
  return `${turnId}\u0000${callId}`;
}

function validateInput(value: unknown): InputRecord {
  assertPlainObject(value, "input");
  assertNonEmptyString(value.id, "input.id");
  if (typeof value.kind !== "string" || !INPUT_KIND_SET.has(value.kind)) {
    throw new AgentRuntimeError(`input ${value.id} has unsupported kind ${String(value.kind)}`);
  }
  return {
    id: value.id,
    kind: value.kind as InputKind,
    payload: normalizeJson(value.payload ?? null, `input ${value.id}.payload`),
  };
}

function validateToolStatusShape(value: unknown): ToolCallStatusRecord {
  assertPlainObject(value, "tool call status");
  assertNonEmptyString(value.turnId, "toolCallStatus.turnId");
  assertNonEmptyString(value.callId, "toolCallStatus.callId");
  const error = value.error ?? null;
  if (error !== null) assertNonEmptyString(error, "toolCallStatus.error");
  const waitingFor = normalizeStringSet(value.waitingFor ?? [], "toolCallStatus.waitingFor");
  if (!Array.isArray(value.operationSnapshots)) {
    throw new AgentRuntimeError("toolCallStatus.operationSnapshots must be an array");
  }
  const operationSnapshots = value.operationSnapshots.map((operation) => {
    validateOperation(operation);
    return cloneJson(operation);
  });
  return {
    turnId: value.turnId,
    callId: value.callId,
    error,
    waitingFor,
    operationSnapshots,
  };
}

function lastForkSequence(session: AgentSession): number | null {
  let sequence: number | null = null;
  for (const record of session.records) {
    if (record.type === "item" && record.item.kind === "fork") {
      sequence = record.item.sequence;
    }
  }
  return sequence;
}

function replaySession(session: AgentSession): ReplayState {
  let expectedSequence = 1;
  let latestTurnId: string | null = null;
  const allTurns = new Set<string>();
  let ownedTurns = new Set<string>();
  let respondedTurns = new Set<string>();
  let toolKeys = new Set<string>();
  let operations = new Map<string, OperationEnvelope>();
  const inputs = new Map<string, InputRecord>();
  const externalInputIds: string[] = [];
  const pendingInConversation = new Set<string>();
  const finalForkSequence = lastForkSequence(session);

  for (const record of session.records) {
    assertPlainObject(record, "session record");
    if (record.type === "operation") {
      assertTimestamp(record.recordedAt, "operation record recordedAt");
      validateOperation(record.operation);
      const current = operations.get(record.operation.id);
      if (!current) {
        throw new AgentRuntimeError(`operation update ${record.operation.id} has no initialization`);
      }
      validateOperationUpdate(current, record.operation, { allowTransactionBinding: true });
      operations.set(record.operation.id, cloneJson(record.operation));
      continue;
    }
    if (record.type !== "item") {
      throw new AgentRuntimeError(
        `unsupported session record type ${String((record as { type?: unknown }).type)}`,
      );
    }

    const item = record.item;
    assertPlainObject(item, "session item");
    if (item.sequence !== expectedSequence) {
      throw new AgentRuntimeError(
        `session item sequence ${String(item.sequence)} is not contiguous; expected ${expectedSequence}`,
      );
    }
    expectedSequence += 1;
    assertTimestamp(item.recordedAt, `session item ${item.sequence}.recordedAt`);
    if (typeof item.kind !== "string" || !ITEM_KIND_SET.has(item.kind)) {
      throw new AgentRuntimeError(
        `session item ${item.sequence} has unsupported kind ${String(item.kind)}`,
      );
    }
    const inherited = finalForkSequence !== null && item.sequence < finalForkSequence;

    if (item.kind === "input") {
      const input = validateInput(item.data);
      const existing = inputs.get(input.id);
      if (existing) {
        throw new AgentRuntimeError(`session log contains duplicate input id ${input.id}`);
      }
      inputs.set(input.id, input);
      if (input.kind === "external") externalInputIds.push(input.id);
      continue;
    }

    if (item.kind === "turn") {
      assertPlainObject(item.data, "turn");
      assertNonEmptyString(item.data.id, "turn.id");
      const previous = item.data.previousTurnId ?? null;
      if (previous !== latestTurnId) {
        throw new AgentRuntimeError(
          `turn ${item.data.id} previousTurnId is ${String(previous)}, expected ${String(latestTurnId)}`,
        );
      }
      if (allTurns.has(item.data.id)) throw new AgentRuntimeError(`duplicate turn id ${item.data.id}`);
      if (item.data.metadata !== undefined) normalizeJson(item.data.metadata, `turn ${item.data.id}.metadata`);
      allTurns.add(item.data.id);
      latestTurnId = item.data.id;
      if (!inherited) ownedTurns.add(item.data.id);
      continue;
    }

    if (item.kind === "model_response") {
      assertPlainObject(item.data, "model response");
      assertNonEmptyString(item.data.turnId, "modelResponse.turnId");
      if (!allTurns.has(item.data.turnId)) {
        throw new AgentRuntimeError(`model response references unknown turn ${item.data.turnId}`);
      }
      normalizeJson(item.data.response, "modelResponse.response");
      if (!inherited) {
        if (!ownedTurns.has(item.data.turnId)) {
          throw new AgentRuntimeError(`model response turn ${item.data.turnId} is not owned`);
        }
        if (respondedTurns.has(item.data.turnId)) {
          throw new AgentRuntimeError(`turn ${item.data.turnId} has multiple model responses`);
        }
        respondedTurns.add(item.data.turnId);
      }
      continue;
    }

    if (item.kind === "tool_call_status") {
      const status = validateToolStatusShape(item.data);
      if (inherited) {
        if (!allTurns.has(status.turnId)) {
          throw new AgentRuntimeError(`inherited tool status references unknown turn ${status.turnId}`);
        }
        if (status.operationSnapshots.length !== 0) {
          throw new AgentRuntimeError("inherited tool status cannot expose dispatchable operations");
        }
        continue;
      }
      if (!ownedTurns.has(status.turnId)) {
        throw new AgentRuntimeError(`tool call turn ${status.turnId} is not owned`);
      }
      const key = toolKey(status.turnId, status.callId);
      const first = !toolKeys.has(key);
      if (first) toolKeys.add(key);

      if (status.error !== null) {
        if (status.waitingFor.length !== 0 || status.operationSnapshots.length !== 0) {
          throw new AgentRuntimeError(
            "error tool-call status cannot wait for or initialize operations",
          );
        }
      } else if (first) {
        if (status.operationSnapshots.length === 0) {
          throw new AgentRuntimeError(
            "successful first tool-call status must initialize at least one operation",
          );
        }
        const ids = status.operationSnapshots.map((operation) => operation.id).sort();
        if (new Set(ids).size !== ids.length) {
          throw new AgentRuntimeError("tool-call status initializes duplicate operation ids");
        }
        if (canonicalStringify(ids) !== canonicalStringify(status.waitingFor)) {
          throw new AgentRuntimeError(
            "tool-call waitingFor must exactly match initialized operations",
          );
        }
        for (const operation of status.operationSnapshots) {
          if (operations.has(operation.id)) {
            throw new AgentRuntimeError(`operation ${operation.id} already exists`);
          }
          operations.set(operation.id, cloneJson(operation));
        }
      } else {
        for (const snapshot of status.operationSnapshots) {
          const current = operations.get(snapshot.id);
          if (!current) {
            throw new AgentRuntimeError(
              `tool-call status references unknown operation ${snapshot.id}`,
            );
          }
          if (canonicalStringify(current) !== canonicalStringify(snapshot)) {
            throw new AgentRuntimeError(
              `tool-call status snapshot ${snapshot.id} must match latest durable state`,
            );
          }
        }
        for (const operationId of status.waitingFor) {
          if (!operations.has(operationId)) {
            throw new AgentRuntimeError(`tool-call status waits for unknown operation ${operationId}`);
          }
        }
      }

      for (const snapshot of status.operationSnapshots) {
        if (TERMINAL_OPERATION_STATUSES.has(snapshot.status)) {
          pendingInConversation.delete(snapshot.id);
        } else {
          pendingInConversation.add(snapshot.id);
        }
      }
      continue;
    }

    assertPlainObject(item.data, "fork");
    assertNonEmptyString(item.data.parentId, "fork.parentId");
    assertNonEmptyString(item.data.previousTurnId, "fork.previousTurnId");
    if (item.data.previousTurnId !== latestTurnId) {
      throw new AgentRuntimeError("fork.previousTurnId must match inherited latest turn");
    }
    ownedTurns = new Set<string>();
    respondedTurns = new Set<string>();
    toolKeys = new Set<string>();
    operations = new Map<string, OperationEnvelope>();
    pendingInConversation.clear();
  }

  return { operations, externalInputIds, pendingInConversation, latestTurnId };
}

export function createSession(input: { id: string; createdAt: string }): AgentSession {
  assertNonEmptyString(input.id, "session.id");
  assertTimestamp(input.createdAt, "session.createdAt");
  return {
    schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
    id: input.id,
    createdAt: input.createdAt,
    records: [],
  };
}

export function validateSession(value: unknown): asserts value is AgentSession {
  assertPlainObject(value, "session");
  if (value.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION) {
    throw new AgentRuntimeError(`unsupported session schema version ${String(value.schemaVersion)}`);
  }
  assertNonEmptyString(value.id, "session.id");
  assertTimestamp(value.createdAt, "session.createdAt");
  if (!Array.isArray(value.records)) throw new AgentRuntimeError("session.records must be an array");
  replaySession(value as unknown as AgentSession);
}

function appendItem(
  session: AgentSession,
  kind: SessionItemKind,
  data: SessionItem["data"],
  recordedAt: string,
): AgentSession {
  assertTimestamp(recordedAt, "recordedAt");
  const next = cloneJson(session);
  let sequence = 0;
  for (const record of next.records) {
    if (record.type === "item") sequence = record.item.sequence;
  }
  next.records.push({
    type: "item",
    item: { sequence: sequence + 1, recordedAt, kind, data: cloneJson(data) },
  });
  validateSession(next);
  return next;
}

export function appendInput(
  session: AgentSession,
  input: InputRecord,
  options: { recordedAt: string },
): { session: AgentSession; duplicate: boolean; item: SessionItem | null } {
  validateSession(session);
  const normalized = validateInput(input);
  for (const record of session.records) {
    if (record.type !== "item" || record.item.kind !== "input") continue;
    const existing = record.item.data as InputRecord;
    if (existing.id !== normalized.id) continue;
    if (canonicalStringify(existing) !== canonicalStringify(normalized)) {
      throw new IdempotencyConflictError(
        `input id ${normalized.id} was already used for different content`,
      );
    }
    return { session, duplicate: true, item: null };
  }
  const next = appendItem(session, "input", normalized, options.recordedAt);
  return {
    session: next,
    duplicate: false,
    item: cloneJson((next.records.at(-1) as ItemLogRecord).item),
  };
}

export function appendTurn(
  session: AgentSession,
  turn: TurnRecord,
  options: { recordedAt: string },
): AgentSession {
  validateSession(session);
  assertNonEmptyString(turn.id, "turn.id");
  const state = replaySession(session);
  const previousTurnId = turn.previousTurnId ?? null;
  if (previousTurnId !== state.latestTurnId) {
    throw new AgentRuntimeError(
      `turn ${turn.id} previousTurnId is ${String(previousTurnId)}, expected ${String(state.latestTurnId)}`,
    );
  }
  for (const record of session.records) {
    if (
      record.type === "item"
      && record.item.kind === "turn"
      && (record.item.data as TurnRecord).id === turn.id
    ) {
      throw new AgentRuntimeError(`duplicate turn id ${turn.id}`);
    }
  }
  return appendItem(
    session,
    "turn",
    {
      id: turn.id,
      previousTurnId,
      ...(turn.metadata === undefined
        ? {}
        : { metadata: normalizeJson(turn.metadata, `turn ${turn.id}.metadata`) }),
    },
    options.recordedAt,
  );
}

export function appendModelResponse(
  session: AgentSession,
  response: ModelResponseRecord,
  options: { recordedAt: string },
): AgentSession {
  validateSession(session);
  assertNonEmptyString(response.turnId, "modelResponse.turnId");
  for (const record of session.records) {
    if (
      record.type === "item"
      && record.item.kind === "model_response"
      && (record.item.data as ModelResponseRecord).turnId === response.turnId
    ) {
      const lastFork = lastForkSequence(session);
      if (lastFork === null || record.item.sequence > lastFork) {
        throw new AgentRuntimeError(`turn ${response.turnId} already has a model response`);
      }
    }
  }
  return appendItem(
    session,
    "model_response",
    { turnId: response.turnId, response: normalizeJson(response.response, "modelResponse.response") },
    options.recordedAt,
  );
}

export function appendToolCallStatus(
  session: AgentSession,
  value: ToolCallStatusRecord,
  options: { recordedAt: string },
): AgentSession {
  validateSession(session);
  const status = validateToolStatusShape(value);
  return appendItem(session, "tool_call_status", status, options.recordedAt);
}

function appendOperationCheckpoint(
  session: AgentSession,
  operation: OperationEnvelope,
  recordedAt: string,
  options: { allowTransactionBinding?: boolean } = {},
): AgentSession {
  validateSession(session);
  assertTimestamp(recordedAt, "recordedAt");
  const state = replaySession(session);
  const current = state.operations.get(operation.id);
  if (!current) throw new AgentRuntimeError(`unknown operation ${operation.id}`);
  validateOperationUpdate(current, operation, options);
  const next = cloneJson(session);
  next.records.push({ type: "operation", recordedAt, operation: cloneJson(operation) });
  validateSession(next);
  return next;
}

export function saveOperation(
  session: AgentSession,
  operation: OperationEnvelope,
  options: { recordedAt: string },
): AgentSession {
  return appendOperationCheckpoint(session, operation, options.recordedAt);
}

export function updateOperation(
  session: AgentSession,
  operationId: string,
  patch: { status?: OperationStatus; state?: JsonValue; idempotency?: JsonValue },
  options: { recordedAt: string },
): AgentSession {
  validateSession(session);
  assertNonEmptyString(operationId, "operationId");
  const current = replaySession(session).operations.get(operationId);
  if (!current) throw new AgentRuntimeError(`unknown operation ${operationId}`);
  const next: OperationEnvelope = {
    ...current,
    status: patch.status ?? current.status,
    state: patch.state === undefined
      ? current.state
      : normalizeJson(patch.state, `operation ${operationId}.state`),
    idempotency: patch.idempotency === undefined
      ? current.idempotency
      : normalizeJson(patch.idempotency, `operation ${operationId}.idempotency`),
    authority: cloneJson(current.authority),
  };
  return appendOperationCheckpoint(session, next, options.recordedAt);
}

export function requestOperationCancellation(
  session: AgentSession,
  operationId: string,
  reason: string,
  options: { recordedAt: string },
): AgentSession {
  assertNonEmptyString(reason, "cancellation reason");
  const current = getOperation(session, operationId);
  if (TERMINAL_OPERATION_STATUSES.has(current.status)) return session;
  const state = {
    ...assertObjectOperationState(current.state, operationId),
    cancellation: { reason },
  };
  return updateOperation(session, operationId, { status: "canceling", state }, options);
}

export function markOperationCanceled(
  session: AgentSession,
  operationId: string,
  reason: string,
  options: { recordedAt: string },
): AgentSession {
  assertNonEmptyString(reason, "cancellation reason");
  const current = getOperation(session, operationId);
  const state = {
    ...assertObjectOperationState(current.state, operationId),
    cancellation: { reason },
  };
  return updateOperation(session, operationId, { status: "canceled", state }, options);
}

export function failOperation(
  session: AgentSession,
  operationId: string,
  error: string,
  options: { recordedAt: string },
): AgentSession {
  assertNonEmptyString(error, "failure error");
  const current = getOperation(session, operationId);
  const state = {
    ...assertObjectOperationState(current.state, operationId),
    failure: { error },
  };
  return updateOperation(session, operationId, { status: "failed", state }, options);
}

export function getOperation(session: AgentSession, operationId: string): OperationEnvelope {
  validateSession(session);
  assertNonEmptyString(operationId, "operationId");
  const operation = replaySession(session).operations.get(operationId);
  if (!operation) throw new AgentRuntimeError(`unknown operation ${operationId}`);
  return cloneJson(operation);
}

export function resumeSession(session: AgentSession): ResumeState {
  validateSession(session);
  const state = replaySession(session);
  const operations = [...state.operations.values()]
    .filter(
      (operation) => !TERMINAL_OPERATION_STATUSES.has(operation.status)
        || state.pendingInConversation.has(operation.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((operation) => cloneJson(operation));
  return {
    session: cloneJson(session),
    operations,
    externalInputIds: [...state.externalInputIds],
  };
}

export function forkSession(
  parent: AgentSession,
  input: { id: string; previousTurnId: string; createdAt: string; recordedAt: string },
): AgentSession {
  validateSession(parent);
  assertNonEmptyString(input.id, "fork.id");
  if (input.id === parent.id) throw new AgentRuntimeError("session cannot fork onto itself");
  assertNonEmptyString(input.previousTurnId, "fork.previousTurnId");
  assertTimestamp(input.createdAt, "fork.createdAt");
  assertTimestamp(input.recordedAt, "fork.recordedAt");

  const itemRecords = parent.records.filter(
    (record): record is ItemLogRecord => record.type === "item",
  );
  let boundary = -1;
  for (let index = 0; index < itemRecords.length; index += 1) {
    const item = itemRecords[index].item;
    if (boundary >= 0 && item.kind === "turn") break;
    if (item.kind === "turn" && (item.data as TurnRecord).id === input.previousTurnId) {
      boundary = index;
    }
    if (
      item.kind === "model_response"
      && (item.data as ModelResponseRecord).turnId === input.previousTurnId
    ) {
      boundary = index;
    }
    if (
      item.kind === "tool_call_status"
      && (item.data as ToolCallStatusRecord).turnId === input.previousTurnId
    ) {
      boundary = index;
    }
  }
  if (boundary < 0) {
    throw new AgentRuntimeError(
      `cannot fork session ${parent.id}: turn ${input.previousTurnId} does not exist`,
    );
  }

  const child = createSession({ id: input.id, createdAt: input.createdAt });
  child.records = itemRecords.slice(0, boundary + 1).map((record) => {
    const copy = cloneJson(record);
    if (copy.item.kind === "tool_call_status") {
      (copy.item.data as ToolCallStatusRecord).operationSnapshots = [];
    }
    return copy;
  });
  const forked = appendItem(
    child,
    "fork",
    { parentId: parent.id, previousTurnId: input.previousTurnId },
    input.recordedAt,
  );
  validateSession(parent);
  return forked;
}

export function bindOperationTransaction(
  session: AgentSession,
  operation: OperationEnvelope,
  recordedAt: string,
): AgentSession {
  return appendOperationCheckpoint(
    session,
    operation,
    recordedAt,
    { allowTransactionBinding: true },
  );
}

export function serializeSessionLog(session: AgentSession): string {
  validateSession(session);
  const header = {
    type: "session",
    data: {
      formatVersion: SESSION_LOG_FORMAT_VERSION,
      session: {
        schemaVersion: session.schemaVersion,
        id: session.id,
        createdAt: session.createdAt,
      },
    },
  };
  return `${[
    canonicalStringify(header),
    ...session.records.map((record) => canonicalStringify(record)),
  ].join("\n")}\n`;
}

export function deserializeSessionLog(encoded: string): AgentSession {
  if (typeof encoded !== "string") throw new AgentRuntimeError("session log must be a string");
  const lastNewline = encoded.lastIndexOf("\n");
  if (lastNewline < 0) throw new AgentRuntimeError("session log has no committed records");
  const committed = encoded.slice(0, lastNewline);
  const lines = committed === "" ? [] : committed.split("\n");
  if (lines.length === 0) throw new AgentRuntimeError("session log is empty");

  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new AgentRuntimeError(`decode session header: ${(error as Error).message}`);
  }
  assertPlainObject(header, "session header");
  if (header.type !== "session") throw new AgentRuntimeError("session header must be first");
  assertPlainObject(header.data, "session header.data");
  if (header.data.formatVersion !== SESSION_LOG_FORMAT_VERSION) {
    throw new AgentRuntimeError(
      `unsupported session log format version ${String(header.data.formatVersion)}`,
    );
  }
  assertPlainObject(header.data.session, "session header.data.session");
  if (header.data.session.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION) {
    throw new AgentRuntimeError(
      `unsupported session schema version ${String(header.data.session.schemaVersion)}`,
    );
  }
  const session = createSession({
    id: header.data.session.id as string,
    createdAt: header.data.session.createdAt as string,
  });

  for (let index = 1; index < lines.length; index += 1) {
    try {
      session.records.push(JSON.parse(lines[index]) as SessionLogRecord);
    } catch (error) {
      throw new AgentRuntimeError(`decode session record ${index}: ${(error as Error).message}`);
    }
  }
  validateSession(session);
  return cloneJson(session);
}
