import assert from "node:assert/strict";
import test from "node:test";
import {
  SupervisorLeaseError,
  SupervisorOwnershipError,
  SupervisorRecoveryError,
  SupervisorRuntimeError,
  SupervisorWorktreeError,
  declareTaskWait,
  detachTask,
  endTaskWait,
  evaluateTaskLiveness,
  inspectTask,
  interruptTask,
  recordTaskProgress,
  reconcileTask,
  reconcileTaskRuntime,
  relaunchTask,
  retireTask,
  startTask,
  stopTask,
} from "../packages/agent-supervisor/src/index.ts";

const T0 = "2026-10-04T21:00:00.000Z";
const T1 = "2026-10-04T21:01:00.000Z";
const PATH = "C:\\repo\\task-1";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeTask(overrides = {}) {
  return {
    version: 1,
    taskId: "task-1",
    source: { repositoryId: "repo-1", branch: "impl/task-1", worktreePath: PATH, creationHead: "abc123" },
    checkpoint: { head: "abc123", dirty: true, digest: "dirty-old", recordedAt: T0 },
    runtimeProfileId: "local-default",
    endpoint: { endpointId: "endpoint-1", backend: "local-process", attachedAt: T0 },
    lifecycle: "running",
    lease: { ownerId: "owner-a", generationId: "gen-a", claimedAt: T0 },
    lastProgress: { sourceHead: "abc123", dirtyDigest: "dirty-old", eventSequence: 4, recordedAt: T0 },
    declaredWait: null,
    wakeCursor: 3,
    stale: { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null },
    createdAt: T0,
    updatedAt: T0,
    metadata: { keep: "exactly" },
    ...overrides,
  };
}

function fixture(options = {}) {
  let record = clone(options.task ?? makeTask());
  let ownerCheckIndex = 0;
  const calls = { worktree: 0, inspect: 0, interrupt: 0, stop: 0, launch: 0, cas: 0, journals: [], events: [] };
  const inspectEvidence = options.inspectEvidence ?? { state: "alive", endpointId: "endpoint-1", cwd: PATH, absenceProven: false };
  const deps = {
    tasks: {
      async create() { return false; },
      async read() { return clone(record); },
      async compareAndSwap(_taskId, _expected, next) {
        calls.cas += 1;
        if (options.casFails) return false;
        record = clone(next);
        return true;
      },
    },
    journals: { async write(journal) { calls.journals.push(clone(journal)); } },
    worktrees: {
      async inspect() {
        calls.worktree += 1;
        return clone(options.worktree ?? {
          exists: true,
          repositoryId: "repo-1",
          isGitWorktree: true,
          isWorktreeRoot: true,
          canonicalPath: PATH,
          branch: "impl/task-1",
          head: "abc123",
          dirty: true,
          dirtyDigest: "dirty-preserved",
        });
      },
    },
    runtime: {
      recoveryGrade: options.recoveryGrade !== false,
      async inspect() { calls.inspect += 1; return clone(inspectEvidence); },
      async interrupt(endpoint) {
        calls.interrupt += 1;
        return clone(options.interruptEvidence ?? { state: "alive", endpointId: endpoint.endpointId, cwd: PATH, absenceProven: false });
      },
      async stop(endpoint) {
        calls.stop += 1;
        if (options.stopError) throw new Error("stop failed");
        return { state: "dead", endpointId: endpoint.endpointId, cwd: PATH, absenceProven: false };
      },
      async launch(input) {
        calls.launch += 1;
        if (options.launchError) throw new Error("launch failed");
        return { state: "alive", endpointId: input.endpoint.endpointId, cwd: PATH, absenceProven: false };
      },
    },
    locks: {
      async withTaskMutationLock(_taskId, action) { return action(); },
      async isMutationOwner() {
        if (Array.isArray(options.ownerSequence)) {
          const value = options.ownerSequence[Math.min(ownerCheckIndex, options.ownerSequence.length - 1)];
          ownerCheckIndex += 1;
          return value;
        }
        return options.owner !== false;
      },
      async classifyLease(lease) {
        return clone(options.leaseEvidence ?? { status: "live", ownerId: lease.ownerId, generationId: lease.generationId });
      },
    },
    events: {
      async append(kind, data, operationId) {
        if (options.eventFailureKind === kind) throw new Error(`event failure ${kind}`);
        calls.events.push({ kind, data: clone(data), operationId: operationId ?? null });
      },
    },
  };
  return { deps, calls, getRecord: () => clone(record) };
}

function relaunchInput(overrides = {}) {
  return {
    taskId: "task-1",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    recoveryId: "recovery-1",
    replacementEndpointId: "endpoint-2",
    at: T1,
    operationId: "operation-1",
    ...overrides,
  };
}

test("non-owner supervisor generation is read-only before side effects", async () => {
  const f = fixture({ owner: false });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), SupervisorOwnershipError);
  assert.deepEqual(f.calls, { worktree: 0, inspect: 0, interrupt: 0, stop: 0, launch: 0, cas: 0, journals: [], events: [] });
});

test("live foreign lease refuses before worktree or runtime access", async () => {
  const f = fixture({ task: makeTask({ lease: { ownerId: "other", generationId: "other-gen", claimedAt: T0 } }) });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), SupervisorLeaseError);
  assert.equal(f.calls.worktree, 0);
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.deepEqual(f.calls.events, []);
  assert.deepEqual(f.calls.journals, []);
});

test("relaunch refuses a runtime backend without recovery-grade state classification", async () => {
  const f = fixture({ recoveryGrade: false });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /recovery-grade runtime state classifier/u);
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
});

test("mismatched worktree identity refuses before endpoint inspection", async () => {
  const f = fixture({ worktree: { exists: true, repositoryId: "repo-1", isGitWorktree: true, isWorktreeRoot: true, canonicalPath: "C:\\other", branch: "impl/task-1", head: "abc123", dirty: false, dirtyDigest: "x" } });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), SupervisorWorktreeError);
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.deepEqual(f.calls.events, []);
});

test("repository identity mismatch refuses before endpoint inspection", async () => {
  const f = fixture({ worktree: {
    exists: true, repositoryId: "different-repository", isGitWorktree: true, isWorktreeRoot: true,
    canonicalPath: PATH, branch: "impl/task-1", head: "abc123", dirty: false, dirtyDigest: "clean",
  } });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /repository identity differs/u);
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
});

test("ambiguous endpoint state refuses replacement without durable or runtime mutation", async () => {
  const f = fixture({ inspectEvidence: { state: "missing", endpointId: null, cwd: null, absenceProven: false } });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /not positive agent-free evidence/u);
  assert.equal(f.calls.inspect, 1);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.deepEqual(f.calls.events, []);
  assert.deepEqual(f.calls.journals, []);
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-1");
});
test("successful relaunch preserves durable identity and dirty checkpoint while replacing only runtime identity", async () => {
  const f = fixture();
  const result = await relaunchTask(f.deps, relaunchInput());
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.launch, 1);
  assert.equal(f.calls.cas, 1);
  assert.equal(result.taskId, "task-1");
  assert.deepEqual(result.source, makeTask().source);
  assert.deepEqual(result.metadata, { keep: "exactly" });
  assert.equal(result.checkpoint.head, "abc123");
  assert.equal(result.checkpoint.dirty, true);
  assert.equal(result.checkpoint.digest, "dirty-preserved");
  assert.equal(result.endpoint.endpointId, "endpoint-2");
  assert.equal(result.lease.generationId, "gen-a");
  assert.equal(result.lifecycle, "running");
  assert.equal(f.calls.journals.at(-1).phase, "completed");
  assert.deepEqual(f.calls.events.map((event) => event.kind), [
    "worker_recovery_started",
    "worker_stopped",
    "worker_recovery_completed",
    "worker_started",
  ]);
});

test("endpoint cwd mismatch refuses before stop and launch", async () => {
  const f = fixture({ inspectEvidence: { state: "alive", endpointId: "endpoint-1", cwd: "C:\\wrong", absenceProven: false } });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), SupervisorRuntimeError);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.deepEqual(f.calls.events, []);
  assert.deepEqual(f.calls.journals, []);
});

test("launch failure after a truthful stop preserves the old durable record and recovery journal", async () => {
  const f = fixture({ launchError: true });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /launch failed/u);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.launch, 1);
  assert.equal(f.calls.cas, 0);
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-1");
  assert.equal(f.getRecord().checkpoint.digest, "dirty-old");
  assert.equal(f.calls.journals.at(-1).phase, "failed");
  assert.deepEqual(f.calls.events.map((event) => event.kind), [
    "worker_recovery_started",
    "worker_stopped",
    "worker_recovery_refused",
  ]);
});

test("CAS conflict after replacement launch stops the unpublished replacement instead of erasing concurrent metadata", async () => {
  const f = fixture({ casFails: true });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /publication refused/u);
  assert.equal(f.calls.launch, 1);
  assert.equal(f.calls.stop, 2);
  assert.equal(f.calls.cas, 1);
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-1");
  assert.equal(f.calls.journals.at(-1).phase, "failed");
  assert.equal(f.calls.events.at(-1).kind, "worker_recovery_refused");
});

test("post-publication event failure keeps the new durable runtime record", async () => {
  const f = fixture({ eventFailureKind: "worker_recovery_completed" });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /event failure worker_recovery_completed/u);
  assert.equal(f.calls.cas, 1);
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-2");
  assert.equal(f.getRecord().checkpoint.digest, "dirty-preserved");
  assert.equal(f.calls.journals.at(-1).phase, "failed");
});

test("stop refuses ambiguous endpoint state without stop, CAS, or lifecycle event", async () => {
  const f = fixture({ inspectEvidence: { state: "unknown", endpointId: null, cwd: null, absenceProven: false } });
  await assert.rejects(() => stopTask(f.deps, {
    taskId: "task-1",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    at: T1,
    reason: "operator stop",
  }), /ambiguous/u);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.cas, 0);
  assert.deepEqual(f.calls.events, []);
});

test("restart reconciliation is read-only for non-owner generations and distinguishes ambiguity", async () => {
  const f = fixture({ owner: false, inspectEvidence: { state: "unknown", endpointId: null, cwd: null, absenceProven: false } });
  const reconciliation = await reconcileTaskRuntime(f.deps, "task-1", "other-generation");
  assert.equal(reconciliation.mutationAllowed, false);
  assert.equal(reconciliation.action, "ambiguous");
  assert.equal(f.calls.cas, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.deepEqual(f.calls.events, []);
});
test("stop failure leaves the prior durable runtime record untouched and records a truthful terminal journal", async () => {
  const f = fixture({ stopError: true });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /stop failed/u);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-1");
  assert.equal(f.getRecord().checkpoint.digest, "dirty-old");
  assert.equal(f.calls.journals.at(-1).phase, "failed");
  assert.match(f.calls.journals.at(-1).reason, /stop failed/u);
  assert.deepEqual(f.calls.events.map((event) => event.kind), ["worker_recovery_started", "worker_recovery_refused"]);
});

test("authority loss before runtime stop prevents further worker mutation", async () => {
  const f = fixture({ ownerSequence: [true, true, true, false] });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), SupervisorOwnershipError);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-1");
  assert.equal(f.calls.journals.at(-1).phase, "stopping");
  assert.deepEqual(f.calls.events.map((event) => event.kind), ["worker_recovery_started"]);
});

test("authority loss after stop but before replacement launch never duplicates a worker", async () => {
  const f = fixture({ ownerSequence: [true, true, true, true, true, false] });
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), SupervisorOwnershipError);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.equal(f.calls.journals.at(-1).phase, "launching");
  assert.equal(f.getRecord().endpoint.endpointId, "endpoint-1");
});

test("provably stale lease can move to a fresh supervisor generation without changing durable task identity", async () => {
  const task = makeTask({ lease: { ownerId: "old-owner", generationId: "old-generation", claimedAt: T0 } });
  const f = fixture({
    task,
    leaseEvidence: { status: "stale", ownerId: "old-owner", generationId: "old-generation" },
  });
  const result = await relaunchTask(f.deps, relaunchInput({ ownerId: "new-owner", supervisorGenerationId: "new-generation" }));
  assert.equal(result.taskId, task.taskId);
  assert.deepEqual(result.source, task.source);
  assert.equal(result.lease.ownerId, "new-owner");
  assert.equal(result.lease.generationId, "new-generation");
  assert.equal(result.endpoint.endpointId, "endpoint-2");
});

test("declared wait is durable, operation-bound, and explicit completion resumes the same task", async () => {
  const f = fixture();
  const waiting = await declareTaskWait(f.deps, {
    taskId: "task-1",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    waitId: "wait-1",
    operationId: "operation-1",
    reason: "awaiting review",
    validUntil: "2026-10-04T22:00:00.000Z",
    at: T1,
  });
  assert.equal(waiting.lifecycle, "waiting");
  assert.equal(waiting.declaredWait.operationId, "operation-1");
  const resumed = await endTaskWait(f.deps, {
    taskId: "task-1",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    waitId: "wait-1",
    outcome: "completed",
    at: "2026-10-04T21:02:00.000Z",
  });
  assert.equal(resumed.lifecycle, "running");
  assert.equal(resumed.declaredWait, null);
  assert.deepEqual(f.calls.events.map((event) => event.kind), ["worker_wait_started", "worker_wait_ended"]);
  assert.deepEqual(f.calls.events.map((event) => event.operationId), ["operation-1", "operation-1"]);
});

test("owner restart reconciliation marks positively dead runtime stopped without deleting endpoint or task identity", async () => {
  const f = fixture({ inspectEvidence: { state: "dead", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  const result = await reconcileTask(f.deps, {
    taskId: "task-1",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    at: T1,
    operationId: "operation-1",
  });
  assert.equal(result.action, "stopped");
  assert.equal(result.task.taskId, "task-1");
  assert.equal(result.task.lifecycle, "stopped");
  assert.equal(result.task.endpoint.endpointId, "endpoint-1");
  assert.equal(result.task.stale.state, "recovery-requested");
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 1);
  assert.equal(f.calls.events.at(-1).kind, "worker_stopped");
});

test("restart reconciliation refuses mutation when endpoint absence is ambiguous", async () => {
  const f = fixture({ inspectEvidence: { state: "gone", endpointId: "endpoint-1", cwd: null, absenceProven: false } });
  const result = await reconcileTask(f.deps, {
    taskId: "task-1",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    at: T1,
  });
  assert.equal(result.action, "ambiguous");
  assert.equal(f.calls.cas, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.deepEqual(f.calls.events, []);
});
test("unreadable worktree refuses lifecycle mutation before endpoint, journal, event, or CAS side effects", async () => {
  const f = fixture();
  f.deps.worktrees.inspect = async () => {
    f.calls.worktree += 1;
    throw new SupervisorWorktreeError("worktree metadata is unreadable");
  };
  await assert.rejects(() => relaunchTask(f.deps, relaunchInput()), /worktree metadata is unreadable/u);
  assert.equal(f.calls.worktree, 1);
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.cas, 0);
  assert.deepEqual(f.calls.journals, []);
  assert.deepEqual(f.calls.events, []);
});

test("fresh same-task starts publish one durable identity and launch exactly one worker", async () => {
  let record = null;
  let launchCount = 0;
  const events = [];
  const deps = {
    tasks: {
      async create(next) {
        if (record !== null) return false;
        record = clone(next);
        return true;
      },
      async list() { return record === null ? [] : [clone(record)]; },
      async read() {
        if (record === null) throw new Error("missing task");
        return clone(record);
      },
      async compareAndSwap(_taskId, expected, next) {
        if (record === null || JSON.stringify(record) !== JSON.stringify(expected)) return false;
        record = clone(next);
        return true;
      },
    },
    journals: { async write() {} },
    worktrees: { async inspect() { return { exists: true, repositoryId: "repo-1", isGitWorktree: true, isWorktreeRoot: true, canonicalPath: PATH, branch: "impl/task-1", head: "abc123", dirty: true, dirtyDigest: "dirty-start" }; } },
    runtime: {
      recoveryGrade: true,
      async inspect() { throw new Error("not used"); },
      async interrupt() { throw new Error("not used"); },
      async stop() { return { state: "dead", endpointId: "unused", cwd: PATH, absenceProven: false }; },
      async launch(input) {
        launchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { state: "alive", endpointId: input.endpoint.endpointId, cwd: PATH, absenceProven: false };
      },
    },
    locks: {
      async withTaskMutationLock(_taskId, action) { return action(); },
      async isMutationOwner() { return true; },
      async classifyLease(lease) { return { status: "live", ownerId: lease.ownerId, generationId: lease.generationId }; },
    },
    events: { async append(kind, data) { events.push({ kind, data: clone(data) }); } },
  };
  const base = {
    taskId: "task-1",
    repositoryId: "repo-1",
    branch: "impl/task-1",
    worktreePath: PATH,
    creationHead: "abc123",
    runtimeProfileId: "local-default",
    ownerId: "owner-a",
    supervisorGenerationId: "gen-a",
    at: T1,
  };
  const results = await Promise.allSettled([
    startTask(deps, { ...base, endpointId: "endpoint-new-a" }),
    startTask(deps, { ...base, endpointId: "endpoint-new-b" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(launchCount, 1);
  assert.equal(record.lifecycle, "running");
  assert.equal(record.taskId, "task-1");
  assert.equal(record.source.worktreePath, PATH);
  assert.equal(events.filter((event) => event.kind === "worker_started").length, 1);
});

test("fresh start launch failure preserves a durable failed reservation for reconciliation", async () => {
  let record = null;
  const events = [];
  const deps = {
    tasks: {
      async create(next) { if (record !== null) return false; record = clone(next); return true; },
      async list() { return record === null ? [] : [clone(record)]; },
      async read() { return clone(record); },
      async compareAndSwap(_taskId, expected, next) {
        if (JSON.stringify(record) !== JSON.stringify(expected)) return false;
        record = clone(next); return true;
      },
    },
    journals: { async write() {} },
    worktrees: { async inspect() { return { exists: true, repositoryId: "repo-1", isGitWorktree: true, isWorktreeRoot: true, canonicalPath: PATH, branch: "impl/task-1", head: "abc123", dirty: false, dirtyDigest: "clean" }; } },
    runtime: {
      recoveryGrade: true,
      async inspect() { throw new Error("not used"); }, async interrupt() { throw new Error("not used"); }, async stop() { throw new Error("not used"); },
      async launch() { throw new Error("spawn failed"); },
    },
    locks: { async withTaskMutationLock(_taskId, action) { return action(); }, async isMutationOwner() { return true; }, async classifyLease() { throw new Error("not used"); } },
    events: { async append(kind, data) { events.push({ kind, data: clone(data) }); } },
  };
  await assert.rejects(() => startTask(deps, {
    taskId: "task-1", repositoryId: "repo-1", branch: "impl/task-1", worktreePath: PATH, creationHead: "abc123",
    runtimeProfileId: "local-default", ownerId: "owner-a", supervisorGenerationId: "gen-a", endpointId: "endpoint-new", at: T1,
  }), /spawn failed/u);
  assert.equal(record.lifecycle, "failed");
  assert.equal(record.endpoint.endpointId, "endpoint-new");
  assert.deepEqual(events.map((event) => event.kind), ["worker_failed"]);
});

test("inspect is read-only for a non-owner generation", async () => {
  const f = fixture({ owner: false });
  const inspected = await inspectTask(f.deps, "task-1", "other-generation");
  assert.equal(inspected.mutationAllowed, false);
  assert.equal(inspected.task.taskId, "task-1");
  assert.equal(inspected.runtime.state, "alive");
  assert.equal(f.calls.cas, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
});

test("interrupt is typed, owner-bound, and preserves the live endpoint identity", async () => {
  const f = fixture();
  const after = await interruptTask(f.deps, { taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a" });
  assert.equal(f.calls.interrupt, 1);
  assert.equal(after.state, "alive");
  assert.equal(after.endpointId, "endpoint-1");
  assert.equal(f.calls.cas, 0);
});

test("interrupt accepts a terminal cancel outcome but rejects ambiguous endpoint loss", async () => {
  const stopped = fixture({ interruptEvidence: { state: "dead", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  const terminal = await interruptTask(stopped.deps, { taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a" });
  assert.equal(terminal.state, "dead");
  const ambiguous = fixture({ interruptEvidence: { state: "unknown", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  await assert.rejects(
    () => interruptTask(ambiguous.deps, { taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a" }),
    /interrupt outcome unknown is ambiguous/u,
  );
});

test("detach refuses a live worker and detaches only positively agent-free endpoints", async () => {
  const live = fixture();
  await assert.rejects(() => detachTask(live.deps, { taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", at: T1 }), /prior runtime is alive/u);
  assert.equal(live.calls.cas, 0);
  const dead = fixture({ inspectEvidence: { state: "dead", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  const result = await detachTask(dead.deps, { taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", at: T1 });
  assert.equal(result.endpoint, null);
  assert.equal(result.lifecycle, "stopped");
  assert.equal(dead.calls.cas, 1);
  assert.equal(dead.calls.events.at(-1).kind, "worker_stopped");
});

test("retire preserves source/worktree state, releases the lease, and never cleans the worktree", async () => {
  const f = fixture({ inspectEvidence: { state: "dead", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  const result = await retireTask(f.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", reason: "completed", at: T1,
  });
  assert.equal(result.lifecycle, "retired");
  assert.equal(result.endpoint, null);
  assert.equal(result.lease, null);
  assert.deepEqual(result.source, makeTask().source);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.events.at(-1).kind, "worker_retired");
});

test("progress checkpoints are monotonic, source-bound, and clear stale suspicion", async () => {
  const f = fixture({
    task: makeTask({ stale: { state: "stale-suspected", staleWindows: 1, lastTransitionAt: T0, lastEmittedState: "stale-suspected" } }),
    worktree: { exists: true, repositoryId: "repo-1", isGitWorktree: true, isWorktreeRoot: true, canonicalPath: PATH, branch: "impl/task-1", head: "def456", dirty: true, dirtyDigest: "dirty-new" },
  });
  const result = await recordTaskProgress(f.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", eventSequence: 5, at: T1,
  });
  assert.equal(result.lastProgress.sourceHead, "def456");
  assert.equal(result.lastProgress.eventSequence, 5);
  assert.equal(result.stale.state, "healthy");
  assert.equal(f.calls.events.at(-1).kind, "progress_checkpoint_changed");
  await assert.rejects(() => recordTaskProgress(f.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", eventSequence: 4, at: "2026-10-04T21:02:00.000Z",
  }), /cannot move backwards/u);
});

test("liveness orchestration emits bounded wedge and stale escalation events without destructive action", async () => {
  const f = fixture({ task: makeTask({
    lastProgress: { sourceHead: "abc123", dirtyDigest: "dirty-old", eventSequence: 4, recordedAt: T0 },
  }) });
  const suspected = await evaluateTaskLiveness(f.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", activeOperation: true,
    staleAfterMs: 30_000, confirmAfterMs: 120_000, at: T1,
  });
  assert.equal(suspected.stale.state, "stale-suspected");
  assert.equal(f.calls.events.at(-1).kind, "worker_wedge_suspected");
  const confirmed = await evaluateTaskLiveness(f.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", activeOperation: true,
    staleAfterMs: 30_000, confirmAfterMs: 120_000, at: "2026-10-04T21:03:30.000Z",
  });
  assert.equal(confirmed.stale.state, "stale-confirmed");
  assert.equal(f.calls.events.at(-1).kind, "worker_stale_escalated");
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.launch, 0);
});


test("restart reconciliation completes a crash-after-launch starting record without spawning a duplicate", async () => {
  const f = fixture({ task: makeTask({ lifecycle: "starting" }) });
  const result = await reconcileTask(f.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", at: T1,
  });
  assert.equal(result.action, "recovered");
  assert.equal(result.task.lifecycle, "running");
  assert.equal(result.task.endpoint.endpointId, "endpoint-1");
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.stop, 0);
  assert.equal(f.calls.cas, 1);
  assert.equal(f.calls.events.at(-1).kind, "worker_started");
});

test("restart reconciliation reclaims only a proven stale lease while an existing worker stays alive", async () => {
  const f = fixture({
    task: makeTask({ lease: { ownerId: "old-owner", generationId: "old-generation", claimedAt: T0 } }),
    leaseEvidence: { status: "stale", ownerId: "old-owner", generationId: "old-generation" },
  });
  const result = await reconcileTask(f.deps, {
    taskId: "task-1", ownerId: "new-owner", supervisorGenerationId: "new-generation", at: T1,
  });
  assert.equal(result.action, "recovered");
  assert.equal(result.task.lifecycle, "running");
  assert.equal(result.task.lease.ownerId, "new-owner");
  assert.equal(result.task.lease.generationId, "new-generation");
  assert.equal(f.calls.launch, 0);
  assert.equal(f.calls.stop, 0);
});

test("restart reconciliation sweeps a proven stale lease on a stopped task without inventing a runtime", async () => {
  const f = fixture({
    task: makeTask({ endpoint: null, lifecycle: "stopped", lease: { ownerId: "old-owner", generationId: "old-generation", claimedAt: T0 } }),
    leaseEvidence: { status: "stale", ownerId: "old-owner", generationId: "old-generation" },
  });
  const result = await reconcileTask(f.deps, {
    taskId: "task-1", ownerId: "new-owner", supervisorGenerationId: "new-generation", at: T1,
  });
  assert.equal(result.action, "recovered");
  assert.equal(result.runtime, null);
  assert.equal(result.task.lease.generationId, "new-generation");
  assert.equal(f.calls.inspect, 0);
  assert.equal(f.calls.launch, 0);
});


test("retired and explicitly stopped tasks cannot be accidentally reactivated by ordinary lifecycle paths", async () => {
  const retired = fixture({ task: makeTask({ endpoint: null, lifecycle: "retired", lease: null }) });
  const stoppedAgain = await stopTask(retired.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", at: T1, reason: "redundant stop",
  });
  assert.equal(stoppedAgain.lifecycle, "retired");
  assert.equal(retired.calls.cas, 0);
  await assert.rejects(() => relaunchTask(retired.deps, relaunchInput()), /retired task cannot be relaunched/u);

  const stopped = fixture({ task: makeTask({ endpoint: null, lifecycle: "stopped" }) });
  await assert.rejects(() => declareTaskWait(stopped.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", waitId: "wait-stopped",
    operationId: "operation-1", reason: "invalid", validUntil: "2026-10-04T22:00:00.000Z", at: T1,
  }), /declared wait requires a running task/u);
  await assert.rejects(() => recordTaskProgress(stopped.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", eventSequence: 5, at: T1,
  }), /does not accept progress checkpoints/u);
  const liveness = await evaluateTaskLiveness(stopped.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", activeOperation: false,
    staleAfterMs: 1, confirmAfterMs: 2, at: T1,
  });
  assert.equal(liveness.lifecycle, "stopped");
  assert.equal(liveness.stale.state, makeTask().stale.state);
  assert.equal(stopped.calls.cas, 0);
  assert.deepEqual(stopped.calls.events, []);
});

test("absence-dependent detach and retire refuse non-recovery-grade runtime classifiers", async () => {
  const detach = fixture({ recoveryGrade: false, inspectEvidence: { state: "dead", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  await assert.rejects(() => detachTask(detach.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", at: T1,
  }), /detach requires a recovery-grade/u);
  assert.equal(detach.calls.inspect, 0);
  assert.equal(detach.calls.cas, 0);

  const retire = fixture({ recoveryGrade: false, inspectEvidence: { state: "dead", endpointId: "endpoint-1", cwd: PATH, absenceProven: false } });
  await assert.rejects(() => retireTask(retire.deps, {
    taskId: "task-1", ownerId: "owner-a", supervisorGenerationId: "gen-a", reason: "complete", at: T1,
  }), /retirement requires a recovery-grade/u);
  assert.equal(retire.calls.inspect, 0);
  assert.equal(retire.calls.cas, 0);
});
