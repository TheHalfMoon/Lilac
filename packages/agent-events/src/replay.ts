import { canonicalStringify, cloneJson } from "@lilac/agent-runtime";
import { AgentEventError, EventCorrelationError } from "./errors.ts";
import { type AgentEvent, type AgentEventKind, type PlanStep, validateAgentEvent } from "./events.ts";

export type RunLifecycleState =
  | "none"
  | "created"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export interface AssistantReplayState {
  messageId: string;
  turnId: string;
  deltas: string[];
  finalized: boolean;
  content: string | null;
}

export interface ToolCallReplayState {
  toolCallId: string;
  messageId: string;
  turnId: string;
  name: string;
  argumentDeltas: string[];
  finalized: boolean;
  arguments: unknown;
  terminal: "result" | "error" | "canceled" | null;
  operationId: string | null;
  transactionId: string | null;
}

export interface PlanReplayState {
  active: boolean;
  completed: boolean;
  steps: Record<string, PlanStep>;
  summary: string | null;
}

export interface AgentEventReplayState {
  runId: string;
  sessionId: string;
  runStatus: RunLifecycleState;
  lastSequence: number;
  eventIds: string[];
  assistantMessages: Record<string, AssistantReplayState>;
  toolCalls: Record<string, ToolCallReplayState>;
  operationTransactions: Record<string, string>;
  plan: PlanReplayState;
}

const TERMINAL_RUN_STATES = new Set<RunLifecycleState>(["completed", "failed", "canceled"]);
const RUN_KINDS = new Set<AgentEventKind>([
  "run_created",
  "run_started",
  "run_paused",
  "run_resumed",
  "run_completed",
  "run_failed",
  "run_canceled",
]);

function correlationError(event: AgentEvent, message: string): never {
  throw new EventCorrelationError(`event ${event.id} (${event.kind}): ${message}`);
}

function requireRunning(state: AgentEventReplayState, event: AgentEvent): void {
  if (state.runStatus !== "running") {
    correlationError(event, `requires running state, current state is ${state.runStatus}`);
  }
}

function assertRunCompletionSettled(state: AgentEventReplayState, event: AgentEvent): void {
  for (const message of Object.values(state.assistantMessages)) {
    if (!message.finalized) correlationError(event, `assistant message ${message.messageId} is not finalized`);
  }
  for (const call of Object.values(state.toolCalls)) {
    if (!call.finalized) correlationError(event, `tool call ${call.toolCallId} is not finalized`);
    if (call.terminal === null) correlationError(event, `tool call ${call.toolCallId} has no terminal result`);
  }
  if (state.plan.active) correlationError(event, "active plan must finish before run_completed");
}

function validateRunTransition(state: AgentEventReplayState, event: AgentEvent): void {
  switch (event.kind) {
    case "run_created":
      if (state.runStatus !== "none") correlationError(event, "run_created must be first");
      state.runStatus = "created";
      return;
    case "run_started":
      if (state.runStatus !== "created") correlationError(event, "run_started requires created state");
      state.runStatus = "running";
      return;
    case "run_paused":
      if (state.runStatus !== "running") correlationError(event, "run_paused requires running state");
      state.runStatus = "paused";
      return;
    case "run_resumed":
      if (state.runStatus !== "paused") correlationError(event, "run_resumed requires paused state");
      state.runStatus = "running";
      return;
    case "run_completed":
      if (!["created", "running", "paused"].includes(state.runStatus)) {
        correlationError(event, `run_completed cannot follow ${state.runStatus}`);
      }
      assertRunCompletionSettled(state, event);
      state.runStatus = "completed";
      return;
    case "run_failed":
    case "run_canceled":
      if (!["created", "running", "paused"].includes(state.runStatus)) {
        correlationError(event, `${event.kind} cannot follow ${state.runStatus}`);
      }
      state.runStatus = event.kind === "run_failed" ? "failed" : "canceled";
      return;
  }
}

function validateOperationCorrelation(state: AgentEventReplayState, event: AgentEvent): void {
  if (event.operationId === undefined || event.transactionId === undefined) return;
  const knownTransaction = state.operationTransactions[event.operationId];
  if (knownTransaction !== undefined && knownTransaction !== event.transactionId) {
    correlationError(event, `operation ${event.operationId} is already bound to transaction ${knownTransaction}`);
  }
  state.operationTransactions[event.operationId] = event.transactionId;
}

function applyAssistantEvent(state: AgentEventReplayState, event: AgentEvent): void {
  if (!event.kind.startsWith("assistant_message_")) return;
  const messageId = event.messageId as string;
  const turnId = event.turnId as string;
  const current = state.assistantMessages[messageId];

  if (event.kind === "assistant_message_start") {
    if (current !== undefined) correlationError(event, `assistant message ${messageId} already exists`);
    state.assistantMessages[messageId] = {
      messageId,
      turnId,
      deltas: [],
      finalized: false,
      content: null,
    };
    return;
  }

  if (current === undefined) correlationError(event, `assistant message ${messageId} has not started`);
  if (current.turnId !== turnId) correlationError(event, `assistant message ${messageId} changed turnId`);
  if (current.finalized) correlationError(event, `assistant message ${messageId} is already finalized`);

  if (event.kind === "assistant_message_delta") {
    current.deltas.push((event.data as { delta: string }).delta);
    return;
  }

  const finalContent = (event.data as { content: string }).content;
  if (current.deltas.length !== 0 && current.deltas.join("") !== finalContent) {
    correlationError(event, `assistant message ${messageId} final content differs from streamed deltas`);
  }
  current.finalized = true;
  current.content = finalContent;
}

function assertToolArgumentsMatchDeltas(current: ToolCallReplayState, event: AgentEvent, value: unknown): void {
  if (current.argumentDeltas.length === 0) return;
  const accumulated = current.argumentDeltas.join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(accumulated);
  } catch {
    correlationError(event, `tool call ${current.toolCallId} argument deltas do not form valid JSON`);
  }
  if (canonicalStringify(parsed) !== canonicalStringify(value)) {
    correlationError(event, `tool call ${current.toolCallId} final arguments differ from streamed deltas`);
  }
}

function terminalStatus(kind: AgentEventKind): ToolCallReplayState["terminal"] {
  if (kind === "tool_result") return "result";
  if (kind === "tool_error") return "error";
  if (kind === "tool_canceled") return "canceled";
  throw new AgentEventError(`event kind ${kind} is not a terminal tool event`);
}

function applyToolEvent(state: AgentEventReplayState, event: AgentEvent): void {
  if (!event.kind.startsWith("tool_")) return;
  const toolCallId = event.toolCallId as string;
  const messageId = event.messageId as string;
  const turnId = event.turnId as string;
  const current = state.toolCalls[toolCallId];

  if (event.kind === "tool_call_start") {
    if (current !== undefined) correlationError(event, `tool call ${toolCallId} already exists`);
    const assistant = state.assistantMessages[messageId];
    if (assistant === undefined) correlationError(event, `owning assistant message ${messageId} has not started`);
    if (assistant.turnId !== turnId) correlationError(event, `tool call ${toolCallId} changed turnId`);
    state.toolCalls[toolCallId] = {
      toolCallId,
      messageId,
      turnId,
      name: (event.data as { name: string }).name,
      argumentDeltas: [],
      finalized: false,
      arguments: null,
      terminal: null,
      operationId: null,
      transactionId: null,
    };
    return;
  }

  if (current === undefined) correlationError(event, `tool call ${toolCallId} has not started`);
  if (current.messageId !== messageId || current.turnId !== turnId) {
    correlationError(event, `tool call ${toolCallId} changed message or turn correlation`);
  }

  if (event.kind === "tool_call_arguments_delta") {
    if (current.finalized) correlationError(event, `tool call ${toolCallId} is already finalized`);
    current.argumentDeltas.push((event.data as { delta: string }).delta);
    return;
  }

  if (event.kind === "tool_call_final") {
    if (current.finalized) correlationError(event, `tool call ${toolCallId} is already finalized`);
    const data = event.data as { name: string; arguments: unknown };
    if (data.name !== current.name) correlationError(event, `tool call ${toolCallId} changed tool name`);
    assertToolArgumentsMatchDeltas(current, event, data.arguments);
    current.finalized = true;
    current.arguments = cloneJson(data.arguments);
    current.operationId = event.operationId ?? null;
    current.transactionId = event.transactionId ?? null;
    return;
  }

  if (!current.finalized) correlationError(event, `tool call ${toolCallId} must be finalized before terminal output`);
  if (current.terminal !== null) correlationError(event, `tool call ${toolCallId} already has terminal output`);
  const terminalData = event.data as { name: string };
  if (terminalData.name !== current.name) correlationError(event, `tool call ${toolCallId} changed tool name`);
  if (event.operationId !== undefined && current.operationId !== null && event.operationId !== current.operationId) {
    correlationError(event, `tool call ${toolCallId} changed operationId`);
  }
  if (event.transactionId !== undefined && current.transactionId !== null && event.transactionId !== current.transactionId) {
    correlationError(event, `tool call ${toolCallId} changed transactionId`);
  }
  current.operationId = event.operationId ?? current.operationId;
  current.transactionId = event.transactionId ?? current.transactionId;
  current.terminal = terminalStatus(event.kind);
}

function applyPlanEvent(state: AgentEventReplayState, event: AgentEvent): void {
  switch (event.kind) {
    case "plan_started":
      if (state.plan.active || state.plan.completed) correlationError(event, "plan already started");
      state.plan.active = true;
      return;
    case "plan_updated": {
      if (!state.plan.active) correlationError(event, "plan_update requires an active plan");
      const next: Record<string, PlanStep> = Object.create(null) as Record<string, PlanStep>;
      for (const step of (event.data as { steps: PlanStep[] }).steps) {
        if (next[step.id] !== undefined) correlationError(event, `plan repeats step ${step.id}`);
        next[step.id] = cloneJson(step);
      }
      state.plan.steps = next;
      return;
    }
    case "plan_step_updated": {
      if (!state.plan.active) correlationError(event, "plan_step_updated requires an active plan");
      const step = (event.data as { step: PlanStep }).step;
      if (state.plan.steps[step.id] === undefined) correlationError(event, `plan step ${step.id} is unknown`);
      state.plan.steps[step.id] = cloneJson(step);
      return;
    }
    case "plan_completed":
      if (!state.plan.active) correlationError(event, "plan_completed requires an active plan");
      state.plan.active = false;
      state.plan.completed = true;
      state.plan.summary = (event.data as { summary: string }).summary;
      return;
  }
}

export function createReplayState(runId: string, sessionId: string): AgentEventReplayState {
  return {
    runId,
    sessionId,
    runStatus: "none",
    lastSequence: 0,
    eventIds: [],
    assistantMessages: Object.create(null) as Record<string, AssistantReplayState>,
    toolCalls: Object.create(null) as Record<string, ToolCallReplayState>,
    operationTransactions: Object.create(null) as Record<string, string>,
    plan: {
      active: false,
      completed: false,
      steps: Object.create(null) as Record<string, PlanStep>,
      summary: null,
    },
  };
}

export function replayAgentEvents(events: readonly AgentEvent[]): AgentEventReplayState {
  if (events.length === 0) throw new AgentEventError("event replay requires at least one event");
  const first = events[0];
  validateAgentEvent(first);
  const state = createReplayState(first.runId, first.sessionId);
  const ids = new Set<string>();

  for (const event of events) {
    validateAgentEvent(event);
    if (event.runId !== state.runId || event.sessionId !== state.sessionId) {
      correlationError(event, "runId/sessionId differs from the event log identity");
    }
    if (event.sequence !== state.lastSequence + 1) {
      correlationError(event, `sequence ${event.sequence} is not contiguous after ${state.lastSequence}`);
    }
    if (ids.has(event.id)) correlationError(event, `event id ${event.id} is duplicated`);
    if (TERMINAL_RUN_STATES.has(state.runStatus)) {
      correlationError(event, `event appears after terminal run state ${state.runStatus}`);
    }

    if (RUN_KINDS.has(event.kind)) {
      validateRunTransition(state, event);
    } else {
      requireRunning(state, event);
      applyAssistantEvent(state, event);
      applyToolEvent(state, event);
      applyPlanEvent(state, event);
    }

    validateOperationCorrelation(state, event);
    ids.add(event.id);
    state.eventIds.push(event.id);
    state.lastSequence = event.sequence;
  }

  return cloneJson(state);
}
