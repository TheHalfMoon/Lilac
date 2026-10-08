import { cloneJson } from "@ninerr/agent-runtime";
import { SupervisorRecoveryError } from "./errors.ts";
import { SUPERVISOR_SCHEMA_VERSION, type DirtyStateCheckpoint, type RecoveryJournal, type RecoveryPhase, type RuntimeEvidence } from "./types.ts";

const NEXT_PHASES: Record<RecoveryPhase, ReadonlySet<RecoveryPhase>> = {
  prepared: new Set(["checkpointed", "refused", "failed"]),
  checkpointed: new Set(["stopping", "stopped", "refused", "failed"]),
  stopping: new Set(["stopped", "refused", "failed"]),
  stopped: new Set(["launching", "refused", "failed"]),
  launching: new Set(["published", "refused", "failed"]),
  published: new Set(["completed", "failed"]),
  completed: new Set(),
  refused: new Set(),
  failed: new Set(),
};

export function createRecoveryJournal(input: {
  recoveryId: string;
  taskId: string;
  supervisorGenerationId: string;
  priorEndpointId: string | null;
  startedAt: string;
}): RecoveryJournal {
  if (Number.isNaN(Date.parse(input.startedAt))) throw new SupervisorRecoveryError("recovery startedAt is invalid");
  return {
    version: SUPERVISOR_SCHEMA_VERSION,
    recoveryId: input.recoveryId,
    taskId: input.taskId,
    supervisorGenerationId: input.supervisorGenerationId,
    phase: "prepared",
    priorEndpointId: input.priorEndpointId,
    replacementEndpointId: null,
    checkpoint: null,
    reason: null,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
  };
}

export function advanceRecoveryJournal(
  journal: RecoveryJournal,
  phase: RecoveryPhase,
  updatedAt: string,
  changes: { checkpoint?: DirtyStateCheckpoint; replacementEndpointId?: string; reason?: string } = {},
): RecoveryJournal {
  if (!NEXT_PHASES[journal.phase].has(phase)) {
    throw new SupervisorRecoveryError(`recovery phase ${journal.phase} cannot transition to ${phase}`);
  }
  if (Number.isNaN(Date.parse(updatedAt)) || Date.parse(updatedAt) < Date.parse(journal.updatedAt)) {
    throw new SupervisorRecoveryError("recovery updatedAt is invalid or moves backwards");
  }
  return {
    ...cloneJson(journal),
    phase,
    checkpoint: changes.checkpoint === undefined ? journal.checkpoint : cloneJson(changes.checkpoint),
    replacementEndpointId: changes.replacementEndpointId ?? journal.replacementEndpointId,
    reason: changes.reason ?? journal.reason,
    updatedAt,
  };
}

export function assertReplacementAllowed(evidence: RuntimeEvidence): void {
  if (evidence.state === "dead") return;
  if (evidence.state === "gone" && evidence.absenceProven) return;
  if (evidence.state === "alive") throw new SupervisorRecoveryError("replacement refused while the prior runtime is alive");
  if (evidence.state === "gone") throw new SupervisorRecoveryError("runtime absence is not positively proven");
  throw new SupervisorRecoveryError(`runtime state ${evidence.state} is not positive agent-free evidence`);
}