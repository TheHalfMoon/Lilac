import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRSTMATE_SUPERVISION_PROVENANCE,
  SUPERVISOR_SCHEMA_VERSION,
  MAX_TASK_RECORD_BYTES,
  MAX_QUEUE_RECORD_BYTES,
  SupervisorLeaseError,
  SupervisorQueueError,
  SupervisorRecoveryError,
  acquireLease,
  releaseLease,
  acknowledgeWake,
  advanceRecoveryJournal,
  applyLivenessClassification,
  assertReplacementAllowed,
  classifyLiveness,
  createRecoveryJournal,
  createSupervisorQueue,
  deserializeTaskRecord,
  enqueueWake,
  nextActionableWake,
  serializeTaskRecord,
  serializeSupervisorQueue,
  deserializeSupervisorQueue,
  settleNextWake,
  settleDurableWake,
  settleDurableTaskWake,
} from "../packages/agent-supervisor/src/index.ts";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  createAgentEvent,
  deserializeAgentEvent,
  serializeAgentEvent,
} from "../packages/agent-events/src/index.ts";

const T0 = "2026-10-04T21:00:00.000Z";
const T1 = "2026-10-04T21:01:00.000Z";
const T2 = "2026-10-04T21:02:00.000Z";
const T3 = "2026-10-04T21:03:00.000Z";

function taskRecord() {
  return {
    version: SUPERVISOR_SCHEMA_VERSION,
    taskId: "task-1",
    source: {
      repositoryId: "repo-1",
      branch: "impl/task-1",
      worktreePath: "C:\\repo\\task-1",
      creationHead: "abc123",
    },
    checkpoint: { head: "abc123", dirty: true, digest: "dirty-a", recordedAt: T0 },
    runtimeProfileId: "local-default",
    endpoint: { endpointId: "endpoint-1", backend: "local-process", attachedAt: T0 },
    lifecycle: "running",
    lease: { ownerId: "owner-a", generationId: "gen-a", claimedAt: T0 },
    lastProgress: { sourceHead: "abc123", dirtyDigest: "dirty-a", eventSequence: 4, recordedAt: T0 },
    declaredWait: null,
    wakeCursor: 0,
    stale: { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null },
    createdAt: T0,
    updatedAt: T0,
    metadata: { priority: "normal" },
  };
}

test("pins Firstmate revision, MIT notice identity, and Lilac supervisor schema", () => {
  assert.equal(SUPERVISOR_SCHEMA_VERSION, 1);
  assert.deepEqual(FIRSTMATE_SUPERVISION_PROVENANCE, {
    repository: "kunchenguid/firstmate",
    revision: "1f3e769616fdf9f31f85f4c3e6a9f71606634238",
    license: "MIT",
    copyright: "Copyright (c) 2026 Kun Chen",
    posture: "port-adapt",
  });
});

test("task records serialize deterministically and fail closed on schema drift", () => {
  const task = taskRecord();
  const encoded = serializeTaskRecord(task);
  assert.deepEqual(deserializeTaskRecord(encoded), task);
  assert.equal(serializeTaskRecord(deserializeTaskRecord(encoded)), encoded);
  assert.throws(() => serializeTaskRecord({ ...task, surprise: true }), /unsupported field surprise/u);
  assert.throws(() => serializeTaskRecord({ ...task, version: 99 }), /unsupported task record version/u);
  assert.throws(() => serializeTaskRecord({ ...task, source: { ...task.source, worktreePath: "" } }), /non-empty string/u);
});

test("active and retired durable task records enforce cross-field ownership invariants", () => {
  const base = taskRecord();
  assert.throws(() => serializeTaskRecord({ ...base, lease: null }), /running requires a mutation lease/u);
  assert.throws(() => serializeTaskRecord({ ...base, endpoint: null }), /running requires an attached runtime endpoint/u);
  assert.throws(() => serializeTaskRecord({ ...base, lifecycle: "waiting", declaredWait: null }), /waiting requires declaredWait/u);
  assert.throws(() => serializeTaskRecord({ ...base, declaredWait: { waitId: "w", operationId: "op", reason: "x", startedAt: T0, validUntil: T1 } }), /declaredWait requires waiting lifecycle/u);
  assert.throws(() => serializeTaskRecord({ ...base, lifecycle: "retired", endpoint: null, lease: base.lease }), /retired task must not retain/u);
});
test("lease transfer is same-generation idempotent and foreign ownership is fail-closed", () => {
  const current = { ownerId: "owner-a", generationId: "gen-a", claimedAt: T0 };
  assert.deepEqual(acquireLease(current, { ownerId: "owner-a", generationId: "gen-a", claimedAt: T1 }, null), {
    ownerId: "owner-a", generationId: "gen-a", claimedAt: T1,
  });
  assert.throws(
    () => acquireLease(current, { ownerId: "owner-b", generationId: "gen-b", claimedAt: T1 }, null),
    SupervisorLeaseError,
  );
  assert.throws(
    () => acquireLease(current, { ownerId: "owner-b", generationId: "gen-b", claimedAt: T1 }, {
      status: "live", ownerId: "owner-a", generationId: "gen-a",
    }),
    /foreign lease is live/u,
  );
  assert.throws(
    () => acquireLease(current, { ownerId: "owner-b", generationId: "gen-b", claimedAt: T1 }, {
      status: "unknown", ownerId: "owner-a", generationId: "gen-a",
    }),
    /ownership transfer refused/u,
  );
  assert.deepEqual(
    acquireLease(current, { ownerId: "owner-b", generationId: "gen-b", claimedAt: T1 }, {
      status: "stale", ownerId: "owner-a", generationId: "gen-a",
    }),
    { ownerId: "owner-b", generationId: "gen-b", claimedAt: T1 },
  );
});



test("lease release is idempotent only after the owned lease is absent", () => {
  const current = { ownerId: "owner-a", generationId: "gen-a", claimedAt: T0 };
  assert.equal(releaseLease(current, "owner-a", "gen-a"), null);
  assert.equal(releaseLease(null, "owner-a", "gen-a"), null);
  assert.throws(() => releaseLease(current, "owner-b", "gen-b"), /belongs to another supervisor generation/u);
});

test("durable queue rejects hidden sequence gaps and oversized records", () => {
  const gapped = JSON.stringify({
    version: SUPERVISOR_SCHEMA_VERSION,
    nextSequence: 4,
    acknowledgedSequence: 0,
    entries: [
      { sequence: 1, eventId: "event-1", taskId: "task-1", eventKind: "worker_stopped", enqueuedAt: T0 },
      { sequence: 3, eventId: "event-3", taskId: "task-1", eventKind: "worker_started", enqueuedAt: T1 },
    ],
  });
  assert.throws(() => deserializeSupervisorQueue(gapped), /skip unacknowledged sequence 2/u);
  assert.throws(() => deserializeSupervisorQueue(" ".repeat(MAX_QUEUE_RECORD_BYTES + 1)), /queue record exceeds/u);
});

test("durable task deserialization rejects oversized untrusted records before parsing", () => {
  assert.throws(() => deserializeTaskRecord(" ".repeat(MAX_TASK_RECORD_BYTES + 1)), /task record exceeds/u);
});

test("wake queue acknowledgement is monotonic and crash-before-ack replays the same row", async () => {
  let queue = createSupervisorQueue();
  queue = enqueueWake(queue, { eventId: "event-1", taskId: "task-1", eventKind: "worker_stopped", enqueuedAt: T0 });
  queue = enqueueWake(queue, { eventId: "event-2", taskId: "task-1", eventKind: "worker_started", enqueuedAt: T1 });
  assert.equal(nextActionableWake(queue)?.sequence, 1);
  assert.throws(() => acknowledgeWake(queue, 2), SupervisorQueueError);
  await assert.rejects(() => settleNextWake(queue, async () => { throw new Error("crash"); }), /crash/u);
  assert.equal(nextActionableWake(queue)?.eventId, "event-1");
  queue = await settleNextWake(queue, async (entry) => assert.equal(entry.eventId, "event-1"));
  assert.equal(queue.acknowledgedSequence, 1);
  assert.equal(nextActionableWake(queue)?.eventId, "event-2");
});
test("declared waits suppress stale escalation until expiry, then progress clears suspicion", () => {
  const previous = { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null };
  const wait = { waitId: "wait-1", operationId: "op-1", reason: "external review", startedAt: T0, validUntil: T2 };
  const waiting = classifyLiveness(previous, {
    runtime: "alive",
    activeOperation: true,
    now: T1,
    staleAfterMs: 10_000,
    confirmAfterMs: 30_000,
    lastProgressAt: T0,
    currentProgress: null,
    previousProgress: null,
    declaredWait: wait,
  });
  assert.equal(waiting.state, "healthy");
  const expired = classifyLiveness(previous, {
    runtime: "alive",
    activeOperation: true,
    now: T3,
    staleAfterMs: 10_000,
    confirmAfterMs: 30_000,
    lastProgressAt: T0,
    currentProgress: null,
    previousProgress: null,
    declaredWait: wait,
  });
  assert.equal(expired.state, "stale-suspected");
  const confirmed = classifyLiveness({ ...previous, state: "stale-suspected", staleWindows: 1 }, {
    runtime: "alive",
    activeOperation: true,
    now: T3,
    staleAfterMs: 10_000,
    confirmAfterMs: 30_000,
    lastProgressAt: T0,
    currentProgress: null,
    previousProgress: null,
    declaredWait: wait,
  });
  assert.equal(confirmed.state, "stale-confirmed");
  const progress = { sourceHead: "def456", dirtyDigest: "dirty-b", eventSequence: 5, recordedAt: T3 };
  const cleared = classifyLiveness({ ...previous, state: "stale-confirmed", staleWindows: 2 }, {
    runtime: "alive",
    activeOperation: true,
    now: T3,
    staleAfterMs: 10_000,
    confirmAfterMs: 30_000,
    lastProgressAt: T0,
    currentProgress: progress,
    previousProgress: taskRecord().lastProgress,
    declaredWait: null,
  });
  assert.equal(cleared.state, "healthy");
  assert.equal(cleared.staleWindows, 0);
});

test("declared wait never masks a dead or ambiguous runtime", () => {
  const previous = { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null };
  const wait = { waitId: "wait-dead", operationId: "op-dead", reason: "external hold", startedAt: T0, validUntil: T3 };
  const dead = classifyLiveness(previous, {
    runtime: "dead", activeOperation: true, now: T1, staleAfterMs: 10_000, confirmAfterMs: 30_000,
    lastProgressAt: T0, currentProgress: null, previousProgress: null, declaredWait: wait,
  });
  assert.equal(dead.state, "recovery-requested");
  const unknown = classifyLiveness(previous, {
    runtime: "unknown", activeOperation: true, now: T1, staleAfterMs: 10_000, confirmAfterMs: 30_000,
    lastProgressAt: T0, currentProgress: null, previousProgress: null, declaredWait: wait,
  });
  assert.equal(unknown.state, "stale-suspected");
});

test("a delayed first stale poll cannot skip suspected and requires repeated evidence for confirmation", () => {
  const previous = { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null };
  const first = classifyLiveness(previous, {
    runtime: "alive", activeOperation: true, now: T3, staleAfterMs: 10_000, confirmAfterMs: 30_000,
    lastProgressAt: T0, currentProgress: null, previousProgress: null, declaredWait: null,
  });
  assert.equal(first.state, "stale-suspected");
  const second = classifyLiveness({ ...previous, state: "stale-suspected", staleWindows: 1 }, {
    runtime: "alive", activeOperation: true, now: T3, staleAfterMs: 10_000, confirmAfterMs: 30_000,
    lastProgressAt: T0, currentProgress: null, previousProgress: null, declaredWait: null,
  });
  assert.equal(second.state, "stale-confirmed");
  assert.equal(second.staleWindows, 2);
});
test("stale-state emission is bounded and repeated classification does not duplicate escalation", () => {
  const previous = { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null };
  const classification = { state: "stale-suspected", staleWindows: 1, changed: true, reason: "stale" };
  const first = applyLivenessClassification(previous, classification, T1);
  assert.equal(first.shouldEmit, true);
  const second = applyLivenessClassification(first.state, { ...classification, changed: false }, T2);
  assert.equal(second.shouldEmit, false);
});

test("recovery journal is monotonic and ambiguous absence never licenses replacement", () => {
  let journal = createRecoveryJournal({
    recoveryId: "recovery-1",
    taskId: "task-1",
    supervisorGenerationId: "gen-a",
    priorEndpointId: "endpoint-1",
    startedAt: T0,
  });
  journal = advanceRecoveryJournal(journal, "checkpointed", T1, { checkpoint: taskRecord().checkpoint });
  journal = advanceRecoveryJournal(journal, "stopped", T2);
  journal = advanceRecoveryJournal(journal, "launching", T2);
  journal = advanceRecoveryJournal(journal, "published", T3, { replacementEndpointId: "endpoint-2" });
  journal = advanceRecoveryJournal(journal, "completed", T3);
  assert.equal(journal.phase, "completed");
  assert.throws(() => advanceRecoveryJournal(journal, "failed", T3), SupervisorRecoveryError);
  assert.throws(() => assertReplacementAllowed({ state: "missing", endpointId: null, cwd: null, absenceProven: false }), /not positive/u);
  assert.throws(() => assertReplacementAllowed({ state: "unknown", endpointId: null, cwd: null, absenceProven: false }), /not positive/u);
  assert.throws(() => assertReplacementAllowed({ state: "gone", endpointId: "endpoint-1", cwd: null, absenceProven: false }), /not positively proven/u);
  assert.doesNotThrow(() => assertReplacementAllowed({ state: "gone", endpointId: "endpoint-1", cwd: null, absenceProven: true }));
  assert.doesNotThrow(() => assertReplacementAllowed({ state: "dead", endpointId: "endpoint-1", cwd: "C:\\repo\\task-1", absenceProven: false }));
});

test("supervisor event kinds extend v1 without changing canonical legacy event bytes", () => {
  assert.equal(AGENT_EVENT_SCHEMA_VERSION, 1);
  const legacy = '{"data":{"metadata":{"a":true}},"id":"event-1","kind":"run_created","runId":"run-1","schemaVersion":1,"sequence":1,"sessionId":"session-1","timestamp":"2026-10-04T21:00:00.000Z"}';
  assert.equal(serializeAgentEvent(deserializeAgentEvent(legacy)), legacy);
  const event = createAgentEvent({
    schemaVersion: 1,
    id: "event-2",
    sequence: 2,
    runId: "run-1",
    sessionId: "session-1",
    timestamp: T1,
    kind: "worker_started",
    operationId: "op-1",
    data: {
      taskId: "task-1",
      supervisorGenerationId: "gen-a",
      endpointId: "endpoint-2",
      branch: "impl/task-1",
      worktreePath: "C:\\repo\\task-1",
    },
  });
  assert.equal(deserializeAgentEvent(serializeAgentEvent(event)).kind, "worker_started");
  assert.throws(() => createAgentEvent({
    schemaVersion: 1,
    id: "event-3",
    sequence: 3,
    runId: "run-1",
    sessionId: "session-1",
    timestamp: T2,
    kind: "runtime_endpoint_lost",
    data: { taskId: "task-1", supervisorGenerationId: "gen-a", endpointId: "endpoint-1", state: "missing", absenceProven: true },
  }), /absenceProven may only be true/u);
});
test("supervisor stale escalation events reject states outside the bounded Grain 4 machine", () => {
  assert.throws(() => createAgentEvent({
    schemaVersion: 1,
    id: "event-stale-invalid",
    sequence: 4,
    runId: "run-1",
    sessionId: "session-1",
    timestamp: T2,
    kind: "worker_stale_escalated",
    data: { taskId: "task-1", from: "healthy", to: "invented-state", staleWindows: 1 },
  }), /worker_stale_escalated\.data\.to is unsupported/u);
});

test("durable queue serialization round-trips without changing replay cursor", () => {
  let queue = createSupervisorQueue();
  queue = enqueueWake(queue, { eventId: "event-q1", taskId: "task-1", eventKind: "worker_stopped", enqueuedAt: T0 });
  queue = enqueueWake(queue, { eventId: "event-q2", taskId: "task-1", eventKind: "worker_started", enqueuedAt: T1 });
  queue = acknowledgeWake(queue, 1);
  const encoded = serializeSupervisorQueue(queue);
  const decoded = deserializeSupervisorQueue(encoded);
  assert.deepEqual(decoded, queue);
  assert.equal(serializeSupervisorQueue(decoded), encoded);
  assert.equal(nextActionableWake(decoded)?.eventId, "event-q2");
});
test("recovery escalation does not regress without explicit progress or lifecycle resolution", () => {
  const previous = { state: "recovery-requested", staleWindows: 3, lastTransitionAt: T1, lastEmittedState: "recovery-requested" };
  const result = classifyLiveness(previous, {
    runtime: "alive",
    activeOperation: true,
    now: T3,
    staleAfterMs: 10_000,
    confirmAfterMs: 30_000,
    lastProgressAt: T0,
    currentProgress: null,
    previousProgress: null,
    declaredWait: null,
  });
  assert.equal(result.state, "recovery-requested");
  assert.equal(result.staleWindows, 3);
  assert.equal(result.changed, false);
});
test("durable wake settlement gives one live owner to an accepted queue row", async () => {
  let durable = createSupervisorQueue();
  durable = enqueueWake(durable, { eventId: "event-owner-1", taskId: "task-1", eventKind: "worker_stopped", enqueuedAt: T0 });
  durable = enqueueWake(durable, { eventId: "event-owner-2", taskId: "task-1", eventKind: "worker_started", enqueuedAt: T1 });
  const store = {
    async read() { return structuredClone(durable); },
    async compareAndSwap(expected, next) {
      if (serializeSupervisorQueue(expected) !== serializeSupervisorQueue(durable)) return false;
      durable = structuredClone(next);
      return true;
    },
  };
  let tail = Promise.resolve();
  const withTaskLock = async (_taskId, action) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  };
  const handled = [];
  const handler = async (entry) => {
    handled.push(entry.eventId);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await Promise.all([
    settleDurableWake(store, withTaskLock, handler),
    settleDurableWake(store, withTaskLock, handler),
  ]);
  assert.deepEqual(handled, ["event-owner-1"]);
  assert.equal(durable.acknowledgedSequence, 1);
  assert.equal(nextActionableWake(durable)?.eventId, "event-owner-2");
});

test("task wake cursor prevents duplicate handling after crash between task publication and queue ack", async () => {
  let durableQueue = createSupervisorQueue();
  durableQueue = enqueueWake(durableQueue, { eventId: "event-cursor-1", taskId: "task-1", eventKind: "worker_stopped", enqueuedAt: T0 });
  let durableTask = { ...taskRecord(), wakeCursor: 0 };
  let failQueueCasOnce = true;
  const queueStore = {
    async read() { return structuredClone(durableQueue); },
    async compareAndSwap(expected, next) {
      if (serializeSupervisorQueue(expected) !== serializeSupervisorQueue(durableQueue)) return false;
      if (failQueueCasOnce) { failQueueCasOnce = false; return false; }
      durableQueue = structuredClone(next);
      return true;
    },
  };
  const taskStore = {
    async read(taskId) { assert.equal(taskId, durableTask.taskId); return structuredClone(durableTask); },
    async compareAndSwap(taskId, expected, next) {
      assert.equal(taskId, durableTask.taskId);
      if (serializeTaskRecord(expected) !== serializeTaskRecord(durableTask)) return false;
      durableTask = structuredClone(next);
      return true;
    },
  };
  let handled = 0;
  const withTaskLock = async (_taskId, action) => action();
  const handler = async () => { handled += 1; };
  await assert.rejects(
    () => settleDurableTaskWake(queueStore, taskStore, withTaskLock, handler, T1),
    /queue changed before acknowledgement publication/u,
  );
  assert.equal(handled, 1);
  assert.equal(durableTask.wakeCursor, 1);
  assert.equal(durableQueue.acknowledgedSequence, 0);
  await settleDurableTaskWake(queueStore, taskStore, withTaskLock, handler, T2);
  assert.equal(handled, 1);
  assert.equal(durableQueue.acknowledgedSequence, 1);
});
