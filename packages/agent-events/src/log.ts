import { canonicalStringify, cloneJson } from "@ninerr/agent-runtime";
import { AgentEventError, EventSequenceError } from "./errors.ts";
import {
  AGENT_EVENT_KINDS,
  AGENT_EVENT_SCHEMA_VERSION,
  type AgentEvent,
  type AgentEventKind,
  validateAgentEvent,
} from "./events.ts";
import { replayAgentEvents, type AgentEventReplayState } from "./replay.ts";

export const MAX_EVENT_LOG_EVENTS = 10_000;
export const MAX_EVENT_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_PAGE_SIZE = 1_000;

export interface AgentEventLog {
  schemaVersion: number;
  runId: string;
  sessionId: string;
  events: AgentEvent[];
}

export interface EventQuery {
  afterSequence?: number;
  limit?: number;
  kinds?: AgentEventKind[];
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  operationId?: string;
  transactionId?: string;
}

export interface EventPage {
  events: AgentEvent[];
  nextAfter: number;
  more: boolean;
}

const EVENT_KIND_SET = new Set<string>(AGENT_EVENT_KINDS);
const LOG_KEYS = new Set(["schemaVersion", "runId", "sessionId", "events"]);

function validateLogIdentity(log: AgentEventLog): void {
  if (log === null || typeof log !== "object" || Array.isArray(log)) {
    throw new AgentEventError("event log must be an object");
  }
  const prototype = Object.getPrototypeOf(log);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentEventError("event log must not be a class instance");
  }
  for (const key of Object.keys(log)) {
    if (!LOG_KEYS.has(key)) throw new AgentEventError(`event log contains unsupported field ${key}`);
  }
  if (log.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    throw new AgentEventError(`unsupported event log schema version ${String(log.schemaVersion)}`);
  }
  if (typeof log.runId !== "string" || log.runId.trim() === "" || log.runId.length > 256) {
    throw new AgentEventError("event log runId must be a non-empty bounded string");
  }
  if (typeof log.sessionId !== "string" || log.sessionId.trim() === "" || log.sessionId.length > 256) {
    throw new AgentEventError("event log sessionId must be a non-empty bounded string");
  }
  if (!Array.isArray(log.events)) throw new AgentEventError("event log events must be an array");
  if (log.events.length > MAX_EVENT_LOG_EVENTS) {
    throw new AgentEventError(`event log exceeds ${MAX_EVENT_LOG_EVENTS} events`);
  }
}

function encodeBoundedLog(log: AgentEventLog): string {
  const encoded = canonicalStringify(log);
  if (new TextEncoder().encode(encoded).byteLength > MAX_EVENT_LOG_BYTES) {
    throw new AgentEventError(`encoded event log exceeds ${MAX_EVENT_LOG_BYTES} UTF-8 bytes`);
  }
  return encoded;
}

export function createAgentEventLog(runId: string, sessionId: string): AgentEventLog {
  const log: AgentEventLog = {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    runId,
    sessionId,
    events: [],
  };
  validateLogIdentity(log);
  return log;
}

export function appendAgentEvent(log: AgentEventLog, event: AgentEvent): AgentEventLog {
  validateLogIdentity(log);
  validateAgentEvent(event);
  if (log.events.length >= MAX_EVENT_LOG_EVENTS) {
    throw new AgentEventError(`event log cannot exceed ${MAX_EVENT_LOG_EVENTS} events`);
  }
  if (event.runId !== log.runId || event.sessionId !== log.sessionId) {
    throw new EventSequenceError("event runId/sessionId does not match the event log identity");
  }
  const expectedSequence = log.events.length + 1;
  if (event.sequence !== expectedSequence) {
    throw new EventSequenceError(
      `event sequence ${event.sequence} does not match expected sequence ${expectedSequence}`,
    );
  }
  const nextLog: AgentEventLog = {
    schemaVersion: log.schemaVersion,
    runId: log.runId,
    sessionId: log.sessionId,
    events: [...log.events, cloneJson(event)],
  };
  replayAgentEvents(nextLog.events);
  encodeBoundedLog(nextLog);
  return nextLog;
}

export function replayAgentEventLog(log: AgentEventLog): AgentEventReplayState | null {
  validateLogIdentity(log);
  if (log.events.length === 0) return null;
  return replayAgentEvents(log.events);
}

export function validateAgentEventLog(log: AgentEventLog): void {
  validateLogIdentity(log);
  if (log.events.length > 0) replayAgentEvents(log.events);
}

export function serializeAgentEventLog(log: AgentEventLog): string {
  validateAgentEventLog(log);
  return encodeBoundedLog(log);
}

export function deserializeAgentEventLog(encoded: string): AgentEventLog {
  if (typeof encoded !== "string") throw new AgentEventError("encoded event log must be a string");
  if (encoded.length > MAX_EVENT_LOG_BYTES) {
    throw new AgentEventError(`encoded event log exceeds ${MAX_EVENT_LOG_BYTES} characters`);
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_EVENT_LOG_BYTES) {
    throw new AgentEventError(`encoded event log exceeds ${MAX_EVENT_LOG_BYTES} UTF-8 bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new AgentEventError(`decode event log: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentEventError("decoded event log must be an object");
  }
  const log = parsed as AgentEventLog;
  validateAgentEventLog(log);
  encodeBoundedLog(log);
  return cloneJson(log);
}

function matchesQuery(event: AgentEvent, query: EventQuery): boolean {
  if (query.kinds !== undefined && !query.kinds.includes(event.kind)) return false;
  if (query.turnId !== undefined && event.turnId !== query.turnId) return false;
  if (query.messageId !== undefined && event.messageId !== query.messageId) return false;
  if (query.toolCallId !== undefined && event.toolCallId !== query.toolCallId) return false;
  if (query.operationId !== undefined && event.operationId !== query.operationId) return false;
  if (query.transactionId !== undefined && event.transactionId !== query.transactionId) return false;
  return true;
}

export function queryAgentEvents(log: AgentEventLog, query: EventQuery = {}): EventPage {
  validateAgentEventLog(log);
  const afterSequence = query.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new AgentEventError("afterSequence must be a non-negative safe integer");
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_EVENT_PAGE_SIZE) {
    throw new AgentEventError(`limit must be between 1 and ${MAX_EVENT_PAGE_SIZE}`);
  }
  if (query.kinds !== undefined) {
    if (!Array.isArray(query.kinds)) throw new AgentEventError("kinds must be an array");
    for (const kind of query.kinds) {
      if (typeof kind !== "string" || !EVENT_KIND_SET.has(kind)) {
        throw new AgentEventError(`unsupported query event kind ${String(kind)}`);
      }
    }
  }

  const matches = log.events.filter(
    (event) => event.sequence > afterSequence && matchesQuery(event, query),
  );
  const selected = matches.slice(0, limit).map((event) => cloneJson(event));
  const nextAfter = selected.length === 0
    ? afterSequence
    : selected[selected.length - 1].sequence;
  return {
    events: selected,
    nextAfter,
    more: matches.length > selected.length,
  };
}
