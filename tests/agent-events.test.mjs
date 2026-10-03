import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AgentEventBus,
  AgentEventError,
  EventCorrelationError,
  EventSequenceError,
  HandlerRegistrationError,
  UI_TARS_EVENT_PROVENANCE,
  appendAgentEvent,
  createAgentEvent,
  createAgentEventLog,
  deserializeAgentEventLog,
  queryAgentEvents,
  replayAgentEventLog,
  serializeAgentEvent,
  serializeAgentEventLog,
} from "../packages/agent-events/src/index.ts";

const runId = "run-1";
const sessionId = "session-1";
const timestamp = "2026-10-03T19:00:00.000Z";

function event(sequence, kind, data = {}, correlations = {}) {
  return createAgentEvent({
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: `event-${sequence}`,
    sequence,
    runId,
    sessionId,
    timestamp,
    kind,
    ...correlations,
    data,
  });
}

function runningLog() {
  let log = createAgentEventLog(runId, sessionId);
  log = appendAgentEvent(log, event(1, "run_created"));
  log = appendAgentEvent(log, event(2, "run_started"));
  return log;
}

const assistant = {
  turnId: "turn-1",
  messageId: "message-1",
};

const tool = {
  ...assistant,
  toolCallId: "tool-call-1",
};

test("pins the exact UI-TARS donor revision and Apache posture", () => {
  assert.deepEqual(UI_TARS_EVENT_PROVENANCE, {
    repository: "bytedance/UI-TARS-desktop",
    revision: "2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a",
    license: "Apache-2.0",
    posture: "bounded-adaptation",
  });
});

test("event creation is caller-owned and canonical serialization is deterministic", () => {
  const first = event(1, "run_created", { metadata: { z: 1, a: true } });
  const second = createAgentEvent({
    data: { metadata: { a: true, z: 1 } },
    kind: "run_created",
    timestamp,
    sessionId,
    runId,
    sequence: 1,
    id: "event-1",
    schemaVersion: 1,
  });
  assert.equal(serializeAgentEvent(first), serializeAgentEvent(second));
  assert.throws(
    () => createAgentEvent({ schemaVersion: 1, runId, sessionId, kind: "run_created", data: {} }),
    AgentEventError,
  );
});

test("event logs require contiguous per-run sequence and valid lifecycle", () => {
  let log = runningLog();
  assert.throws(
    () => appendAgentEvent(log, event(4, "user_message", { content: "hi" }, assistant)),
    EventSequenceError,
  );
  log = appendAgentEvent(log, event(3, "run_paused", { reason: "review" }));
  log = appendAgentEvent(log, event(4, "run_resumed"));
  log = appendAgentEvent(log, event(5, "run_completed", { summary: "done" }));
  assert.equal(replayAgentEventLog(log).runStatus, "completed");
  assert.throws(
    () => appendAgentEvent(log, event(6, "run_started")),
    EventCorrelationError,
  );
});

test("assistant streaming requires start, allows deltas, finalizes once, and rejects later deltas", () => {
  let log = runningLog();
  assert.throws(
    () => appendAgentEvent(log, event(3, "assistant_message_delta", { delta: "x" }, assistant)),
    EventCorrelationError,
  );
  log = appendAgentEvent(log, event(3, "assistant_message_start", {}, assistant));
  log = appendAgentEvent(log, event(4, "assistant_message_delta", { delta: "hel" }, assistant));
  log = appendAgentEvent(log, event(5, "assistant_message_delta", { delta: "lo" }, assistant));
  log = appendAgentEvent(log, event(6, "assistant_message_final", { content: "hello" }, assistant));
  const replay = replayAgentEventLog(log);
  assert.deepEqual(replay.assistantMessages[assistant.messageId].deltas, ["hel", "lo"]);
  assert.equal(replay.assistantMessages[assistant.messageId].content, "hello");
  assert.throws(
    () => appendAgentEvent(log, event(7, "assistant_message_delta", { delta: "!" }, assistant)),
    EventCorrelationError,
  );
});

test("tool calls require finalized invocation before one terminal result", () => {
  let log = runningLog();
  log = appendAgentEvent(log, event(3, "assistant_message_start", {}, assistant));
  log = appendAgentEvent(log, event(4, "tool_call_start", { name: "write_html" }, tool));
  assert.throws(
    () => appendAgentEvent(log, event(5, "tool_result", { name: "write_html", result: {} }, tool)),
    EventCorrelationError,
  );
  log = appendAgentEvent(log, event(5, "tool_call_arguments_delta", { delta: "{\"html\":" }, tool));
  log = appendAgentEvent(
    log,
    event(6, "tool_call_final", { name: "write_html", arguments: { html: "<p>ok</p>" } }, {
      ...tool,
      operationId: "operation-1",
    }),
  );
  log = appendAgentEvent(
    log,
    event(7, "tool_result", { name: "write_html", result: { ok: true }, elapsedMs: 4 }, {
      ...tool,
      operationId: "operation-1",
      transactionId: "transaction-1",
    }),
  );
  const replay = replayAgentEventLog(log);
  assert.equal(replay.toolCalls[tool.toolCallId].terminal, "result");
  assert.equal(replay.operationTransactions["operation-1"], "transaction-1");
  assert.throws(
    () => appendAgentEvent(
      log,
      event(8, "tool_error", { name: "write_html", error: "late" }, tool),
    ),
    EventCorrelationError,
  );
});

test("an operation cannot be correlated to two Lilac transactions", () => {
  let log = runningLog();
  log = appendAgentEvent(log, event(3, "assistant_message_start", {}, assistant));
  log = appendAgentEvent(log, event(4, "tool_call_start", { name: "first" }, tool));
  log = appendAgentEvent(log, event(5, "tool_call_final", { name: "first", arguments: {} }, {
    ...tool,
    operationId: "operation-shared",
    transactionId: "transaction-a",
  }));
  const tool2 = { ...assistant, toolCallId: "tool-call-2" };
  log = appendAgentEvent(log, event(6, "tool_call_start", { name: "second" }, tool2));
  assert.throws(
    () => appendAgentEvent(log, event(7, "tool_call_final", { name: "second", arguments: {} }, {
      ...tool2,
      operationId: "operation-shared",
      transactionId: "transaction-b",
    })),
    EventCorrelationError,
  );
});

test("plan lifecycle rejects unknown step updates and replays canonical step state", () => {
  let log = runningLog();
  log = appendAgentEvent(log, event(3, "plan_started", { title: "Polish" }));
  assert.throws(
    () => appendAgentEvent(log, event(4, "plan_step_updated", {
      step: { id: "step-1", content: "Fix", status: "active" },
    })),
    EventCorrelationError,
  );
  log = appendAgentEvent(log, event(4, "plan_updated", {
    steps: [{ id: "step-1", content: "Fix", status: "pending" }],
  }));
  log = appendAgentEvent(log, event(5, "plan_step_updated", {
    step: { id: "step-1", content: "Fix", status: "completed" },
  }));
  log = appendAgentEvent(log, event(6, "plan_completed", { summary: "Finished" }));
  const replay = replayAgentEventLog(log);
  assert.equal(replay.plan.steps["step-1"].status, "completed");
  assert.equal(replay.plan.summary, "Finished");
});

test("environment input accepts bounded references and rejects hidden raw payload fields", () => {
  const good = event(3, "environment_input", {
    references: [{
      kind: "screenshot",
      refId: "artifact-1",
      mediaType: "image/png",
      sha256: "a".repeat(64),
      byteLength: 1200,
      width: 800,
      height: 600,
    }],
  });
  assert.equal(good.data.references[0].refId, "artifact-1");
  assert.throws(
    () => createAgentEvent({
      schemaVersion: 1,
      id: "bad-env",
      sequence: 3,
      runId,
      sessionId,
      timestamp,
      kind: "environment_input",
      data: { references: [{ kind: "context", refId: "x" }], content: "raw secret blob" },
    }),
    /unsupported field content/u,
  );
});

test("unknown envelope fields and oversized streaming deltas fail closed", () => {
  assert.throws(
    () => createAgentEvent({
      schemaVersion: 1,
      id: "event-1",
      sequence: 1,
      runId,
      sessionId,
      timestamp,
      kind: "run_created",
      hidden: "nope",
      data: {},
    }),
    /unsupported field hidden/u,
  );
  assert.throws(
    () => event(3, "assistant_message_delta", { delta: "x".repeat(17 * 1024) }, assistant),
    AgentEventError,
  );
});

test("event log serialization round-trips and filtered pagination is bounded", () => {
  let log = runningLog();
  log = appendAgentEvent(log, event(3, "user_message", { content: "one" }, {
    turnId: "turn-1",
    messageId: "user-1",
  }));
  log = appendAgentEvent(log, event(4, "user_message", { content: "two" }, {
    turnId: "turn-2",
    messageId: "user-2",
  }));
  const encoded = serializeAgentEventLog(log);
  assert.equal(serializeAgentEventLog(deserializeAgentEventLog(encoded)), encoded);
  const page = queryAgentEvents(log, { kinds: ["user_message"], limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].sequence, 3);
  assert.equal(page.more, true);
  const next = queryAgentEvents(log, { kinds: ["user_message"], afterSequence: page.nextAfter, limit: 1 });
  assert.equal(next.events[0].sequence, 4);
  assert.equal(next.more, false);
});

test("event bus freezes snapshots and isolates handler failures", async () => {
  const bus = new AgentEventBus();
  const received = [];
  bus.register({
    id: "mutator",
    handle(snapshot) {
      snapshot.data.metadata = { corrupted: true };
    },
  });
  bus.register({
    id: "observer",
    async handle(snapshot) {
      received.push(serializeAgentEvent(snapshot));
    },
  });
  const committed = event(1, "run_created", { metadata: { safe: true } });
  const result = await bus.dispatch(committed);
  assert.deepEqual(result.deliveries.map((entry) => entry.status), ["failed", "delivered"]);
  assert.equal(received.length, 1);
  assert.equal(committed.data.metadata.safe, true);
});

test("event bus registration is deterministic and identity-based", () => {
  const bus = new AgentEventBus();
  const handler = { id: "handler-a", kinds: ["run_created"], handle() {} };
  bus.register(handler);
  assert.deepEqual(bus.handlerIds(), ["handler-a"]);
  assert.throws(() => bus.register(handler), HandlerRegistrationError);
  assert.equal(bus.unregister("handler-a"), true);
  assert.deepEqual(bus.handlerIds(), []);
});
