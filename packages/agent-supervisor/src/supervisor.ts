import { cloneJson } from "@lilac/agent-runtime";
import type { AgentEventDataMap } from "@lilac/agent-events";
import { SupervisorOwnershipError, SupervisorRecoveryError, SupervisorRuntimeError, SupervisorWorktreeError } from "./errors.ts";
import { acquireLease, assertLeaseOwner, releaseLease } from "./lease.ts";
import { assertReplacementAllowed, advanceRecoveryJournal, createRecoveryJournal } from "./recovery.ts";
import { applyLivenessClassification, classifyLiveness } from "./liveness.ts";
import { normalizeTaskRecord } from "./records.ts";
import type {
  LeaseLivenessEvidence,
  RecoveryJournal,
  RuntimeEndpointIdentity,
  RuntimeEvidence,
  SupervisedTaskRecord,
  SupervisorLease,
  WorktreeEvidence,
} from "./types.ts";

export type SupervisorEventKind =
  | "worker_started"
  | "worker_stopped"
  | "worker_failed"
  | "runtime_endpoint_lost"
  | "progress_checkpoint_changed"
  | "worker_wait_started"
  | "worker_wait_ended"
  | "worker_wedge_suspected"
  | "worker_stale_escalated"
  | "worker_recovery_started"
  | "worker_recovery_completed"
  | "worker_recovery_refused"
  | "worker_retired";

export interface TaskStore {
  create(task: SupervisedTaskRecord): Promise<boolean>;
  list(): Promise<SupervisedTaskRecord[]>;
  read(taskId: string): Promise<SupervisedTaskRecord>;
  compareAndSwap(taskId: string, expected: SupervisedTaskRecord, next: SupervisedTaskRecord): Promise<boolean>;
}

export interface RecoveryJournalStore {
  write(journal: RecoveryJournal): Promise<void>;
}

export interface WorktreeInspector {
  inspect(canonicalPath: string): Promise<WorktreeEvidence>;
}

export interface RuntimeAdapter {
  readonly recoveryGrade: boolean;
  inspect(endpoint: RuntimeEndpointIdentity): Promise<RuntimeEvidence>;
  interrupt(endpoint: RuntimeEndpointIdentity): Promise<RuntimeEvidence>;
  stop(endpoint: RuntimeEndpointIdentity): Promise<RuntimeEvidence>;
  launch(input: {
    taskId: string;
    runtimeProfileId: string;
    worktreePath: string;
    endpoint: RuntimeEndpointIdentity;
    supervisorGenerationId: string;
  }): Promise<RuntimeEvidence>;
}

export interface SupervisorLockAdapter {
  withTaskMutationLock<T>(taskId: string, action: () => Promise<T>): Promise<T>;
  isMutationOwner(supervisorGenerationId: string): Promise<boolean>;
  classifyLease(lease: SupervisorLease): Promise<LeaseLivenessEvidence>;
}



export interface SupervisorEventSink {
  append<T extends SupervisorEventKind>(kind: T, data: AgentEventDataMap[T], operationId?: string): Promise<void>;
}

export interface RelaunchRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  recoveryId: string;
  replacementEndpointId: string;
  at: string;
  operationId?: string;
}

export interface SupervisorDependencies {
  tasks: TaskStore;
  journals: RecoveryJournalStore;
  worktrees: WorktreeInspector;
  runtime: RuntimeAdapter;
  locks: SupervisorLockAdapter;
  events: SupervisorEventSink;
}

async function assertMutationAuthority(deps: SupervisorDependencies, supervisorGenerationId: string): Promise<void> {
  if (!await deps.locks.isMutationOwner(supervisorGenerationId)) {
    throw new SupervisorOwnershipError("non-owner supervisor generation is read-only");
  }
}

function checkpointFrom(evidence: WorktreeEvidence, at: string) {
  return { head: evidence.head, dirty: evidence.dirty, digest: evidence.dirtyDigest, recordedAt: at };
}

function assertWorktreeIdentity(task: SupervisedTaskRecord, evidence: WorktreeEvidence): void {
  if (!evidence.exists || !evidence.isGitWorktree || !evidence.isWorktreeRoot) {
    throw new SupervisorWorktreeError("recorded worktree is not an existing Git worktree root");
  }
  if (evidence.repositoryId !== task.source.repositoryId) {
    throw new SupervisorWorktreeError("Git repository identity differs from the immutable task binding");
  }
  if (evidence.canonicalPath !== task.source.worktreePath) {
    throw new SupervisorWorktreeError("canonical worktree path differs from the immutable task binding");
  }
  if (evidence.branch !== task.source.branch) {
    throw new SupervisorWorktreeError("worktree branch differs from the immutable task binding");
  }
}

function assertEndpointCwd(task: SupervisedTaskRecord, evidence: RuntimeEvidence): void {
  if (evidence.cwd !== null && evidence.cwd !== task.source.worktreePath) {
    throw new SupervisorRuntimeError("runtime endpoint cwd differs from the immutable worktree binding");
  }
}
export async function relaunchTask(deps: SupervisorDependencies, request: RelaunchRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);

    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (current.taskId !== request.taskId) throw new SupervisorOwnershipError("task store returned a different durable identity");
    if (current.lifecycle === "retired") throw new SupervisorRecoveryError("retired task cannot be relaunched");

    let leaseEvidence: LeaseLivenessEvidence | null = null;
    if (current.lease !== null
        && (current.lease.ownerId !== request.ownerId || current.lease.generationId !== request.supervisorGenerationId)) {
      leaseEvidence = await deps.locks.classifyLease(current.lease);
    }
    const nextLease = acquireLease(current.lease, {
      ownerId: request.ownerId,
      generationId: request.supervisorGenerationId,
      claimedAt: request.at,
    }, leaseEvidence);
    assertLeaseOwner(nextLease, request.ownerId, request.supervisorGenerationId);

    const worktree = await deps.worktrees.inspect(current.source.worktreePath);
    assertWorktreeIdentity(current, worktree);

    let runtimeBefore: RuntimeEvidence | null = null;
    if (current.endpoint !== null) {
      if (!deps.runtime.recoveryGrade) {
        throw new SupervisorRuntimeError("relaunch requires a recovery-grade runtime state classifier");
      }
      runtimeBefore = await deps.runtime.inspect(current.endpoint);
      if (runtimeBefore.endpointId !== null && runtimeBefore.endpointId !== current.endpoint.endpointId) {
        throw new SupervisorRuntimeError("runtime inspection returned a different endpoint identity");
      }
      assertEndpointCwd(current, runtimeBefore);
      if (runtimeBefore.state !== "alive") assertReplacementAllowed(runtimeBefore);
    }

    await assertMutationAuthority(deps, request.supervisorGenerationId);
    let journal = createRecoveryJournal({
      recoveryId: request.recoveryId,
      taskId: current.taskId,
      supervisorGenerationId: request.supervisorGenerationId,
      priorEndpointId: current.endpoint?.endpointId ?? null,
      startedAt: request.at,
    });
    await deps.journals.write(journal);
    journal = advanceRecoveryJournal(journal, "checkpointed", request.at, { checkpoint: checkpointFrom(worktree, request.at) });
    await deps.journals.write(journal);
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_recovery_started", {
      taskId: current.taskId,
      recoveryId: request.recoveryId,
      ...(current.endpoint === null ? {} : { priorEndpointId: current.endpoint.endpointId }),
    }, request.operationId);

    if (current.endpoint !== null && runtimeBefore?.state === "alive") {
      journal = advanceRecoveryJournal(journal, "stopping", request.at);
      await deps.journals.write(journal);
      try {
        await assertMutationAuthority(deps, request.supervisorGenerationId);
        const stopped = await deps.runtime.stop(current.endpoint);
        assertEndpointCwd(current, stopped);
        assertReplacementAllowed(stopped);
      } catch (error) {
        if (await deps.locks.isMutationOwner(request.supervisorGenerationId)) {
          journal = advanceRecoveryJournal(journal, "failed", request.at, {
            reason: error instanceof Error ? error.message : String(error),
          });
          await deps.journals.write(journal);
          await deps.events.append("worker_recovery_refused", {
            taskId: current.taskId,
            recoveryId: request.recoveryId,
            reason: journal.reason ?? "prior runtime stop failed",
          }, request.operationId);
        }
        throw error;
      }
      journal = advanceRecoveryJournal(journal, "stopped", request.at);
      await deps.journals.write(journal);
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      await deps.events.append("worker_stopped", {
        taskId: current.taskId,
        supervisorGenerationId: request.supervisorGenerationId,
        endpointId: current.endpoint.endpointId,
        reason: "relaunch",
      }, request.operationId);
    } else {
      journal = advanceRecoveryJournal(journal, "stopped", request.at);
      await deps.journals.write(journal);
    }

    journal = advanceRecoveryJournal(journal, "launching", request.at);
    await deps.journals.write(journal);
    const replacement: RuntimeEndpointIdentity = {
      endpointId: request.replacementEndpointId,
      backend: "local-process",
      attachedAt: request.at,
    };
    if (replacement.endpointId === current.endpoint?.endpointId) {
      journal = advanceRecoveryJournal(journal, "failed", request.at, { reason: "replacement endpoint identity was not fresh" });
      await deps.journals.write(journal);
      throw new SupervisorRecoveryError("replacement endpoint identity must be fresh");
    }

    let launched: RuntimeEvidence;
    try {
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      launched = await deps.runtime.launch({
        taskId: current.taskId,
        runtimeProfileId: current.runtimeProfileId,
        worktreePath: current.source.worktreePath,
        endpoint: replacement,
        supervisorGenerationId: request.supervisorGenerationId,
      });
      if (launched.state !== "alive" || launched.endpointId !== replacement.endpointId) {
        throw new SupervisorRuntimeError("replacement runtime did not confirm the requested live endpoint identity");
      }
      assertEndpointCwd(current, launched);
    } catch (error) {
      if (await deps.locks.isMutationOwner(request.supervisorGenerationId)) {
        journal = advanceRecoveryJournal(journal, "failed", request.at, {
          reason: error instanceof Error ? error.message : String(error),
        });
        await deps.journals.write(journal);
        await deps.events.append("worker_recovery_refused", {
          taskId: current.taskId,
          recoveryId: request.recoveryId,
          reason: journal.reason ?? "replacement launch failed",
        }, request.operationId);
      }
      throw error;
    }

    const next: SupervisedTaskRecord = {
      ...cloneJson(current),
      checkpoint: checkpointFrom(worktree, request.at),
      endpoint: replacement,
      lifecycle: "running",
      lease: nextLease,
      declaredWait: null,
      stale: {
        state: "recovered",
        staleWindows: 0,
        lastTransitionAt: request.at,
        lastEmittedState: "recovered",
      },
      updatedAt: request.at,
    };

    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const published = await deps.tasks.compareAndSwap(current.taskId, current, next);
    if (!published) {
      try { await deps.runtime.stop(replacement); } catch { /* preserve the CAS failure as primary */ }
      journal = advanceRecoveryJournal(journal, "failed", request.at, { reason: "durable task changed during relaunch" });
      await deps.journals.write(journal);
      await deps.events.append("worker_recovery_refused", {
        taskId: current.taskId,
        recoveryId: request.recoveryId,
        reason: "durable task changed during relaunch",
      }, request.operationId);
      throw new SupervisorRecoveryError("durable task changed during relaunch; publication refused");
    }

    journal = advanceRecoveryJournal(journal, "published", request.at, { replacementEndpointId: replacement.endpointId });
    await deps.journals.write(journal);
    try {
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      await deps.events.append("worker_recovery_completed", {
        taskId: current.taskId,
        recoveryId: request.recoveryId,
        endpointId: replacement.endpointId,
      }, request.operationId);
      await deps.events.append("worker_started", {
        taskId: current.taskId,
        supervisorGenerationId: request.supervisorGenerationId,
        endpointId: replacement.endpointId,
        branch: current.source.branch,
        worktreePath: current.source.worktreePath,
      }, request.operationId);
    } catch (error) {
      if (await deps.locks.isMutationOwner(request.supervisorGenerationId)) {
        journal = advanceRecoveryJournal(journal, "failed", request.at, {
          reason: error instanceof Error ? error.message : String(error),
        });
        await deps.journals.write(journal);
      }
      throw error;
    }
    journal = advanceRecoveryJournal(journal, "completed", request.at);
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.journals.write(journal);
    return cloneJson(next);
  });
}
export interface StopRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  at: string;
  reason: string;
  operationId?: string;
}

export async function stopTask(deps: SupervisorDependencies, request: StopRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (current.lifecycle === "retired") return cloneJson(current);
    let leaseEvidence: LeaseLivenessEvidence | null = null;
    if (current.lease !== null
        && (current.lease.ownerId !== request.ownerId || current.lease.generationId !== request.supervisorGenerationId)) {
      leaseEvidence = await deps.locks.classifyLease(current.lease);
    }
    const nextLease = acquireLease(current.lease, {
      ownerId: request.ownerId,
      generationId: request.supervisorGenerationId,
      claimedAt: request.at,
    }, leaseEvidence);
    const worktree = await deps.worktrees.inspect(current.source.worktreePath);
    assertWorktreeIdentity(current, worktree);

    if (current.endpoint === null) {
      if (current.lifecycle === "stopped") return cloneJson(current);
      const next = { ...cloneJson(current), lifecycle: "stopped" as const, lease: nextLease, updatedAt: request.at };
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
        throw new SupervisorRecoveryError("durable task changed during stop; publication refused");
      }
      return cloneJson(next);
    }

    if (!deps.runtime.recoveryGrade) {
      throw new SupervisorRuntimeError("stop requires a recovery-grade runtime state classifier");
    }
    const before = await deps.runtime.inspect(current.endpoint);
    assertEndpointCwd(current, before);
    if (before.state === "missing" || before.state === "unknown" || (before.state === "gone" && !before.absenceProven)) {
      throw new SupervisorRecoveryError(`stop refused because runtime state ${before.state} is ambiguous`);
    }
    if (before.state === "alive") {
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      const after = await deps.runtime.stop(current.endpoint);
      assertEndpointCwd(current, after);
      assertReplacementAllowed(after);
    }
    const next: SupervisedTaskRecord = {
      ...cloneJson(current),
      checkpoint: checkpointFrom(worktree, request.at),
      endpoint: null,
      lifecycle: "stopped",
      lease: nextLease,
      declaredWait: null,
      updatedAt: request.at,
    };
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed during stop; publication refused");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_stopped", {
      taskId: current.taskId,
      supervisorGenerationId: request.supervisorGenerationId,
      endpointId: current.endpoint.endpointId,
      reason: request.reason,
    }, request.operationId);
    return cloneJson(next);
  });
}

export interface RuntimeReconciliation {
  task: SupervisedTaskRecord;
  runtime: RuntimeEvidence | null;
  mutationAllowed: boolean;
  action: "none" | "ambiguous" | "stopped" | "recovered";
}

export async function reconcileTaskRuntime(
  deps: SupervisorDependencies,
  taskId: string,
  supervisorGenerationId: string,
): Promise<RuntimeReconciliation> {
  const current = normalizeTaskRecord(await deps.tasks.read(taskId));
  const mutationAllowed = await deps.locks.isMutationOwner(supervisorGenerationId);
  if (current.endpoint === null) return { task: current, runtime: null, mutationAllowed, action: "none" };
  const runtime = await deps.runtime.inspect(current.endpoint);
  assertEndpointCwd(current, runtime);
  if (runtime.state === "alive") return { task: current, runtime, mutationAllowed, action: "none" };
  if (runtime.state === "missing" || runtime.state === "unknown" || (runtime.state === "gone" && !runtime.absenceProven)) {
    return { task: current, runtime, mutationAllowed, action: "ambiguous" };
  }
  return { task: current, runtime, mutationAllowed, action: "stopped" };
}
export interface DeclareWaitRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  waitId: string;
  operationId: string;
  reason: string;
  validUntil: string;
  at: string;
}

export async function declareTaskWait(deps: SupervisorDependencies, request: DeclareWaitRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (Date.parse(request.validUntil) < Date.parse(request.at)) {
      throw new SupervisorRecoveryError("declared wait validUntil precedes its start time");
    }
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (current.lifecycle !== "running" || current.endpoint === null) {
      throw new SupervisorRecoveryError("declared wait requires a running task with an attached endpoint");
    }
    if (current.declaredWait !== null) throw new SupervisorRecoveryError("task already has an active declared wait");
    let leaseEvidence: LeaseLivenessEvidence | null = null;
    if (current.lease !== null
        && (current.lease.ownerId !== request.ownerId || current.lease.generationId !== request.supervisorGenerationId)) {
      leaseEvidence = await deps.locks.classifyLease(current.lease);
    }
    const nextLease = acquireLease(current.lease, {
      ownerId: request.ownerId,
      generationId: request.supervisorGenerationId,
      claimedAt: request.at,
    }, leaseEvidence);
    const next: SupervisedTaskRecord = {
      ...cloneJson(current),
      lifecycle: "waiting",
      lease: nextLease,
      declaredWait: {
        waitId: request.waitId,
        operationId: request.operationId,
        reason: request.reason,
        startedAt: request.at,
        validUntil: request.validUntil,
      },
      updatedAt: request.at,
    };
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed while declaring wait");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_wait_started", {
      taskId: current.taskId,
      waitId: request.waitId,
      operationId: request.operationId,
      reason: request.reason,
      validUntil: request.validUntil,
    }, request.operationId);
    return cloneJson(next);
  });
}

export interface EndWaitRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  waitId: string;
  outcome: "completed" | "canceled" | "expired" | "failed";
  at: string;
}

export async function endTaskWait(deps: SupervisorDependencies, request: EndWaitRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (current.declaredWait === null || current.declaredWait.waitId !== request.waitId) {
      throw new SupervisorRecoveryError("declared wait identity does not match the durable task");
    }
    assertLeaseOwner(current.lease, request.ownerId, request.supervisorGenerationId);
    const operationId = current.declaredWait.operationId;
    const next: SupervisedTaskRecord = {
      ...cloneJson(current),
      lifecycle: current.endpoint === null ? "stopped" : "running",
      declaredWait: null,
      updatedAt: request.at,
    };
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed while ending wait");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_wait_ended", {
      taskId: current.taskId,
      waitId: request.waitId,
      outcome: request.outcome,
    }, operationId);
    return cloneJson(next);
  });
}
export interface ReconcileRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  at: string;
  operationId?: string;
}

export async function reconcileTask(deps: SupervisorDependencies, request: ReconcileRequest): Promise<RuntimeReconciliation> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    const mutationAllowed = await deps.locks.isMutationOwner(request.supervisorGenerationId);

    const claimLease = async (): Promise<SupervisorLease | null> => {
      if (current.lease === null) return null;
      if (current.lease.ownerId === request.ownerId && current.lease.generationId === request.supervisorGenerationId) {
        return cloneJson(current.lease);
      }
      const evidence = await deps.locks.classifyLease(current.lease);
      return acquireLease(current.lease, {
        ownerId: request.ownerId,
        generationId: request.supervisorGenerationId,
        claimedAt: request.at,
      }, evidence);
    };

    if (current.endpoint === null) {
      if (!mutationAllowed || current.lease === null
          || (current.lease.ownerId === request.ownerId && current.lease.generationId === request.supervisorGenerationId)) {
        return { task: current, runtime: null, mutationAllowed, action: "none" };
      }
      const worktree = await deps.worktrees.inspect(current.source.worktreePath);
      assertWorktreeIdentity(current, worktree);
      const nextLease = await claimLease();
      const next = normalizeTaskRecord({
        ...cloneJson(current),
        checkpoint: checkpointFrom(worktree, request.at),
        lease: nextLease,
        updatedAt: request.at,
      });
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
        throw new SupervisorRecoveryError("durable task changed during stale lease reconciliation");
      }
      return { task: cloneJson(next), runtime: null, mutationAllowed: true, action: "recovered" };
    }

    const worktree = await deps.worktrees.inspect(current.source.worktreePath);
    assertWorktreeIdentity(current, worktree);
    if (!deps.runtime.recoveryGrade) {
      return {
        task: current,
        runtime: { state: "unknown", endpointId: current.endpoint.endpointId, cwd: current.source.worktreePath, absenceProven: false },
        mutationAllowed,
        action: "ambiguous",
      };
    }
    const runtime = await deps.runtime.inspect(current.endpoint);
    assertEndpointCwd(current, runtime);
    if (runtime.state === "missing" || runtime.state === "unknown" || (runtime.state === "gone" && !runtime.absenceProven)) {
      return { task: current, runtime, mutationAllowed, action: "ambiguous" };
    }

    if (runtime.state === "alive") {
      if (!mutationAllowed) return { task: current, runtime, mutationAllowed, action: "none" };
      const needsLeaseRecovery = current.lease !== null
        && (current.lease.ownerId !== request.ownerId || current.lease.generationId !== request.supervisorGenerationId);
      const needsLifecycleRecovery = current.lifecycle === "starting";
      if (!needsLeaseRecovery && !needsLifecycleRecovery) {
        return { task: current, runtime, mutationAllowed, action: "none" };
      }
      const nextLease = current.lease === null ? null : await claimLease();
      const next = normalizeTaskRecord({
        ...cloneJson(current),
        checkpoint: checkpointFrom(worktree, request.at),
        lifecycle: needsLifecycleRecovery ? "running" : current.lifecycle,
        lease: nextLease,
        updatedAt: request.at,
      });
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
        throw new SupervisorRecoveryError("durable task changed during live runtime reconciliation");
      }
      if (needsLifecycleRecovery) {
        await assertMutationAuthority(deps, request.supervisorGenerationId);
        await deps.events.append("worker_started", {
          taskId: current.taskId,
          supervisorGenerationId: request.supervisorGenerationId,
          endpointId: current.endpoint.endpointId,
          branch: current.source.branch,
          worktreePath: current.source.worktreePath,
        }, request.operationId);
      }
      return { task: cloneJson(next), runtime, mutationAllowed: true, action: "recovered" };
    }

    if (!mutationAllowed) return { task: current, runtime, mutationAllowed, action: "stopped" };
    const nextLease = await claimLease();
    const next: SupervisedTaskRecord = {
      ...cloneJson(current),
      checkpoint: checkpointFrom(worktree, request.at),
      lifecycle: "stopped",
      lease: nextLease,
      declaredWait: null,
      stale: {
        state: "recovery-requested",
        staleWindows: Math.max(1, current.stale.staleWindows),
        lastTransitionAt: request.at,
        lastEmittedState: "recovery-requested",
      },
      updatedAt: request.at,
    };
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed during restart reconciliation");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (runtime.state === "gone") {
      await deps.events.append("runtime_endpoint_lost", {
        taskId: current.taskId,
        supervisorGenerationId: request.supervisorGenerationId,
        endpointId: current.endpoint.endpointId,
        state: "gone",
        absenceProven: true,
      }, request.operationId);
    } else {
      await deps.events.append("worker_stopped", {
        taskId: current.taskId,
        supervisorGenerationId: request.supervisorGenerationId,
        endpointId: current.endpoint.endpointId,
        reason: "runtime-dead",
      }, request.operationId);
    }
    return { task: cloneJson(next), runtime, mutationAllowed, action: "stopped" };
  });
}

const TASK_SET_LOCK_ID = "__lilac_supervisor_task_set__";

export interface StartTaskRequest {
  taskId: string;
  repositoryId: string;
  branch: string;
  worktreePath: string;
  creationHead: string;
  runtimeProfileId: string;
  ownerId: string;
  supervisorGenerationId: string;
  endpointId: string;
  at: string;
  metadata?: SupervisedTaskRecord["metadata"];
  operationId?: string;
}

export async function startTask(deps: SupervisorDependencies, request: StartTaskRequest): Promise<SupervisedTaskRecord> {
  if (request.taskId === TASK_SET_LOCK_ID) throw new SupervisorOwnershipError("taskId is reserved for supervisor lock ordering");
  return deps.locks.withTaskMutationLock(TASK_SET_LOCK_ID, async () =>
    deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!deps.runtime.recoveryGrade) {
      throw new SupervisorRuntimeError("fresh worker start requires a recovery-grade runtime state classifier");
    }
    const worktree = await deps.worktrees.inspect(request.worktreePath);
    if (!worktree.exists || !worktree.isGitWorktree || !worktree.isWorktreeRoot) {
      throw new SupervisorWorktreeError("fresh worker requires an existing Git worktree root");
    }
    if (worktree.repositoryId !== request.repositoryId) {
      throw new SupervisorWorktreeError("fresh worker repository identity differs from the requested immutable binding");
    }
    if (worktree.canonicalPath !== request.worktreePath) {
      throw new SupervisorWorktreeError("fresh worker worktree path is not canonical");
    }
    if (worktree.branch !== request.branch) {
      throw new SupervisorWorktreeError("fresh worker branch differs from the requested immutable binding");
    }
    if (worktree.head !== request.creationHead) {
      throw new SupervisorWorktreeError("fresh worker creationHead differs from the worktree HEAD");
    }
    const durableTasks = await deps.tasks.list();
    const conflictingOwner = durableTasks.find((task) =>
      task.lifecycle !== "retired"
      && task.taskId !== request.taskId
      && task.source.worktreePath === worktree.canonicalPath);
    if (conflictingOwner !== undefined) {
      throw new SupervisorWorktreeError(`worktree is already bound to durable task ${conflictingOwner.taskId}`);
    }
    const endpoint: RuntimeEndpointIdentity = {
      endpointId: request.endpointId,
      backend: "local-process",
      attachedAt: request.at,
    };
    const starting = normalizeTaskRecord({
      version: 1,
      taskId: request.taskId,
      source: {
        repositoryId: request.repositoryId,
        branch: request.branch,
        worktreePath: request.worktreePath,
        creationHead: request.creationHead,
      },
      checkpoint: checkpointFrom(worktree, request.at),
      runtimeProfileId: request.runtimeProfileId,
      endpoint,
      lifecycle: "starting",
      lease: acquireLease(null, {
        ownerId: request.ownerId,
        generationId: request.supervisorGenerationId,
        claimedAt: request.at,
      }, null),
      lastProgress: null,
      declaredWait: null,
      wakeCursor: 0,
      stale: {
        state: "healthy",
        staleWindows: 0,
        lastTransitionAt: request.at,
        lastEmittedState: null,
      },
      createdAt: request.at,
      updatedAt: request.at,
      metadata: request.metadata ?? null,
    });
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.create(starting)) {
      throw new SupervisorRecoveryError(`task ${request.taskId} already has durable identity`);
    }
    let launched: RuntimeEvidence;
    try {
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      launched = await deps.runtime.launch({
        taskId: starting.taskId,
        runtimeProfileId: starting.runtimeProfileId,
        worktreePath: starting.source.worktreePath,
        endpoint,
        supervisorGenerationId: request.supervisorGenerationId,
      });
      if (launched.state !== "alive" || launched.endpointId !== endpoint.endpointId) {
        throw new SupervisorRuntimeError("fresh worker launch did not confirm the requested live endpoint identity");
      }
      assertEndpointCwd(starting, launched);
    } catch (error) {
      if (await deps.locks.isMutationOwner(request.supervisorGenerationId)) {
        const failed = normalizeTaskRecord({
          ...cloneJson(starting),
          lifecycle: "failed",
          updatedAt: request.at,
        });
        await deps.tasks.compareAndSwap(starting.taskId, starting, failed);
        await deps.events.append("worker_failed", {
          taskId: starting.taskId,
          supervisorGenerationId: request.supervisorGenerationId,
          endpointId: endpoint.endpointId,
          error: error instanceof Error ? error.message : String(error),
        }, request.operationId);
      }
      throw error;
    }
    const running = normalizeTaskRecord({
      ...cloneJson(starting),
      lifecycle: "running",
      updatedAt: request.at,
    });
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(starting.taskId, starting, running)) {
      try { await deps.runtime.stop(endpoint); } catch { /* abort cleanup is best-effort; durable conflict remains primary */ }
      throw new SupervisorRecoveryError("fresh worker durable publication conflicted after launch");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_started", {
      taskId: running.taskId,
      supervisorGenerationId: request.supervisorGenerationId,
      endpointId: endpoint.endpointId,
      branch: running.source.branch,
      worktreePath: running.source.worktreePath,
    }, request.operationId);
    return cloneJson(running);
  }));
}

export interface TaskInspection {
  task: SupervisedTaskRecord;
  worktree: WorktreeEvidence;
  runtime: RuntimeEvidence | null;
  mutationAllowed: boolean;
}

export async function inspectTask(
  deps: SupervisorDependencies,
  taskId: string,
  supervisorGenerationId: string,
): Promise<TaskInspection> {
  const task = normalizeTaskRecord(await deps.tasks.read(taskId));
  const worktree = await deps.worktrees.inspect(task.source.worktreePath);
  assertWorktreeIdentity(task, worktree);
  const runtime = task.endpoint === null ? null : await deps.runtime.inspect(task.endpoint);
  if (runtime !== null) assertEndpointCwd(task, runtime);
  return {
    task,
    worktree,
    runtime,
    mutationAllowed: await deps.locks.isMutationOwner(supervisorGenerationId),
  };
}

export interface InterruptTaskRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
}

export async function interruptTask(deps: SupervisorDependencies, request: InterruptTaskRequest): Promise<RuntimeEvidence> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    assertLeaseOwner(current.lease, request.ownerId, request.supervisorGenerationId);
    if (current.endpoint === null) throw new SupervisorRuntimeError("task has no attached runtime endpoint to interrupt");
    const before = await deps.runtime.inspect(current.endpoint);
    assertEndpointCwd(current, before);
    if (before.state !== "alive") throw new SupervisorRuntimeError(`interrupt requires a live runtime, observed ${before.state}`);
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const after = await deps.runtime.interrupt(current.endpoint);
    if (after.endpointId !== null && after.endpointId !== current.endpoint.endpointId) {
      throw new SupervisorRuntimeError("interrupt returned a different runtime endpoint identity");
    }
    assertEndpointCwd(current, after);
    if (after.state === "missing" || after.state === "unknown" || (after.state === "gone" && !after.absenceProven)) {
      throw new SupervisorRuntimeError(`interrupt outcome ${after.state} is ambiguous`);
    }
    return cloneJson(after);
  });
}

export interface DetachTaskRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  at: string;
  operationId?: string;
}

export async function detachTask(deps: SupervisorDependencies, request: DetachTaskRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    assertLeaseOwner(current.lease, request.ownerId, request.supervisorGenerationId);
    if (current.endpoint === null) return cloneJson(current);
    if (!deps.runtime.recoveryGrade) {
      throw new SupervisorRuntimeError("runtime detach requires a recovery-grade runtime state classifier");
    }
    const worktree = await deps.worktrees.inspect(current.source.worktreePath);
    assertWorktreeIdentity(current, worktree);
    const runtime = await deps.runtime.inspect(current.endpoint);
    assertEndpointCwd(current, runtime);
    assertReplacementAllowed(runtime);
    const next = normalizeTaskRecord({
      ...cloneJson(current),
      checkpoint: checkpointFrom(worktree, request.at),
      endpoint: null,
      lifecycle: current.lifecycle === "retired" ? "retired" : "stopped",
      declaredWait: null,
      updatedAt: request.at,
    });
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed during runtime detach");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_stopped", {
      taskId: current.taskId,
      supervisorGenerationId: request.supervisorGenerationId,
      endpointId: current.endpoint.endpointId,
      reason: "runtime-detached",
    }, request.operationId);
    return cloneJson(next);
  });
}

export interface RetireTaskRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  reason: string;
  at: string;
  operationId?: string;
}

export async function retireTask(deps: SupervisorDependencies, request: RetireTaskRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (current.lifecycle === "retired") return cloneJson(current);
    assertLeaseOwner(current.lease, request.ownerId, request.supervisorGenerationId);
    const worktree = await deps.worktrees.inspect(current.source.worktreePath);
    assertWorktreeIdentity(current, worktree);
    if (current.endpoint !== null) {
      if (!deps.runtime.recoveryGrade) {
        throw new SupervisorRuntimeError("task retirement requires a recovery-grade runtime state classifier");
      }
      const runtime = await deps.runtime.inspect(current.endpoint);
      assertEndpointCwd(current, runtime);
      assertReplacementAllowed(runtime);
    }
    const next = normalizeTaskRecord({
      ...cloneJson(current),
      checkpoint: checkpointFrom(worktree, request.at),
      endpoint: null,
      lifecycle: "retired",
      lease: releaseLease(current.lease, request.ownerId, request.supervisorGenerationId),
      declaredWait: null,
      updatedAt: request.at,
    });
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed during retirement");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("worker_retired", { taskId: current.taskId, reason: request.reason }, request.operationId);
    return cloneJson(next);
  });
}

export interface ProgressUpdateRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  eventSequence: number;
  at: string;
  operationId?: string;
}

export async function recordTaskProgress(deps: SupervisorDependencies, request: ProgressUpdateRequest): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!Number.isSafeInteger(request.eventSequence) || request.eventSequence < 0) {
      throw new SupervisorRuntimeError("progress eventSequence must be a non-negative safe integer");
    }
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (!["starting", "running", "waiting", "recovering"].includes(current.lifecycle)) {
      throw new SupervisorRuntimeError(`task lifecycle ${current.lifecycle} does not accept progress checkpoints`);
    }
    assertLeaseOwner(current.lease, request.ownerId, request.supervisorGenerationId);
    const worktree = await deps.worktrees.inspect(current.source.worktreePath);
    assertWorktreeIdentity(current, worktree);
    const prior = current.lastProgress;
    if (prior !== null && request.eventSequence < prior.eventSequence) {
      throw new SupervisorRuntimeError("progress eventSequence cannot move backwards");
    }
    if (prior !== null
        && request.eventSequence === prior.eventSequence
        && prior.sourceHead === worktree.head
        && prior.dirtyDigest === worktree.dirtyDigest) {
      return cloneJson(current);
    }
    if (prior !== null && request.eventSequence === prior.eventSequence) {
      throw new SupervisorRuntimeError("progress evidence changed without advancing eventSequence");
    }
    const next = normalizeTaskRecord({
      ...cloneJson(current),
      checkpoint: checkpointFrom(worktree, request.at),
      lastProgress: {
        sourceHead: worktree.head,
        dirtyDigest: worktree.dirtyDigest,
        eventSequence: request.eventSequence,
        recordedAt: request.at,
      },
      stale: {
        state: "healthy",
        staleWindows: 0,
        lastTransitionAt: request.at,
        lastEmittedState: current.stale.lastEmittedState,
      },
      updatedAt: request.at,
    });
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed while recording progress");
    }
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    await deps.events.append("progress_checkpoint_changed", {
      taskId: current.taskId,
      sourceHead: worktree.head,
      dirtyDigest: worktree.dirtyDigest,
      sourceSequence: request.eventSequence,
    }, request.operationId);
    return cloneJson(next);
  });
}

export interface EvaluateLivenessRequest {
  taskId: string;
  ownerId: string;
  supervisorGenerationId: string;
  activeOperation: boolean;
  staleAfterMs: number;
  confirmAfterMs: number;
  at: string;
  operationId?: string;
}

export async function evaluateTaskLiveness(
  deps: SupervisorDependencies,
  request: EvaluateLivenessRequest,
): Promise<SupervisedTaskRecord> {
  return deps.locks.withTaskMutationLock(request.taskId, async () => {
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    const current = normalizeTaskRecord(await deps.tasks.read(request.taskId));
    if (!["starting", "running", "waiting", "recovering"].includes(current.lifecycle)) return cloneJson(current);
    assertLeaseOwner(current.lease, request.ownerId, request.supervisorGenerationId);
    let runtime: RuntimeEvidence = { state: "dead", endpointId: null, cwd: null, absenceProven: true };
    if (current.endpoint !== null) {
      runtime = await deps.runtime.inspect(current.endpoint);
      assertEndpointCwd(current, runtime);
    }
    const classification = classifyLiveness(current.stale, {
      runtime: runtime.state,
      activeOperation: request.activeOperation,
      now: request.at,
      staleAfterMs: request.staleAfterMs,
      confirmAfterMs: request.confirmAfterMs,
      lastProgressAt: current.lastProgress?.recordedAt ?? current.checkpoint.recordedAt,
      currentProgress: current.lastProgress,
      previousProgress: current.lastProgress,
      declaredWait: current.declaredWait,
    });
    const applied = applyLivenessClassification(current.stale, classification, request.at);
    if (!classification.changed && !applied.shouldEmit) return cloneJson(current);
    const next = normalizeTaskRecord({ ...cloneJson(current), stale: applied.state, updatedAt: request.at });
    await assertMutationAuthority(deps, request.supervisorGenerationId);
    if (!await deps.tasks.compareAndSwap(current.taskId, current, next)) {
      throw new SupervisorRecoveryError("durable task changed during liveness classification");
    }
    if (applied.shouldEmit) {
      await assertMutationAuthority(deps, request.supervisorGenerationId);
      if (classification.state === "stale-suspected") {
        await deps.events.append("worker_wedge_suspected", {
          taskId: current.taskId,
          staleWindows: classification.staleWindows,
          reason: classification.reason,
        }, request.operationId);
      } else if (classification.state !== "healthy") {
        await deps.events.append("worker_stale_escalated", {
          taskId: current.taskId,
          from: current.stale.state,
          to: classification.state,
          staleWindows: classification.staleWindows,
        }, request.operationId);
      }
    }
    return cloneJson(next);
  });
}
