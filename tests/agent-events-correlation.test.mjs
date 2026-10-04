import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentEventError,
  EventCorrelationError,
  createAgentEvent,
} from "../packages/agent-events/src/index.ts";

const base = {
  schemaVersion: 1,
  sequence: 1,
  runId: "run-correlation",
  sessionId: "session-correlation",
  timestamp: "2026-10-03T19:00:00.000Z",
};

test("run events reject turn, message, tool, operation, and transaction correlation", () => {
  for (const [field, value] of [
    ["turnId", "turn-1"],
    ["messageId", "message-1"],
    ["toolCallId", "call-1"],
    ["operationId", "operation-1"],
    ["transactionId", "transaction-1"],
  ]) {
    assert.throws(
      () => createAgentEvent({
        ...base,
        id: `run-with-${field}`,
        kind: "run_created",
        [field]: value,
        data: {},
      }),
      EventCorrelationError,
    );
  }
});

test("message and streaming tool events reject unrelated correlation fields", () => {
  assert.throws(
    () => createAgentEvent({
      ...base,
      id: "message-with-operation",
      kind: "assistant_message_start",
      turnId: "turn-1",
      messageId: "message-1",
      operationId: "operation-1",
      data: {},
    }),
    EventCorrelationError,
  );
  assert.throws(
    () => createAgentEvent({
      ...base,
      id: "tool-start-with-transaction",
      kind: "tool_call_start",
      turnId: "turn-1",
      messageId: "message-1",
      toolCallId: "call-1",
      transactionId: "transaction-1",
      data: { name: "read" },
    }),
    EventCorrelationError,
  );
});

test("transaction correlation remains valid on finalized tool events only with operation identity", () => {
  assert.throws(
    () => createAgentEvent({
      ...base,
      id: "final-without-operation",
      kind: "tool_call_final",
      turnId: "turn-1",
      messageId: "message-1",
      toolCallId: "call-1",
      transactionId: "transaction-1",
      data: { name: "write_html", arguments: {} },
    }),
    AgentEventError,
  );
  const event = createAgentEvent({
    ...base,
    id: "final-with-transaction",
    kind: "tool_call_final",
    turnId: "turn-1",
    messageId: "message-1",
    toolCallId: "call-1",
    operationId: "operation-1",
    transactionId: "transaction-1",
    data: { name: "write_html", arguments: {} },
  });
  assert.equal(event.operationId, "operation-1");
  assert.equal(event.transactionId, "transaction-1");
});
