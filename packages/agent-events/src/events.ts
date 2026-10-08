import {
  assertNonEmptyString,
  assertTimestamp,
  canonicalStringify,
  cloneJson,
  normalizeJson,
  type JsonValue,
} from "@ninerr/agent-runtime";
import { AgentEventError, EventCorrelationError } from "./errors.ts";

export const AGENT_EVENT_SCHEMA_VERSION = 1;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_DELTA_BYTES = 16 * 1024;
export const MAX_ENVIRONMENT_REFERENCES = 32;
export const MAX_PLAN_STEPS = 128;
export const MAX_ID_LENGTH = 256;

export const AGENT_EVENT_KINDS = Object.freeze([
  "run_created",
  "run_started",
  "run_paused",
  "run_resumed",
  "run_completed",
  "run_failed",
  "run_canceled",
  "user_message",
  "assistant_message_start",
  "assistant_message_delta",
  "assistant_message_final",
  "tool_call_start",
  "tool_call_arguments_delta",
  "tool_call_final",
  "tool_result",
  "tool_error",
  "tool_canceled",
  "environment_input",
  "plan_started",
  "plan_updated",
  "plan_step_updated",
  "plan_completed",
  "worker_started",
  "worker_stopped",
  "worker_failed",
  "runtime_endpoint_lost",
  "progress_checkpoint_changed",
  "worker_wait_started",
  "worker_wait_ended",
  "worker_wedge_suspected",
  "worker_stale_escalated",
  "worker_recovery_started",
  "worker_recovery_completed",
  "worker_recovery_refused",
  "worker_retired",
] as const);

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export interface EnvironmentReference {
  kind: "screenshot" | "viewport" | "codebase" | "context";
  refId: string;
  mediaType?: string;
  sha256?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  label?: string;
}

export interface PlanStep {
  id: string;
  content: string;
  status: "pending" | "active" | "completed" | "failed" | "canceled";
}

export const SUPERVISOR_STALE_EVENT_STATES = Object.freeze([
  "healthy",
  "stale-suspected",
  "stale-confirmed",
  "recovery-requested",
  "recovering",
  "recovered",
  "recovery-refused",
  "terminal-failure",
] as const);

export type SupervisorStaleEventState = (typeof SUPERVISOR_STALE_EVENT_STATES)[number];

export interface AgentEventDataMap {
  run_created: { metadata?: JsonValue };
  run_started: { metadata?: JsonValue };
  run_paused: { reason: string };
  run_resumed: { reason?: string };
  run_completed: { summary?: string };
  run_failed: { error: string };
  run_canceled: { reason: string };
  user_message: { content: string };
  assistant_message_start: { role?: "assistant" };
  assistant_message_delta: { delta: string };
  assistant_message_final: { content: string; finishReason?: string };
  tool_call_start: { name: string };
  tool_call_arguments_delta: { delta: string };
  tool_call_final: { name: string; arguments: JsonValue };
  tool_result: { name: string; result: JsonValue; elapsedMs?: number };
  tool_error: { name: string; error: string; elapsedMs?: number };
  tool_canceled: { name: string; reason: string };
  environment_input: { references: EnvironmentReference[]; description?: string };
  plan_started: { title?: string };
  plan_updated: { steps: PlanStep[] };
  plan_step_updated: { step: PlanStep };
  plan_completed: { summary: string };
  worker_started: { taskId: string; supervisorGenerationId: string; endpointId: string; branch: string; worktreePath: string };
  worker_stopped: { taskId: string; supervisorGenerationId: string; endpointId: string; reason?: string };
  worker_failed: { taskId: string; supervisorGenerationId: string; endpointId?: string; error: string };
  runtime_endpoint_lost: { taskId: string; supervisorGenerationId: string; endpointId: string; state: "missing" | "unknown" | "gone"; absenceProven: boolean };
  progress_checkpoint_changed: { taskId: string; sourceHead: string; dirtyDigest: string; sourceSequence: number };
  worker_wait_started: { taskId: string; waitId: string; operationId: string; reason: string; validUntil: string };
  worker_wait_ended: { taskId: string; waitId: string; outcome: "completed" | "canceled" | "expired" | "failed" };
  worker_wedge_suspected: { taskId: string; staleWindows: number; reason: string };
  worker_stale_escalated: { taskId: string; from: SupervisorStaleEventState; to: SupervisorStaleEventState; staleWindows: number };
  worker_recovery_started: { taskId: string; recoveryId: string; priorEndpointId?: string };
  worker_recovery_completed: { taskId: string; recoveryId: string; endpointId: string };
  worker_recovery_refused: { taskId: string; recoveryId: string; reason: string };
  worker_retired: { taskId: string; reason?: string };
}

export interface AgentEvent<T extends AgentEventKind = AgentEventKind> {
  schemaVersion: number;
  id: string;
  sequence: number;
  runId: string;
  sessionId: string;
  timestamp: string;
  kind: T;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  operationId?: string;
  transactionId?: string;
  data: AgentEventDataMap[T];
}

const KIND_SET = new Set<string>(AGENT_EVENT_KINDS);
const MESSAGE_KINDS = new Set<AgentEventKind>([
  "user_message",
  "assistant_message_start",
  "assistant_message_delta",
  "assistant_message_final",
]);
const TOOL_KINDS = new Set<AgentEventKind>([
  "tool_call_start",
  "tool_call_arguments_delta",
  "tool_call_final",
  "tool_result",
  "tool_error",
  "tool_canceled",
]);
const EVENT_KEYS = new Set([
  "schemaVersion",
  "id",
  "sequence",
  "runId",
  "sessionId",
  "timestamp",
  "kind",
  "turnId",
  "messageId",
  "toolCallId",
  "operationId",
  "transactionId",
  "data",
]);
const CORRELATION_KEYS = [
  "turnId",
  "messageId",
  "toolCallId",
  "operationId",
  "transactionId",
] as const;
const TOOL_TERMINAL_CORRELATIONS = new Set<string>(CORRELATION_KEYS);
const SUPERVISOR_CORRELATIONS = new Set<string>(["operationId"]);
const DATA_KEYS: Record<AgentEventKind, ReadonlySet<string>> = {
  run_created: new Set(["metadata"]),
  run_started: new Set(["metadata"]),
  run_paused: new Set(["reason"]),
  run_resumed: new Set(["reason"]),
  run_completed: new Set(["summary"]),
  run_failed: new Set(["error"]),
  run_canceled: new Set(["reason"]),
  user_message: new Set(["content"]),
  assistant_message_start: new Set(["role"]),
  assistant_message_delta: new Set(["delta"]),
  assistant_message_final: new Set(["content", "finishReason"]),
  tool_call_start: new Set(["name"]),
  tool_call_arguments_delta: new Set(["delta"]),
  tool_call_final: new Set(["name", "arguments"]),
  tool_result: new Set(["name", "result", "elapsedMs"]),
  tool_error: new Set(["name", "error", "elapsedMs"]),
  tool_canceled: new Set(["name", "reason"]),
  environment_input: new Set(["references", "description"]),
  plan_started: new Set(["title"]),
  plan_updated: new Set(["steps"]),
  plan_step_updated: new Set(["step"]),
  plan_completed: new Set(["summary"]),
  worker_started: new Set(["taskId", "supervisorGenerationId", "endpointId", "branch", "worktreePath"]),
  worker_stopped: new Set(["taskId", "supervisorGenerationId", "endpointId", "reason"]),
  worker_failed: new Set(["taskId", "supervisorGenerationId", "endpointId", "error"]),
  runtime_endpoint_lost: new Set(["taskId", "supervisorGenerationId", "endpointId", "state", "absenceProven"]),
  progress_checkpoint_changed: new Set(["taskId", "sourceHead", "dirtyDigest", "sourceSequence"]),
  worker_wait_started: new Set(["taskId", "waitId", "operationId", "reason", "validUntil"]),
  worker_wait_ended: new Set(["taskId", "waitId", "outcome"]),
  worker_wedge_suspected: new Set(["taskId", "staleWindows", "reason"]),
  worker_stale_escalated: new Set(["taskId", "from", "to", "staleWindows"]),
  worker_recovery_started: new Set(["taskId", "recoveryId", "priorEndpointId"]),
  worker_recovery_completed: new Set(["taskId", "recoveryId", "endpointId"]),
  worker_recovery_refused: new Set(["taskId", "recoveryId", "reason"]),
  worker_retired: new Set(["taskId", "reason"]),
};
const CORRELATION_KEYS_BY_KIND: Record<AgentEventKind, ReadonlySet<string>> = {
  run_created: new Set(),
  run_started: new Set(),
  run_paused: new Set(),
  run_resumed: new Set(),
  run_completed: new Set(),
  run_failed: new Set(),
  run_canceled: new Set(),
  user_message: new Set(["turnId", "messageId"]),
  assistant_message_start: new Set(["turnId", "messageId"]),
  assistant_message_delta: new Set(["turnId", "messageId"]),
  assistant_message_final: new Set(["turnId", "messageId"]),
  tool_call_start: new Set(["turnId", "messageId", "toolCallId"]),
  tool_call_arguments_delta: new Set(["turnId", "messageId", "toolCallId"]),
  tool_call_final: TOOL_TERMINAL_CORRELATIONS,
  tool_result: TOOL_TERMINAL_CORRELATIONS,
  tool_error: TOOL_TERMINAL_CORRELATIONS,
  tool_canceled: TOOL_TERMINAL_CORRELATIONS,
  environment_input: new Set(["turnId"]),
  plan_started: new Set(["turnId"]),
  plan_updated: new Set(["turnId"]),
  plan_step_updated: new Set(["turnId"]),
  plan_completed: new Set(["turnId"]),
  worker_started: SUPERVISOR_CORRELATIONS,
  worker_stopped: SUPERVISOR_CORRELATIONS,
  worker_failed: SUPERVISOR_CORRELATIONS,
  runtime_endpoint_lost: SUPERVISOR_CORRELATIONS,
  progress_checkpoint_changed: SUPERVISOR_CORRELATIONS,
  worker_wait_started: SUPERVISOR_CORRELATIONS,
  worker_wait_ended: SUPERVISOR_CORRELATIONS,
  worker_wedge_suspected: SUPERVISOR_CORRELATIONS,
  worker_stale_escalated: SUPERVISOR_CORRELATIONS,
  worker_recovery_started: SUPERVISOR_CORRELATIONS,
  worker_recovery_completed: SUPERVISOR_CORRELATIONS,
  worker_recovery_refused: SUPERVISOR_CORRELATIONS,
  worker_retired: SUPERVISOR_CORRELATIONS,
};

function eventError(error: unknown): never {
  if (error instanceof AgentEventError) throw error;
  throw new AgentEventError(error instanceof Error ? error.message : String(error));
}

function assertId(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if ((value as string).length > MAX_ID_LENGTH) {
    throw new AgentEventError(`${label} exceeds ${MAX_ID_LENGTH} characters`);
  }
}

function assertString(value: unknown, label: string, maxLength = 32 * 1024): asserts value is string {
  if (typeof value !== "string") throw new AgentEventError(`${label} must be a string`);
  if (value.length > maxLength) throw new AgentEventError(`${label} exceeds ${maxLength} characters`);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentEventError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentEventError(`${label} must not be a class instance`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AgentEventError(`${label} contains unsupported field ${key}`);
  }
}

function assertOptionalId(value: unknown, label: string): void {
  if (value !== undefined) assertId(value, label);
}

function assertFiniteNonNegative(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new AgentEventError(`${label} must be a finite non-negative number`);
  }
}
function assertRequiredNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentEventError(`${label} must be a non-negative safe integer`);
  }
}

function assertBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") throw new AgentEventError(`${label} must be boolean`);
}

function assertEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AgentEventError(`${label} is unsupported`);
  }
}

function assertDelta(value: unknown, label: string): void {
  assertString(value, label, MAX_DELTA_BYTES);
  if (new TextEncoder().encode(value).byteLength > MAX_DELTA_BYTES) {
    throw new AgentEventError(`${label} exceeds ${MAX_DELTA_BYTES} UTF-8 bytes`);
  }
}

function validateCorrelationApplicability(value: Record<string, unknown>, kind: AgentEventKind): void {
  const allowed = CORRELATION_KEYS_BY_KIND[kind];
  for (const key of CORRELATION_KEYS) {
    if (value[key] !== undefined && !allowed.has(key)) {
      throw new EventCorrelationError(`${kind} does not allow ${key}`);
    }
  }
}

function validateEnvironmentReference(value: unknown, index: number): void {
  const label = `environment reference ${index}`;
  assertObject(value, label);
  assertAllowedKeys(
    value,
    new Set(["kind", "refId", "mediaType", "sha256", "byteLength", "width", "height", "label"]),
    label,
  );
  if (!["screenshot", "viewport", "codebase", "context"].includes(String(value.kind))) {
    throw new AgentEventError(`${label}.kind is unsupported`);
  }
  assertId(value.refId, `${label}.refId`);
  if (value.mediaType !== undefined) assertString(value.mediaType, `${label}.mediaType`, 256);
  if (value.sha256 !== undefined) {
    assertString(value.sha256, `${label}.sha256`, 64);
    if (!/^[a-f0-9]{64}$/u.test(value.sha256 as string)) {
      throw new AgentEventError(`${label}.sha256 must be lowercase SHA-256 hex`);
    }
  }
  assertFiniteNonNegative(value.byteLength, `${label}.byteLength`);
  assertFiniteNonNegative(value.width, `${label}.width`);
  assertFiniteNonNegative(value.height, `${label}.height`);
  if (value.label !== undefined) assertString(value.label, `${label}.label`, 1024);
}

function validatePlanStep(value: unknown, label: string): void {
  assertObject(value, label);
  assertAllowedKeys(value, new Set(["id", "content", "status"]), label);
  assertId(value.id, `${label}.id`);
  assertString(value.content, `${label}.content`);
  if (!["pending", "active", "completed", "failed", "canceled"].includes(String(value.status))) {
    throw new AgentEventError(`${label}.status is unsupported`);
  }
}

function validateData(kind: AgentEventKind, data: unknown): void {
  const label = `${kind}.data`;
  assertObject(data, label);
  assertAllowedKeys(data, DATA_KEYS[kind], label);
  switch (kind) {
    case "run_created":
    case "run_started":
      if (data.metadata !== undefined) normalizeJson(data.metadata, `${label}.metadata`);
      return;
    case "run_paused":
    case "run_canceled":
      assertString(data.reason, `${label}.reason`, 4096);
      return;
    case "run_resumed":
      if (data.reason !== undefined) assertString(data.reason, `${label}.reason`, 4096);
      return;
    case "run_completed":
      if (data.summary !== undefined) assertString(data.summary, `${label}.summary`);
      return;
    case "run_failed":
      assertString(data.error, `${label}.error`);
      return;
    case "user_message":
      assertString(data.content, `${label}.content`);
      return;
    case "assistant_message_start":
      if (data.role !== undefined && data.role !== "assistant") {
        throw new AgentEventError(`${label}.role must be assistant`);
      }
      return;
    case "assistant_message_delta":
      assertDelta(data.delta, `${label}.delta`);
      return;
    case "assistant_message_final":
      assertString(data.content, `${label}.content`);
      if (data.finishReason !== undefined) assertString(data.finishReason, `${label}.finishReason`, 1024);
      return;
    case "tool_call_start":
      assertId(data.name, `${label}.name`);
      return;
    case "tool_call_arguments_delta":
      assertDelta(data.delta, `${label}.delta`);
      return;
    case "tool_call_final":
      assertId(data.name, `${label}.name`);
      normalizeJson(data.arguments, `${label}.arguments`);
      return;
    case "tool_result":
      assertId(data.name, `${label}.name`);
      normalizeJson(data.result, `${label}.result`);
      assertFiniteNonNegative(data.elapsedMs, `${label}.elapsedMs`);
      return;
    case "tool_error":
      assertId(data.name, `${label}.name`);
      assertString(data.error, `${label}.error`);
      assertFiniteNonNegative(data.elapsedMs, `${label}.elapsedMs`);
      return;
    case "tool_canceled":
      assertId(data.name, `${label}.name`);
      assertString(data.reason, `${label}.reason`, 4096);
      return;
    case "environment_input":
      if (!Array.isArray(data.references) || data.references.length === 0) {
        throw new AgentEventError(`${label}.references must be a non-empty array`);
      }
      if (data.references.length > MAX_ENVIRONMENT_REFERENCES) {
        throw new AgentEventError(`${label}.references exceeds ${MAX_ENVIRONMENT_REFERENCES} entries`);
      }
      data.references.forEach(validateEnvironmentReference);
      if (data.description !== undefined) assertString(data.description, `${label}.description`, 4096);
      return;
    case "plan_started":
      if (data.title !== undefined) assertString(data.title, `${label}.title`, 4096);
      return;
    case "plan_updated":
      if (!Array.isArray(data.steps)) throw new AgentEventError(`${label}.steps must be an array`);
      if (data.steps.length > MAX_PLAN_STEPS) {
        throw new AgentEventError(`${label}.steps exceeds ${MAX_PLAN_STEPS} entries`);
      }
      data.steps.forEach((step, index) => validatePlanStep(step, `${label}.steps[${index}]`));
      return;
    case "plan_step_updated":
      validatePlanStep(data.step, `${label}.step`);
      return;
    case "plan_completed":
      assertString(data.summary, `${label}.summary`);
      return;
    case "worker_started":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.supervisorGenerationId, `${label}.supervisorGenerationId`);
      assertId(data.endpointId, `${label}.endpointId`);
      assertString(data.branch, `${label}.branch`, 1024);
      assertString(data.worktreePath, `${label}.worktreePath`, 4096);
      return;
    case "worker_stopped":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.supervisorGenerationId, `${label}.supervisorGenerationId`);
      assertId(data.endpointId, `${label}.endpointId`);
      if (data.reason !== undefined) assertString(data.reason, `${label}.reason`, 4096);
      return;
    case "worker_failed":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.supervisorGenerationId, `${label}.supervisorGenerationId`);
      if (data.endpointId !== undefined) assertId(data.endpointId, `${label}.endpointId`);
      assertString(data.error, `${label}.error`, 4096);
      return;
    case "runtime_endpoint_lost":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.supervisorGenerationId, `${label}.supervisorGenerationId`);
      assertId(data.endpointId, `${label}.endpointId`);
      assertEnum(data.state, ["missing", "unknown", "gone"], `${label}.state`);
      assertBoolean(data.absenceProven, `${label}.absenceProven`);
      if (data.state !== "gone" && data.absenceProven === true) {
        throw new AgentEventError(`${label}.absenceProven may only be true for gone state`);
      }
      return;
    case "progress_checkpoint_changed":
      assertId(data.taskId, `${label}.taskId`);
      assertString(data.sourceHead, `${label}.sourceHead`, 256);
      assertString(data.dirtyDigest, `${label}.dirtyDigest`, 512);
      assertRequiredNonNegativeInteger(data.sourceSequence, `${label}.sourceSequence`);
      return;
    case "worker_wait_started":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.waitId, `${label}.waitId`);
      assertId(data.operationId, `${label}.operationId`);
      assertString(data.reason, `${label}.reason`, 4096);
      assertTimestamp(data.validUntil, `${label}.validUntil`);
      return;
    case "worker_wait_ended":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.waitId, `${label}.waitId`);
      assertEnum(data.outcome, ["completed", "canceled", "expired", "failed"], `${label}.outcome`);
      return;
    case "worker_wedge_suspected":
      assertId(data.taskId, `${label}.taskId`);
      assertRequiredNonNegativeInteger(data.staleWindows, `${label}.staleWindows`);
      assertString(data.reason, `${label}.reason`, 4096);
      return;
    case "worker_stale_escalated":
      assertId(data.taskId, `${label}.taskId`);
      assertEnum(data.from, SUPERVISOR_STALE_EVENT_STATES, `${label}.from`);
      assertEnum(data.to, SUPERVISOR_STALE_EVENT_STATES, `${label}.to`);
      assertRequiredNonNegativeInteger(data.staleWindows, `${label}.staleWindows`);
      return;
    case "worker_recovery_started":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.recoveryId, `${label}.recoveryId`);
      if (data.priorEndpointId !== undefined) assertId(data.priorEndpointId, `${label}.priorEndpointId`);
      return;
    case "worker_recovery_completed":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.recoveryId, `${label}.recoveryId`);
      assertId(data.endpointId, `${label}.endpointId`);
      return;
    case "worker_recovery_refused":
      assertId(data.taskId, `${label}.taskId`);
      assertId(data.recoveryId, `${label}.recoveryId`);
      assertString(data.reason, `${label}.reason`, 4096);
      return;
    case "worker_retired":
      assertId(data.taskId, `${label}.taskId`);
      if (data.reason !== undefined) assertString(data.reason, `${label}.reason`, 4096);
      return;
  }
}

export function validateAgentEvent(value: unknown): asserts value is AgentEvent {
  try {
    assertObject(value, "event");
    assertAllowedKeys(value, EVENT_KEYS, "event");
    if (value.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
      throw new AgentEventError(`unsupported event schema version ${String(value.schemaVersion)}`);
    }
    assertId(value.id, "event.id");
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) {
      throw new AgentEventError("event.sequence must be a positive safe integer");
    }
    assertId(value.runId, "event.runId");
    assertId(value.sessionId, "event.sessionId");
    assertTimestamp(value.timestamp, "event.timestamp");
    if (typeof value.kind !== "string" || !KIND_SET.has(value.kind)) {
      throw new AgentEventError(`unsupported event kind ${String(value.kind)}`);
    }
    const kind = value.kind as AgentEventKind;
    assertOptionalId(value.turnId, "event.turnId");
    assertOptionalId(value.messageId, "event.messageId");
    assertOptionalId(value.toolCallId, "event.toolCallId");
    assertOptionalId(value.operationId, "event.operationId");
    assertOptionalId(value.transactionId, "event.transactionId");
    validateCorrelationApplicability(value, kind);

    if (MESSAGE_KINDS.has(kind) && (value.turnId === undefined || value.messageId === undefined)) {
      throw new EventCorrelationError(`${kind} requires turnId and messageId`);
    }
    if (TOOL_KINDS.has(kind)) {
      if (value.turnId === undefined || value.messageId === undefined || value.toolCallId === undefined) {
        throw new EventCorrelationError(`${kind} requires turnId, messageId, and toolCallId`);
      }
    }
    if (value.transactionId !== undefined && value.operationId === undefined) {
      throw new EventCorrelationError("transactionId requires operationId");
    }

    validateData(kind, value.data);
    const encoded = canonicalStringify(value);
    if (new TextEncoder().encode(encoded).byteLength > MAX_EVENT_BYTES) {
      throw new AgentEventError(`event exceeds ${MAX_EVENT_BYTES} UTF-8 bytes`);
    }
  } catch (error) {
    eventError(error);
  }
}

export function createAgentEvent<T extends AgentEventKind>(input: AgentEvent<T>): AgentEvent<T> {
  validateAgentEvent(input);
  return cloneJson(input) as AgentEvent<T>;
}

export function serializeAgentEvent(event: AgentEvent): string {
  validateAgentEvent(event);
  return canonicalStringify(event);
}

export function deserializeAgentEvent(encoded: string): AgentEvent {
  try {
    if (new TextEncoder().encode(encoded).byteLength > MAX_EVENT_BYTES) {
      throw new AgentEventError(`event exceeds ${MAX_EVENT_BYTES} UTF-8 bytes`);
    }
    const parsed = JSON.parse(encoded) as unknown;
    validateAgentEvent(parsed);
    return cloneJson(parsed) as AgentEvent;
  } catch (error) {
    eventError(error);
  }
}
