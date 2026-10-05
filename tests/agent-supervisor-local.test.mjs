import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import {
  FileQueueStore,
  FileSupervisorLockAdapter,
  LocalProcessRuntimeAdapter,
  FileRecoveryJournalStore,
  FileTaskStore,
  GitWorktreeInspector,
  TaskMutationMutex,
  SupervisorRecordError,
  createSupervisorQueue,
  enqueueWake,
  nextActionableWake,
  settleDurableWake,
  serializeTaskRecord,
  relaunchTask,
  startTask,
  assertTaskMetadataFileType,
} from "../packages/agent-supervisor/src/index.ts";

const T0 = "2026-10-04T21:00:00.000Z";
const T1 = "2026-10-04T21:01:00.000Z";
const execFileAsync = promisify(execFile);

function taskRecord() {
  return {
    version: 1,
    taskId: "task-local",
    source: { repositoryId: "repo-local", branch: "impl/task-local", worktreePath: "C:\\repo\\task-local", creationHead: "abc123" },
    checkpoint: { head: "abc123", dirty: false, digest: "clean", recordedAt: T0 },
    runtimeProfileId: "local-default",
    endpoint: null,
    lifecycle: "created",
    lease: null,
    lastProgress: null,
    declaredWait: null,
    wakeCursor: 0,
    stale: { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null },
    createdAt: T0,
    updatedAt: T0,
    metadata: null,
  };
}

test("metadata file guard refuses symbolic links before record parsing", () => {
  assert.throws(() => assertTaskMetadataFileType({
    isSymbolicLink: () => true,
    isFile: () => true,
  }), SupervisorRecordError);
  assert.throws(() => assertTaskMetadataFileType({
    isSymbolicLink: () => false,
    isFile: () => false,
  }), /regular file/u);
});

test("local file task store performs deterministic compare-and-swap without identity drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilac-supervisor-"));
  try {
    const store = new FileTaskStore(directory);
    const first = taskRecord();
    await store.writeInitial(first);
    const durableFiles = await readdir(directory);
    assert.equal(durableFiles.length, 1);
    assert.match(durableFiles[0], /^[a-f0-9]{64}\.task\.json$/u);
    assert.deepEqual(await store.read(first.taskId), first);
    const next = { ...first, lifecycle: "stopped", updatedAt: T1, metadata: { preserved: true } };
    assert.equal(await store.compareAndSwap(first.taskId, first, next), true);
    assert.deepEqual(await store.read(first.taskId), next);
    assert.equal(await store.compareAndSwap(first.taskId, first, { ...next, lifecycle: "running" }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git worktree inspector reports the current Lilac worktree as its own immutable root", async () => {
  const evidence = await new GitWorktreeInspector().inspect(process.cwd());
  assert.equal(evidence.exists, true);
  assert.equal(evidence.isGitWorktree, true);
  assert.ok(evidence.repositoryId.length > 0);
  assert.equal(evidence.isWorktreeRoot, true);
  assert.match(evidence.head, /^[a-f0-9]{40}$/u);
  assert.match(evidence.dirtyDigest, /^[a-f0-9]{64}$/u);
  assert.ok(evidence.branch.length > 0);
});
test("task mutation mutex serializes lifecycle actions for the same durable task", async () => {
  const mutex = new TaskMutationMutex("generation-a", async (lease) => ({
    status: "live",
    ownerId: lease.ownerId,
    generationId: lease.generationId,
  }));
  let active = 0;
  let maximum = 0;
  const order = [];
  async function action(id) {
    return mutex.withTaskMutationLock("task-local", async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end-${id}`);
      active -= 1;
    });
  }
  await Promise.all([action(1), action(2), action(3)]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});
test("file queue store persists acknowledgement and replays the next unacknowledged wake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilac-supervisor-queue-"));
  try {
    const store = new FileQueueStore(directory);
    let queue = createSupervisorQueue();
    queue = enqueueWake(queue, { eventId: "event-1", taskId: "task-local", eventKind: "worker_stopped", enqueuedAt: T0 });
    queue = enqueueWake(queue, { eventId: "event-2", taskId: "task-local", eventKind: "worker_started", enqueuedAt: T1 });
    await store.writeInitial(queue);
    assert.deepEqual(await readdir(directory), ["supervisor.queue.json"]);
    const mutex = new TaskMutationMutex("generation-a", async (lease) => ({
      status: "live",
      ownerId: lease.ownerId,
      generationId: lease.generationId,
    }));
    const handled = [];
    await settleDurableWake(
      store,
      mutex.withTaskMutationLock.bind(mutex),
      async (entry) => { handled.push(entry.eventId); },
    );
    const recovered = await store.read();
    assert.deepEqual(handled, ["event-1"]);
    assert.equal(recovered.acknowledgedSequence, 1);
    assert.equal(nextActionableWake(recovered)?.eventId, "event-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("relaunch preserves real worktree HEAD, status, tracked edits, and untracked bytes exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-worktree-preserve-"));
  const repo = join(root, "repo");
  try {
    await execFileAsync("git", ["init", "-b", "impl/preserve", repo], { windowsHide: true });
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Lilac Test"], { windowsHide: true });
    await execFileAsync("git", ["-C", repo, "config", "user.email", "lilac-test@example.invalid"], { windowsHide: true });
    const trackedPath = join(repo, "tracked.txt");
    const untrackedPath = join(repo, "untracked.bin");
    await writeFile(trackedPath, "base\n", "utf8");
    await execFileAsync("git", ["-C", repo, "add", "tracked.txt"], { windowsHide: true });
    await execFileAsync("git", ["-C", repo, "commit", "-m", "base"], { windowsHide: true });
    await writeFile(trackedPath, "base\nlocal edit\n", "utf8");
    await writeFile(untrackedPath, Buffer.from([0, 1, 2, 3, 255, 10, 20]));

    const inspector = new GitWorktreeInspector();
    const before = await inspector.inspect(repo);
    const trackedBefore = await readFile(trackedPath);
    const untrackedBefore = await readFile(untrackedPath);
    const statusBefore = (await execFileAsync("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", windowsHide: true })).stdout;

    const taskStore = new FileTaskStore(join(root, "state"));
    await taskStore.writeInitial({
      version: 1,
      taskId: "task-preserve",
      source: { repositoryId: before.repositoryId, branch: before.branch, worktreePath: before.canonicalPath, creationHead: before.head },
      checkpoint: { head: before.head, dirty: before.dirty, digest: before.dirtyDigest, recordedAt: T0 },
      runtimeProfileId: "local-default",
      endpoint: null,
      lifecycle: "stopped",
      lease: { ownerId: "owner-a", generationId: "generation-a", claimedAt: T0 },
      lastProgress: null,
      declaredWait: null,
      wakeCursor: 0,
      stale: { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null },
      createdAt: T0,
      updatedAt: T0,
      metadata: { preserve: true },
    });
    const events = [];
    const deps = {
      tasks: taskStore,
      journals: new FileRecoveryJournalStore(join(root, "journals")),
      worktrees: inspector,
      runtime: {
        recoveryGrade: true,
        async inspect() { throw new Error("endpoint inspection must not run without an endpoint"); },
        async stop() { throw new Error("stop must not run without an endpoint"); },
        async launch(input) {
          return { state: "alive", endpointId: input.endpoint.endpointId, cwd: before.canonicalPath, absenceProven: false };
        },
      },
      locks: new TaskMutationMutex("generation-a", async (lease) => ({ status: "live", ownerId: lease.ownerId, generationId: lease.generationId })),
      events: { async append(kind, data) { events.push({ kind, data }); } },
    };
    const result = await relaunchTask(deps, {
      taskId: "task-preserve",
      ownerId: "owner-a",
      supervisorGenerationId: "generation-a",
      recoveryId: "recovery-preserve",
      replacementEndpointId: "endpoint-new",
      at: T1,
    });

    const after = await inspector.inspect(repo);
    const statusAfter = (await execFileAsync("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", windowsHide: true })).stdout;
    assert.equal(after.head, before.head);
    assert.equal(after.dirtyDigest, before.dirtyDigest);
    assert.equal(statusAfter, statusBefore);
    assert.deepEqual(await readFile(trackedPath), trackedBefore);
    assert.deepEqual(await readFile(untrackedPath), untrackedBefore);
    assert.equal(result.source.creationHead, before.head);
    assert.equal(result.checkpoint.head, before.head);
    assert.equal(result.checkpoint.digest, before.dirtyDigest);
    assert.deepEqual(result.metadata, { preserve: true });
    assert.equal(result.endpoint.endpointId, "endpoint-new");
    assert.deepEqual(events.map((event) => event.kind), ["worker_recovery_started", "worker_recovery_completed", "worker_started"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("concurrent relaunch requests hold one task mutation owner through stop, launch, and publication", async () => {
  let record = {
    version: 1,
    taskId: "task-concurrent",
    source: { repositoryId: "repo-concurrent", branch: "impl/concurrent", worktreePath: "C:\\repo\\concurrent", creationHead: "abc123" },
    checkpoint: { head: "abc123", dirty: false, digest: "clean", recordedAt: T0 },
    runtimeProfileId: "local-default",
    endpoint: { endpointId: "endpoint-1", backend: "local-process", attachedAt: T0 },
    lifecycle: "running",
    lease: { ownerId: "owner-a", generationId: "generation-a", claimedAt: T0 },
    lastProgress: null,
    declaredWait: null,
    wakeCursor: 0,
    stale: { state: "healthy", staleWindows: 0, lastTransitionAt: T0, lastEmittedState: null },
    createdAt: T0,
    updatedAt: T0,
    metadata: { preserved: true },
  };
  let activeLifecycle = 0;
  let maxLifecycle = 0;
  const order = [];
  const tasks = {
    async read() { return structuredClone(record); },
    async compareAndSwap(_taskId, expected, next) {
      if (serializeTaskRecord(record) !== serializeTaskRecord(expected)) return false;
      record = structuredClone(next);
      return true;
    },
  };
  const mutex = new TaskMutationMutex("generation-a", async (lease) => ({ status: "live", ownerId: lease.ownerId, generationId: lease.generationId }));
  const deps = {
    tasks,
    journals: { async write() {} },
    worktrees: { async inspect() { return { exists: true, repositoryId: "repo-concurrent", isGitWorktree: true, isWorktreeRoot: true, canonicalPath: "C:\\repo\\concurrent", branch: "impl/concurrent", head: "abc123", dirty: false, dirtyDigest: "clean" }; } },
    runtime: {
      recoveryGrade: true,
      async inspect(endpoint) { return { state: "alive", endpointId: endpoint.endpointId, cwd: "C:\\repo\\concurrent", absenceProven: false }; },
      async stop(endpoint) {
        activeLifecycle += 1;
        maxLifecycle = Math.max(maxLifecycle, activeLifecycle);
        order.push(`stop-${endpoint.endpointId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeLifecycle -= 1;
        return { state: "dead", endpointId: endpoint.endpointId, cwd: "C:\\repo\\concurrent", absenceProven: false };
      },
      async launch(input) {
        activeLifecycle += 1;
        maxLifecycle = Math.max(maxLifecycle, activeLifecycle);
        order.push(`launch-${input.endpoint.endpointId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeLifecycle -= 1;
        return { state: "alive", endpointId: input.endpoint.endpointId, cwd: "C:\\repo\\concurrent", absenceProven: false };
      },
    },
    locks: mutex,
    events: { async append() {} },
  };
  await Promise.all([
    relaunchTask(deps, { taskId: "task-concurrent", ownerId: "owner-a", supervisorGenerationId: "generation-a", recoveryId: "recovery-1", replacementEndpointId: "endpoint-2", at: T1 }),
    relaunchTask(deps, { taskId: "task-concurrent", ownerId: "owner-a", supervisorGenerationId: "generation-a", recoveryId: "recovery-2", replacementEndpointId: "endpoint-3", at: T1 }),
  ]);
  assert.equal(maxLifecycle, 1);
  assert.deepEqual(order, ["stop-endpoint-1", "launch-endpoint-2", "stop-endpoint-2", "launch-endpoint-3"]);
  assert.equal(record.endpoint.endpointId, "endpoint-3");
  assert.deepEqual(record.metadata, { preserved: true });
});

test("file supervisor ownership admits one live mutation generation and safely transfers after release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilac-supervisor-owner-"));
  try {
    const first = await FileSupervisorLockAdapter.acquire(directory, "generation-a", T0);
    assert.equal(await first.isMutationOwner("generation-a"), true);
    assert.equal(await first.isMutationOwner("generation-b"), false);
    assert.deepEqual(await first.classifyLease({ ownerId: "owner-a", generationId: "generation-a", claimedAt: T0 }), {
      status: "live", ownerId: "owner-a", generationId: "generation-a",
    });
    assert.deepEqual(await first.classifyLease({ ownerId: "old-owner", generationId: "old-generation", claimedAt: T0 }), {
      status: "stale", ownerId: "old-owner", generationId: "old-generation",
    });
    await assert.rejects(
      () => FileSupervisorLockAdapter.acquire(directory, "generation-b", T1),
      /already owns mutation authority/u,
    );
    await first.release();
    assert.equal(await first.isMutationOwner("generation-a"), false);
    const second = await FileSupervisorLockAdapter.acquire(directory, "generation-b", T1);
    assert.equal(await second.isMutationOwner("generation-b"), true);
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file supervisor ownership reclaims only a positively dead process lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilac-supervisor-stale-owner-"));
  try {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = child.pid;
    assert.ok(Number.isSafeInteger(deadPid));
    await once(child, "exit");
    await writeFile(join(directory, ".supervisor-owner.lock"), JSON.stringify({
      acquiredAt: T0, generationId: "dead-generation", pid: deadPid, version: 1,
    }), "utf8");
    const owner = await FileSupervisorLockAdapter.acquire(directory, "generation-live", T1);
    assert.equal(await owner.isMutationOwner("generation-live"), true);
    await owner.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file supervisor task lock serializes same-task mutations under the global owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilac-supervisor-task-lock-"));
  try {
    const owner = await FileSupervisorLockAdapter.acquire(directory, "generation-a", T0);
    let active = 0;
    let maximum = 0;
    const order = [];
    const action = (id) => owner.withTaskMutationLock("task-shared", async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end-${id}`);
      active -= 1;
    });
    await Promise.all([action(1), action(2)]);
    assert.equal(maximum, 1);
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
    await owner.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("local process runtime persists endpoint identity, avoids implicit credential inheritance, and preserves worktree on stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-local-runtime-"));
  const runtimeDir = join(root, "runtime");
  const probe = join(root, "env-probe.txt");
  const endpoint = { endpointId: "endpoint-local-1", backend: "local-process", attachedAt: T0 };
  const previousSecret = process.env.LILAC_TEST_SECRET;
  process.env.LILAC_TEST_SECRET = "must-not-be-inherited";
  const adapter = new LocalProcessRuntimeAdapter(runtimeDir, {
    hold: {
      executable: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(probe)}, process.env.LILAC_TEST_SECRET ?? "absent"); setInterval(() => {}, 1000);`],
      environment: {},
      interrupt: async () => {},
    },
  }, { stopTimeoutMs: 3000, pollMs: 20 });
  try {
    const launched = await adapter.launch({
      taskId: "task-runtime",
      runtimeProfileId: "hold",
      worktreePath: root,
      endpoint,
      supervisorGenerationId: "generation-a",
    });
    assert.equal(launched.state, "alive");
    assert.equal(launched.endpointId, endpoint.endpointId);
    for (let index = 0; index < 100; index += 1) {
      try { await readFile(probe, "utf8"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.equal(await readFile(probe, "utf8"), "absent");
    const restartedAdapter = new LocalProcessRuntimeAdapter(runtimeDir, {
      hold: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], environment: {} },
    }, { stopTimeoutMs: 3000, pollMs: 20 });
    const restartView = await restartedAdapter.inspect(endpoint);
    assert.equal(restartView.state, "unknown");
    assert.equal((await restartedAdapter.stop(endpoint)).state, "unknown");
    const interrupted = await adapter.interrupt(endpoint);
    assert.equal(interrupted.state, "alive");
    assert.equal(interrupted.endpointId, endpoint.endpointId);
    const stopped = await adapter.stop(endpoint);
    assert.equal(stopped.state, "dead");
    assert.equal(stopped.endpointId, endpoint.endpointId);
    assert.equal((await adapter.inspect(endpoint)).state, "dead");
    assert.equal((await adapter.inspect({ ...endpoint, endpointId: "missing-endpoint" })).state, "missing");
    assert.equal((await adapter.inspect({ ...endpoint, endpointId: "missing-endpoint" })).absenceProven, false);
    await assert.rejects(() => adapter.launch({
      taskId: "task-runtime-duplicate",
      runtimeProfileId: "hold",
      worktreePath: root,
      endpoint,
      supervisorGenerationId: "generation-a",
    }), /endpoint identity/u);
  } finally {
    if (previousSecret === undefined) delete process.env.LILAC_TEST_SECRET;
    else process.env.LILAC_TEST_SECRET = previousSecret;
    try { await adapter.stop(endpoint); } catch { /* test cleanup only */ }
    await rm(root, { recursive: true, force: true });
  }
});


test("task-set lock and durable task registry prevent different task ids from sharing one active worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-worktree-owner-"));
  const state = join(root, "state");
  try {
    await execFileAsync("git", ["init", "-b", "impl/shared", root], { windowsHide: true });
    await execFileAsync("git", ["-C", root, "config", "user.name", "Lilac Test"], { windowsHide: true });
    await execFileAsync("git", ["-C", root, "config", "user.email", "lilac-test@example.invalid"], { windowsHide: true });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "base.txt"], { windowsHide: true });
    await execFileAsync("git", ["-C", root, "commit", "-m", "base"], { windowsHide: true });
    const inspector = new GitWorktreeInspector();
    const evidence = await inspector.inspect(root);
    const store = new FileTaskStore(state);
    const locks = new TaskMutationMutex("generation-a", async (lease) => ({ status: "live", ownerId: lease.ownerId, generationId: lease.generationId }));
    let launches = 0;
    const deps = {
      tasks: store,
      journals: { async write() {} },
      worktrees: inspector,
      runtime: {
        recoveryGrade: true,
        async inspect() { return { state: "alive", endpointId: "endpoint-1", cwd: evidence.canonicalPath, absenceProven: false }; },
        async interrupt() { throw new Error("not used"); },
        async stop() { return { state: "dead", endpointId: "endpoint-1", cwd: evidence.canonicalPath, absenceProven: false }; },
        async launch(input) { launches += 1; return { state: "alive", endpointId: input.endpoint.endpointId, cwd: evidence.canonicalPath, absenceProven: false }; },
      },
      locks,
      events: { async append() {} },
    };
    const base = {
      repositoryId: evidence.repositoryId, branch: evidence.branch, worktreePath: evidence.canonicalPath, creationHead: evidence.head,
      runtimeProfileId: "local-default", ownerId: "owner-a", supervisorGenerationId: "generation-a", at: T1,
    };
    const results = await Promise.allSettled([
      startTask(deps, { ...base, taskId: "task-owner-a", endpointId: "endpoint-a" }),
      startTask(deps, { ...base, taskId: "task-owner-b", endpointId: "endpoint-b" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /already bound to durable task/u);
    assert.equal(launches, 1);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
