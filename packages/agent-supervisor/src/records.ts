import { assertTimestamp, canonicalStringify, cloneJson, normalizeJson } from "@lilac/agent-runtime";
import { SupervisorRecordError } from "./errors.ts";
import {
  MAX_PATH_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SUPERVISOR_ID_LENGTH,
  MAX_TASK_RECORD_BYTES,
  SUPERVISOR_SCHEMA_VERSION,
  type DeclaredWait,
  type DirtyStateCheckpoint,
  type ProgressCheckpoint,
  type RuntimeEndpointIdentity,
  type SourceIdentity,
  type StaleEscalationState,
  type StaleState,
  type SupervisedTaskRecord,
  type SupervisorLease,
  type WorkerLifecycleState,
} from "./types.ts";

const TASK_KEYS = new Set([
  "version", "taskId", "source", "checkpoint", "runtimeProfileId", "endpoint", "lifecycle",
  "lease", "lastProgress", "declaredWait", "wakeCursor", "stale", "createdAt", "updatedAt", "metadata",
]);
const SOURCE_KEYS = new Set(["repositoryId", "branch", "worktreePath", "creationHead"]);
const CHECKPOINT_KEYS = new Set(["head", "dirty", "digest", "recordedAt"]);
const ENDPOINT_KEYS = new Set(["endpointId", "backend", "attachedAt"]);
const LEASE_KEYS = new Set(["ownerId", "generationId", "claimedAt"]);
const PROGRESS_KEYS = new Set(["sourceHead", "dirtyDigest", "eventSequence", "recordedAt"]);
const WAIT_KEYS = new Set(["waitId", "operationId", "reason", "startedAt", "validUntil"]);
const STALE_KEYS = new Set(["state", "staleWindows", "lastTransitionAt", "lastEmittedState"]);

const LIFECYCLES = new Set<WorkerLifecycleState>([
  "created", "starting", "running", "waiting", "stopped", "failed", "recovering", "retired",
]);
const STALE_STATES = new Set<StaleEscalationState>([
  "healthy", "stale-suspected", "stale-confirmed", "recovery-requested", "recovering", "recovered",
  "recovery-refused", "terminal-failure",
]);

function fail(message: string): never {
  throw new SupervisorRecordError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  for (const key of allowed) if (!(key in value)) fail(`${label} is missing field ${key}`);
}

function string(value: unknown, label: string, max = MAX_SUPERVISOR_ID_LENGTH): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  if (value.length > max) fail(`${label} exceeds ${max} characters`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  try {
    assertTimestamp(value, label);
  } catch (error) {
    fail(error instanceof Error ? error.message : `${label} must be a timestamp`);
  }
  return value as string;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`);
  return value as number;
}

function source(value: unknown): SourceIdentity {
  const input = object(value, "task.source");
  keys(input, SOURCE_KEYS, "task.source");
  return {
    repositoryId: string(input.repositoryId, "task.source.repositoryId"),
    branch: string(input.branch, "task.source.branch"),
    worktreePath: string(input.worktreePath, "task.source.worktreePath", MAX_PATH_LENGTH),
    creationHead: string(input.creationHead, "task.source.creationHead"),
  };
}

function checkpoint(value: unknown): DirtyStateCheckpoint {
  const input = object(value, "task.checkpoint");
  keys(input, CHECKPOINT_KEYS, "task.checkpoint");
  if (typeof input.dirty !== "boolean") fail("task.checkpoint.dirty must be boolean");
  return {
    head: string(input.head, "task.checkpoint.head"),
    dirty: input.dirty,
    digest: string(input.digest, "task.checkpoint.digest", 512),
    recordedAt: timestamp(input.recordedAt, "task.checkpoint.recordedAt"),
  };
}

function endpoint(value: unknown): RuntimeEndpointIdentity | null {
  if (value === null) return null;
  const input = object(value, "task.endpoint");
  keys(input, ENDPOINT_KEYS, "task.endpoint");
  if (input.backend !== "local-process") fail("task.endpoint.backend must be local-process");
  return {
    endpointId: string(input.endpointId, "task.endpoint.endpointId"),
    backend: "local-process",
    attachedAt: timestamp(input.attachedAt, "task.endpoint.attachedAt"),
  };
}

function lease(value: unknown): SupervisorLease | null {
  if (value === null) return null;
  const input = object(value, "task.lease");
  keys(input, LEASE_KEYS, "task.lease");
  return {
    ownerId: string(input.ownerId, "task.lease.ownerId"),
    generationId: string(input.generationId, "task.lease.generationId"),
    claimedAt: timestamp(input.claimedAt, "task.lease.claimedAt"),
  };
}
function progress(value: unknown): ProgressCheckpoint | null {
  if (value === null) return null;
  const input = object(value, "task.lastProgress");
  keys(input, PROGRESS_KEYS, "task.lastProgress");
  return {
    sourceHead: string(input.sourceHead, "task.lastProgress.sourceHead"),
    dirtyDigest: string(input.dirtyDigest, "task.lastProgress.dirtyDigest", 512),
    eventSequence: nonNegativeInteger(input.eventSequence, "task.lastProgress.eventSequence"),
    recordedAt: timestamp(input.recordedAt, "task.lastProgress.recordedAt"),
  };
}

function declaredWait(value: unknown): DeclaredWait | null {
  if (value === null) return null;
  const input = object(value, "task.declaredWait");
  keys(input, WAIT_KEYS, "task.declaredWait");
  const startedAt = timestamp(input.startedAt, "task.declaredWait.startedAt");
  const validUntil = timestamp(input.validUntil, "task.declaredWait.validUntil");
  if (Date.parse(validUntil) < Date.parse(startedAt)) fail("task.declaredWait.validUntil precedes startedAt");
  return {
    waitId: string(input.waitId, "task.declaredWait.waitId"),
    operationId: string(input.operationId, "task.declaredWait.operationId"),
    reason: string(input.reason, "task.declaredWait.reason", MAX_REASON_LENGTH),
    startedAt,
    validUntil,
  };
}

function stale(value: unknown): StaleState {
  const input = object(value, "task.stale");
  keys(input, STALE_KEYS, "task.stale");
  if (typeof input.state !== "string" || !STALE_STATES.has(input.state as StaleEscalationState)) {
    fail("task.stale.state is unsupported");
  }
  if (input.lastEmittedState !== null
      && (typeof input.lastEmittedState !== "string"
        || !STALE_STATES.has(input.lastEmittedState as StaleEscalationState))) {
    fail("task.stale.lastEmittedState is unsupported");
  }
  return {
    state: input.state as StaleEscalationState,
    staleWindows: nonNegativeInteger(input.staleWindows, "task.stale.staleWindows"),
    lastTransitionAt: timestamp(input.lastTransitionAt, "task.stale.lastTransitionAt"),
    lastEmittedState: input.lastEmittedState as StaleEscalationState | null,
  };
}

export function validateTaskRecord(value: unknown): asserts value is SupervisedTaskRecord {
  const input = object(value, "task");
  keys(input, TASK_KEYS, "task");
  if (input.version !== SUPERVISOR_SCHEMA_VERSION) fail(`unsupported task record version ${String(input.version)}`);
  const lifecycle = input.lifecycle;
  if (typeof lifecycle !== "string" || !LIFECYCLES.has(lifecycle as WorkerLifecycleState)) {
    fail("task.lifecycle is unsupported");
  }
  const createdAt = timestamp(input.createdAt, "task.createdAt");
  const updatedAt = timestamp(input.updatedAt, "task.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("task.updatedAt precedes task.createdAt");
  source(input.source);
  checkpoint(input.checkpoint);
  endpoint(input.endpoint);
  lease(input.lease);
  progress(input.lastProgress);
  declaredWait(input.declaredWait);
  stale(input.stale);
  string(input.taskId, "task.taskId");
  string(input.runtimeProfileId, "task.runtimeProfileId");
  nonNegativeInteger(input.wakeCursor, "task.wakeCursor");
  if (input.metadata !== null) {
    try {
      normalizeJson(input.metadata, "task.metadata");
    } catch (error) {
      fail(error instanceof Error ? error.message : "task.metadata must be JSON-safe");
    }
  }
}

export function normalizeTaskRecord(value: unknown): SupervisedTaskRecord {
  validateTaskRecord(value);
  const input = value as SupervisedTaskRecord;
  return {
    version: SUPERVISOR_SCHEMA_VERSION,
    taskId: input.taskId,
    source: source(input.source),
    checkpoint: checkpoint(input.checkpoint),
    runtimeProfileId: input.runtimeProfileId,
    endpoint: endpoint(input.endpoint),
    lifecycle: input.lifecycle,
    lease: lease(input.lease),
    lastProgress: progress(input.lastProgress),
    declaredWait: declaredWait(input.declaredWait),
    wakeCursor: input.wakeCursor,
    stale: stale(input.stale),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    metadata: input.metadata === null ? null : normalizeJson(input.metadata, "task.metadata"),
  };
}

function assertTaskRecordSize(encoded: string): void {
  if (new TextEncoder().encode(encoded).byteLength > MAX_TASK_RECORD_BYTES) {
    fail(`task record exceeds ${MAX_TASK_RECORD_BYTES} bytes`);
  }
}

export function serializeTaskRecord(value: unknown): string {
  const encoded = canonicalStringify(normalizeTaskRecord(value));
  assertTaskRecordSize(encoded);
  return encoded;
}

export function deserializeTaskRecord(encoded: string): SupervisedTaskRecord {
  assertTaskRecordSize(encoded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    fail("task record is not valid JSON");
  }
  return cloneJson(normalizeTaskRecord(parsed));
}