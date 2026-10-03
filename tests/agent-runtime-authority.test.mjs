import assert from "node:assert/strict";
import test from "node:test";

import * as agentRuntime from "../packages/agent-runtime/src/index.ts";
import {
  AgentRuntimeError,
  createOperation,
  createSession,
  deserializeSessionLog,
  serializeSessionLog,
} from "../packages/agent-runtime/src/index.ts";

const T0 = "2026-10-03T18:00:00.000Z";

function authority(overrides = {}) {
  return {
    documentAffecting: true,
    actorId: "agent:writer",
    intent: "Edit the selected design",
    capabilityId: "capability:document-edit",
    toolId: "tool:document-edit",
    affectedNodeIds: [],
    affectedSourceIds: [],
    transactionId: null,
    ...overrides,
  };
}

test("new operations cannot spoof a pre-bound Lilac transaction", () => {
  assert.throws(
    () => createOperation({
      id: "op-prebound",
      type: "lilac.document.request",
      authority: authority({ transactionId: "tx-spoofed" }),
    }),
    /cannot start bound to a Lilac transaction/,
  );
});

test("the transaction-binding checkpoint is not exposed by the public package API", () => {
  assert.equal("bindOperationTransaction" in agentRuntime, false);
});

test("malformed item records fail as AgentRuntimeError instead of escaping as TypeError", () => {
  const session = createSession({ id: "session-malformed", createdAt: T0 });
  const encoded = `${serializeSessionLog(session)}{"type":"item"}\n`;
  assert.throws(() => deserializeSessionLog(encoded), AgentRuntimeError);
});
