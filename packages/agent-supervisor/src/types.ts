import type { JsonValue } from "@lilac/agent-runtime";

export const SUPERVISOR_SCHEMA_VERSION = 1;
export const MAX_SUPERVISOR_ID_LENGTH = 256;
export const MAX_PATH_LENGTH = 4096;
export const MAX_REASON_LENGTH = 4096;
export const MAX_QUEUE_ENTRIES = 4096;
export const MAX_TASK_RECORD_BYTES = 1024 * 1024;
export const MAX_QUEUE_RECORD_BYTES = 4 * 1024 * 1024;

export type WorkerLifecycleState =
  | "created"
  | "starting"
  | "running"
  | "waiting"
  | "stopped"
  | "failed"
  | "recovering"
  | "retired";

export type RuntimeLiveness = "alive" | "dead" | "missing" | "unknown" | "gone";

export type StaleEscalationState =
  | "healthy"
  | "stale-suspected"
  | "stale-confirmed"
  | "recovery-requested"
  | "recovering"
  | "recovered"
  | "recovery-refused"
  | "terminal-failure";

export interface SourceIdentity {
  repositoryId: string;
  branch: string;
  worktreePath: string;
  creationHead: string;
}

export interface RuntimeEndpointIdentity {
  endpointId: string;
  backend: "local-process";
  attachedAt: string;
}

export interface SupervisorLease {
  ownerId: string;
  generationId: string;
  claimedAt: string;
}

export interface DirtyStateCheckpoint {
  head: string;
  dirty: boolean;
  digest: string;
  recordedAt: string;
}

export interface DeclaredWait {
  waitId: string;
  operationId: string;
  reason: string;
  startedAt: string;
  validUntil: string;
}

export interface ProgressCheckpoint {
  sourceHead: string;
  dirtyDigest: string;
  eventSequence: number;
  recordedAt: string;
}

export interface StaleState {
  state: StaleEscalationState;
  staleWindows: number;
  lastTransitionAt: string;
  lastEmittedState: StaleEscalationState | null;
}

export interface SupervisedTaskRecord {
  version: number;
  taskId: string;
  source: SourceIdentity;
  checkpoint: DirtyStateCheckpoint;
  runtimeProfileId: string;
  endpoint: RuntimeEndpointIdentity | null;
  lifecycle: WorkerLifecycleState;
  lease: SupervisorLease | null;
  lastProgress: ProgressCheckpoint | null;
  declaredWait: DeclaredWait | null;
  wakeCursor: number;
  stale: StaleState;
  createdAt: string;
  updatedAt: string;
  metadata: JsonValue | null;
}

export interface WorktreeEvidence {
  exists: boolean;
  repositoryId: string;
  isGitWorktree: boolean;
  isWorktreeRoot: boolean;
  canonicalPath: string;
  branch: string;
  head: string;
  dirty: boolean;
  dirtyDigest: string;
}

export interface RuntimeEvidence {
  state: RuntimeLiveness;
  endpointId: string | null;
  cwd: string | null;
  absenceProven: boolean;
}

export interface LeaseLivenessEvidence {
  status: "live" | "stale" | "unknown";
  ownerId: string;
  generationId: string;
}
export interface SupervisorQueueEntry {
  sequence: number;
  eventId: string;
  taskId: string;
  eventKind: string;
  enqueuedAt: string;
}

export interface SupervisorQueueState {
  version: number;
  nextSequence: number;
  acknowledgedSequence: number;
  entries: SupervisorQueueEntry[];
}

export type RecoveryPhase =
  | "prepared"
  | "checkpointed"
  | "stopping"
  | "stopped"
  | "launching"
  | "published"
  | "completed"
  | "refused"
  | "failed";

export interface RecoveryJournal {
  version: number;
  recoveryId: string;
  taskId: string;
  supervisorGenerationId: string;
  phase: RecoveryPhase;
  priorEndpointId: string | null;
  replacementEndpointId: string | null;
  checkpoint: DirtyStateCheckpoint | null;
  reason: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface LivenessSignals {
  runtime: RuntimeLiveness;
  activeOperation: boolean;
  now: string;
  staleAfterMs: number;
  confirmAfterMs: number;
  lastProgressAt: string | null;
  currentProgress: ProgressCheckpoint | null;
  previousProgress: ProgressCheckpoint | null;
  declaredWait: DeclaredWait | null;
}

export interface LivenessClassification {
  state: StaleEscalationState;
  staleWindows: number;
  changed: boolean;
  reason: string;
}