export const AGENT_WORKSPACE_SCHEMA_VERSION = 1;

export const AGENT_WORKSPACE_HARD_LIMITS = {
  maxRoles: 64,
  maxCapabilitiesPerRole: 32,
  maxAssignments: 1024,
  maxRuns: 1024,
  maxActionsPerRun: 1024,
  maxAffectedNodes: 256,
  maxReasonLength: 2048,
} as const;

export const RUN_STATUSES = ["active", "cancelled", "completed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface WorkspaceRole {
  id: string;
  title: string;
  description: string;
  capabilities: string[];
}

export interface RoleAssignment {
  assignmentId: string;
  roleId: string;
  taskId: string;
  actorId: string;
  capabilities: string[];
  assignedAt: string;
}

export interface AgentAction {
  actionId: string;
  runId: string;
  actorId: string;
  roleId: string;
  intent: string;
  tool: string;
  operation: string;
  affectedNodes: string[];
  transactionId: string | null;
  reversible: boolean;
  reverted: boolean;
  revertedBy: string | null;
  at: string;
}

export interface TaskRun {
  runId: string;
  taskId: string;
  roleId: string;
  actorId: string;
  intent: string;
  status: RunStatus;
  cancelReason: string | null;
  startedAt: string;
  endedAt: string | null;
  actions: AgentAction[];
}
