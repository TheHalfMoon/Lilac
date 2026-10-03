import assert from "node:assert/strict";
import test from "node:test";

import { createDocument, createNode } from "../packages/document-model/src/index.mjs";
import { createHistoryState } from "../packages/history/src/index.mjs";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  AgentRuntimeError,
  IdempotencyConflictError,
  OperationTransitionError,
  UNREAL_AGENT_PROVENANCE,
  appendInput,
  appendModelResponse,
  appendToolCallStatus,
  appendTurn,
  canonicalStringify,
  commitDocumentOperation,
  createOperation,
  createSession,
  deserializeSessionLog,
  failOperation,
  forkSession,
  getOperation,
  markOperationCanceled,
  requestOperationCancellation,
  resumeSession,
  saveOperation,
  serializeSessionLog,
  translateToolCall,
  updateOperation,
} from "../packages/agent-runtime/src/index.ts";

const T0 = "2026-10-03T18:00:00.000Z";
const T1 = "2026-10-03T18:00:01.000Z";
const T2 = "2026-10-03T18:00:02.000Z";
const T3 = "2026-10-03T18:00:03.000Z";
const T4 = "2026-10-03T18:00:04.000Z";
const T5 = "2026-10-03T18:00:05.000Z";

function authority(overrides = {}) {
  return {
    documentAffecting: false,
    actorId: "agent:ui",
    intent: "Inspect and improve the selected surface",
    capabilityId: "capability:design-edit",
    toolId: "tool:canvas",
    affectedNodeIds: [],
    affectedSourceIds: [],
    transactionId: null,
    ...overrides,
  };
}

function operation(id = "op-1", overrides = {}) {
  return createOperation({
    id,
    type: "lilac.test",
    version: 1,
    status: "ready",
    state: { phase: "queued" },
    idempotency: { requestId: `request:${id}` },
    authority: authority(),
    ...overrides,
  });
}

function sessionWithTurn() {
  let session = createSession({ id: "session-1", createdAt: T0 });
  session = appendInput(
    session,
    { id: "input-1", kind: "external", payload: { prompt: "Make it clearer" } },
    { recordedAt: T1 },
  ).session;
  session = appendTurn(
    session,
    { id: "turn-1", previousTurnId: null, metadata: { model: "local" } },
    { recordedAt: T2 },
  );
  return session;
}

function sessionWithOperation(op = operation()) {
  let session = sessionWithTurn();
  session = appendToolCallStatus(
    session,
    {
      turnId: "turn-1",
      callId: "call-1",
      error: null,
      waitingFor: [op.id],
      operationSnapshots: [op],
    },
    { recordedAt: T3 },
  );
  return session;
}

test("pins the Unreal Agent donor revision and Lilac schema", () => {
  assert.equal(AGENT_RUNTIME_SCHEMA_VERSION, 1);
  assert.deepEqual(UNREAL_AGENT_PROVENANCE, {
    repository: "unreallabsai/unreal-agent",
    revision: "1b9f778453f411c029b39b85102aaefb95e7e48d",
    license: "MIT",
    posture: "semantic-port",
  });
});

test("canonical JSON and session logs round-trip deterministically", () => {
  const session = sessionWithOperation();
  const encoded = serializeSessionLog(session);
  const decoded = deserializeSessionLog(encoded);
  assert.deepEqual(decoded, session);
  assert.equal(serializeSessionLog(decoded), encoded);
  assert.equal(canonicalStringify({ z: 1, a: { d: 4, b: 2 } }), '{"a":{"b":2,"d":4},"z":1}');
});

test("only newline-committed log records participate in recovery", () => {
  const session = sessionWithTurn();
  const encoded = serializeSessionLog(session);
  const recovered = deserializeSessionLog(`${encoded}{"type":"operation"`);
  assert.deepEqual(recovered, session);
  assert.throws(() => deserializeSessionLog("{}"), /no committed records/);
});

test("append-only item sequences are contiguous", () => {
  let session = sessionWithTurn();
  session = appendModelResponse(
    session,
    { turnId: "turn-1", response: { text: "Done" } },
    { recordedAt: T3 },
  );
  const sequences = session.records
    .filter((record) => record.type === "item")
    .map((record) => record.item.sequence);
  assert.deepEqual(sequences, [1, 2, 3]);
});

test("caller input IDs are idempotent and conflicting reuse is rejected", () => {
  const original = createSession({ id: "session-idempotency", createdAt: T0 });
  const first = appendInput(
    original,
    { id: "input-1", kind: "external", payload: { text: "A" } },
    { recordedAt: T1 },
  );
  const duplicate = appendInput(
    first.session,
    { id: "input-1", kind: "external", payload: { text: "A" } },
    { recordedAt: T2 },
  );
  assert.equal(duplicate.duplicate, true);
  assert.strictEqual(duplicate.session, first.session);
  assert.equal(duplicate.item, null);
  assert.throws(
    () => appendInput(
      first.session,
      { id: "input-1", kind: "external", payload: { text: "B" } },
      { recordedAt: T2 },
    ),
    IdempotencyConflictError,
  );
});

test("turn linkage and owned-turn response rules are explicit", () => {
  const session = sessionWithTurn();
  assert.throws(
    () => appendTurn(session, { id: "turn-2", previousTurnId: null }, { recordedAt: T3 }),
    /expected turn-1/,
  );
  const withSecond = appendTurn(
    session,
    { id: "turn-2", previousTurnId: "turn-1" },
    { recordedAt: T3 },
  );
  assert.throws(
    () => appendTurn(withSecond, { id: "turn-2", previousTurnId: "turn-2" }, { recordedAt: T4 }),
    /duplicate turn id/,
  );
});

test("tool-call status and operation registration are atomic", () => {
  const session = sessionWithTurn();
  const duplicateA = operation("op-same");
  const duplicateB = operation("op-same");
  assert.throws(
    () => appendToolCallStatus(
      session,
      {
        turnId: "turn-1",
        callId: "call-bad",
        error: null,
        waitingFor: ["op-same"],
        operationSnapshots: [duplicateA, duplicateB],
      },
      { recordedAt: T3 },
    ),
    /duplicate operation ids/,
  );
  assert.equal(session.records.length, 2);
  assert.deepEqual(resumeSession(session).operations, []);
});

test("operation type and version are immutable", () => {
  const session = sessionWithOperation();
  const current = getOperation(session, "op-1");
  assert.throws(
    () => saveOperation(
      session,
      { ...current, type: "lilac.changed" },
      { recordedAt: T4 },
    ),
    /type and version are immutable/,
  );
  assert.throws(
    () => saveOperation(
      session,
      { ...current, version: 2 },
      { recordedAt: T4 },
    ),
    /type and version are immutable/,
  );
});

test("terminal operation state cannot regress to an active state", () => {
  let session = sessionWithOperation();
  session = updateOperation(
    session,
    "op-1",
    { status: "completed", state: { phase: "done" } },
    { recordedAt: T4 },
  );
  assert.throws(
    () => updateOperation(
      session,
      "op-1",
      { status: "ready" },
      { recordedAt: T5 },
    ),
    OperationTransitionError,
  );
});

test("cancellation and failure are durable operation checkpoints", () => {
  let canceled = sessionWithOperation();
  canceled = requestOperationCancellation(canceled, "op-1", "user requested stop", { recordedAt: T4 });
  assert.equal(getOperation(canceled, "op-1").status, "canceling");
  canceled = markOperationCanceled(canceled, "op-1", "user requested stop", { recordedAt: T5 });
  assert.equal(getOperation(canceled, "op-1").status, "canceled");
  assert.deepEqual(getOperation(canceled, "op-1").state.cancellation, { reason: "user requested stop" });

  let failed = sessionWithOperation(operation("op-fail"));
  failed = failOperation(failed, "op-fail", "deterministic failure", { recordedAt: T4 });
  assert.equal(getOperation(failed, "op-fail").status, "failed");
  assert.deepEqual(getOperation(failed, "op-fail").state.failure, { error: "deterministic failure" });
});

test("resume returns unfinished operations and terminal states missing from tool history", () => {
  let session = sessionWithOperation();
  assert.deepEqual(resumeSession(session).operations.map((value) => value.id), ["op-1"]);

  session = updateOperation(
    session,
    "op-1",
    { status: "completed", state: { phase: "done" } },
    { recordedAt: T4 },
  );
  assert.deepEqual(resumeSession(session).operations.map((value) => value.id), ["op-1"]);

  const terminal = getOperation(session, "op-1");
  session = appendToolCallStatus(
    session,
    {
      turnId: "turn-1",
      callId: "call-1",
      error: null,
      waitingFor: [],
      operationSnapshots: [terminal],
    },
    { recordedAt: T5 },
  );
  assert.deepEqual(resumeSession(session).operations, []);
  assert.deepEqual(resumeSession(session).externalInputIds, ["input-1"]);
});

test("forks preserve parent history while inherited operations become inert", () => {
  let parent = sessionWithOperation();
  parent = appendModelResponse(
    parent,
    { turnId: "turn-1", response: { text: "parent response" } },
    { recordedAt: T4 },
  );
  const parentBefore = serializeSessionLog(parent);
  const child = forkSession(parent, {
    id: "session-child",
    previousTurnId: "turn-1",
    createdAt: T5,
    recordedAt: "2026-10-03T18:00:06.000Z",
  });

  assert.equal(serializeSessionLog(parent), parentBefore);
  assert.deepEqual(resumeSession(child).operations, []);
  assert.equal(child.records.at(-1).item.kind, "fork");
  assert.equal(child.records.at(-1).item.data.parentId, "session-1");
  assert.equal(
    appendInput(
      child,
      { id: "input-1", kind: "external", payload: { prompt: "Make it clearer" } },
      { recordedAt: "2026-10-03T18:00:07.000Z" },
    ).duplicate,
    true,
  );

  const continued = appendTurn(
    child,
    { id: "turn-child", previousTurnId: "turn-1" },
    { recordedAt: "2026-10-03T18:00:07.000Z" },
  );
  assert.equal(continued.records.at(-1).item.data.id, "turn-child");
  assert.throws(
    () => appendModelResponse(
      child,
      { turnId: "turn-1", response: { text: "illegal inherited response" } },
      { recordedAt: "2026-10-03T18:00:07.000Z" },
    ),
    /not owned/,
  );
});

test("tool translation is synchronous, pure at the API boundary, and operation-ID deterministic", () => {
  const translated = translateToolCall({
    toolCall: { name: "set_text", arguments: { text: "Hello" } },
    translate(context, call) {
      assert.equal(call.name, "set_text");
      context.submit({
        id: "op-translate",
        type: "lilac.document.request",
        state: { action: "set-text" },
        idempotency: { callId: "call-translate" },
        authority: authority({ documentAffecting: true }),
      });
    },
  });
  assert.deepEqual(translated.status, { error: null, waitingFor: ["op-translate"] });
  assert.equal(translated.operations[0].id, "op-translate");
  assert.throws(
    () => translateToolCall({
      toolCall: { name: "bad" },
      translate: async () => ({}),
    }),
    /must be synchronous/,
  );
});

test("document-affecting operations can mutate only through Lilac history transactions", () => {
  const document = createDocument({
    id: "doc-1",
    nodes: [createNode({ id: "node-1", type: "text", props: { text: "Before" } })],
  });
  const history = createHistoryState(document);
  const docOperation = operation("op-doc", {
    type: "lilac.document.request",
    authority: authority({
      documentAffecting: true,
      actorId: "agent:writer",
      intent: "Update selected copy",
      capabilityId: "capability:text-edit",
      toolId: "tool:set-props",
      affectedNodeIds: ["node-1"],
      affectedSourceIds: ["src:component-1"],
    }),
  });
  let session = sessionWithOperation(docOperation);

  assert.throws(
    () => commitDocumentOperation(
      history,
      session,
      "op-doc",
      {
        id: "tx-bad",
        actor: "agent:other",
        operations: [{ type: "set-props", nodeId: "node-1", set: { text: "After" } }],
        intent: "Update selected copy",
        tool: "tool:set-props",
      },
      { recordedAt: T4 },
    ),
    /actor must match/,
  );
  assert.equal(history.document.revision, 0);
  assert.equal(history.document.nodes["node-1"].props.text, "Before");

  const committed = commitDocumentOperation(
    history,
    session,
    "op-doc",
    {
      id: "tx-doc-1",
      actor: "agent:writer",
      operations: [{ type: "set-props", nodeId: "node-1", set: { text: "After" } }],
      intent: "Update selected copy",
      tool: "tool:set-props",
      metadata: { capabilityId: "capability:text-edit" },
    },
    { recordedAt: T4 },
  );
  session = committed.session;
  assert.equal(committed.history.document.revision, 1);
  assert.equal(committed.history.document.nodes["node-1"].props.text, "After");
  assert.equal(getOperation(session, "op-doc").authority.transactionId, "tx-doc-1");
  assert.deepEqual(getOperation(session, "op-doc").authority.affectedNodeIds, ["node-1"]);
  assert.equal(committed.history.past.at(-1).transaction.metadata.agentOperationId, "op-doc");
  assert.equal(
    committed.history.past.at(-1).transaction.metadata.capabilityId,
    "capability:text-edit",
  );
});

test("malformed durable logs fail closed", () => {
  const session = sessionWithTurn();
  const encoded = serializeSessionLog(session);
  const lines = encoded.trimEnd().split("\n");
  const tampered = JSON.parse(lines[2]);
  tampered.item.sequence = 99;
  lines[2] = JSON.stringify(tampered);
  assert.throws(
    () => deserializeSessionLog(`${lines.join("\n")}\n`),
    /not contiguous/,
  );
  assert.throws(
    () => deserializeSessionLog('{"type":"session","data":{"formatVersion":999}}\n'),
    AgentRuntimeError,
  );
});
