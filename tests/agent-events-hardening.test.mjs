import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentEventBus,
  AgentEventError,
  appendAgentEvent,
  createAgentEvent,
} from "../packages/agent-events/src/index.ts";

const runId = "run-hardening";
const sessionId = "session-hardening";
const timestamp = "2026-10-03T20:40:00.000Z";

function event(sequence, kind, data = {}, correlations = {}) {
  return createAgentEvent({
    schemaVersion: 1,
    id: `hardening-event-${sequence}`,
    sequence,
    runId,
    sessionId,
    timestamp,
    kind,
    ...correlations,
    data,
  });
}

test("append rejects event logs that exceed the serialized byte bound", () => {
  const events = [
    event(1, "run_created"),
    event(2, "run_started"),
  ];
  const content = "x".repeat(60 * 1024);
  for (let sequence = 3; sequence <= 276; sequence += 1) {
    events.push(event(
      sequence,
      "user_message",
      { content },
      { turnId: `turn-${sequence}`, messageId: `message-${sequence}` },
    ));
  }
  const oversizedLog = {
    schemaVersion: 1,
    runId,
    sessionId,
    events,
  };
  assert.throws(
    () => appendAgentEvent(
      oversizedLog,
      event(277, "user_message", { content: "next" }, {
        turnId: "turn-277",
        messageId: "message-277",
      }),
    ),
    AgentEventError,
  );
});

test("event bus isolates handlers that throw unprintable values", async () => {
  const bus = new AgentEventBus();
  let observerCalled = false;
  bus.register({
    id: "hostile-error",
    handle() {
      throw {
        toString() {
          throw new Error("stringification must not escape handler isolation");
        },
      };
    },
  });
  bus.register({
    id: "observer",
    handle() {
      observerCalled = true;
    },
  });

  const result = await bus.dispatch(event(1, "run_created"));
  assert.equal(observerCalled, true);
  assert.deepEqual(result.deliveries.map((delivery) => delivery.status), ["failed", "delivered"]);
  assert.equal(result.deliveries[0].error, "handler threw an unprintable value");
});
