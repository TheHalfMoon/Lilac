import { AgentWorkspaceConflictError, AgentWorkspaceValidationError } from "./errors.ts";
import {
  type AgentAction,
  type RoleAssignment,
  type TaskRun,
  type WorkspaceRole,
} from "./types.ts";
import {
  builtinRoles,
  normalizeAction,
  normalizeAssignment,
  normalizeRole,
  normalizeRun,
} from "./validation.ts";

export interface WorkspaceStore {
  roles: Record<string, WorkspaceRole>;
  assignments: Record<string, RoleAssignment>;
  runs: Record<string, TaskRun>;
}

export function createWorkspaceStore(customRoles: unknown[] = []): WorkspaceStore {
  const roles: Record<string, WorkspaceRole> = Object.create(null);
  for (const role of [...builtinRoles(), ...customRoles.map(normalizeRole)]) {
    if (roles[role.id]) throw new AgentWorkspaceConflictError(`workspace role ${role.id} is defined twice`);
    roles[role.id] = role;
  }
  return { roles, assignments: Object.create(null), runs: Object.create(null) };
}

export function assignRole(
  store: WorkspaceStore,
  assignmentInput: { assignmentId: string; roleId: string; taskId: string; actorId: string; capabilities?: string[]; assignedAt: string },
): WorkspaceStore {
  const role = store.roles[assignmentInput.roleId];
  if (!role) throw new AgentWorkspaceValidationError(`workspace role ${assignmentInput.roleId} is unknown`);
  const capabilities = assignmentInput.capabilities ?? role.capabilities;
  for (const capability of capabilities) {
    if (!role.capabilities.includes(capability)) {
      throw new AgentWorkspaceValidationError(`role ${role.id} does not grant capability ${capability}`);
    }
  }
  const assignment = normalizeAssignment({ ...assignmentInput, capabilities });
  if (store.assignments[assignment.assignmentId]) {
    throw new AgentWorkspaceConflictError(`assignment ${assignment.assignmentId} already exists`);
  }
  if (Object.keys(store.assignments).length >= 1024) {
    throw new AgentWorkspaceValidationError("workspace assignments exceed the bounded budget");
  }
  return { ...store, assignments: { ...store.assignments, [assignment.assignmentId]: assignment } };
}

export function startRun(
  store: WorkspaceStore,
  runInput: { runId: string; taskId: string; roleId: string; actorId: string; intent: string; startedAt: string },
): WorkspaceStore {
  if (!store.roles[runInput.roleId]) throw new AgentWorkspaceValidationError(`workspace role ${runInput.roleId} is unknown`);
  if (Object.keys(store.runs).length >= 1024) {
    throw new AgentWorkspaceValidationError("workspace runs exceed the bounded budget");
  }
  const run = normalizeRun({
    ...runInput,
    status: "active",
    cancelReason: null,
    endedAt: null,
    actions: [],
  });
  if (store.runs[run.runId]) throw new AgentWorkspaceConflictError(`run ${run.runId} already exists`);
  return { ...store, runs: { ...store.runs, [run.runId]: run } };
}

function capabilitiesFor(store: WorkspaceStore, run: TaskRun): string[] {
  const assignment = Object.values(store.assignments).find(
    (entry) => entry.taskId === run.taskId && entry.roleId === run.roleId && entry.actorId === run.actorId,
  );
  if (assignment) return assignment.capabilities;
  return store.roles[run.roleId]?.capabilities ?? [];
}

function requiredCapability(tool: string): string {
  if (tool === "inspect" || tool.startsWith("inspect-")) return tool;
  if (tool === "propose" || tool.startsWith("propose-")) return tool;
  if (tool === "file-finding" || tool === "compare-snapshots") return tool;
  return "author-patch";
}

export function recordAction(
  store: WorkspaceStore,
  actionInput: Omit<AgentAction, "reverted" | "revertedBy"> & { reverted?: boolean; revertedBy?: string | null },
): WorkspaceStore {
  const run = store.runs[actionInput.runId];
  if (!run) throw new AgentWorkspaceValidationError(`workspace run ${actionInput.runId} is unknown`);
  if (run.status !== "active") {
    throw new AgentWorkspaceConflictError(`workspace run ${run.runId} is ${run.status}; later actions are rejected`);
  }
  if (actionInput.actorId !== run.actorId || actionInput.roleId !== run.roleId) {
    throw new AgentWorkspaceValidationError("workspace action actor and role must match the run");
  }
  const scope = capabilitiesFor(store, run);
  const required = requiredCapability(actionInput.tool);
  if (!scope.includes(actionInput.tool) && !scope.includes(required)) {
    throw new AgentWorkspaceValidationError(`tool ${actionInput.tool} is outside the role scope`);
  }
  const action = normalizeAction({ ...actionInput, reverted: false, revertedBy: null });
  if (run.actions.some((entry) => entry.actionId === action.actionId)) {
    throw new AgentWorkspaceConflictError(`action ${action.actionId} already exists`);
  }
  const next: TaskRun = { ...run, actions: [...run.actions, action] };
  return { ...store, runs: { ...store.runs, [run.runId]: next } };
}

export function cancelRun(store: WorkspaceStore, runId: string, reason: string, endedAt: string): WorkspaceStore {
  const run = store.runs[runId];
  if (!run) throw new AgentWorkspaceValidationError(`workspace run ${runId} is unknown`);
  if (run.status !== "active") throw new AgentWorkspaceConflictError(`workspace run ${runId} is already ${run.status}`);
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > 2048) {
    throw new AgentWorkspaceValidationError("cancel reason must be a bounded non-empty string");
  }
  const next: TaskRun = { ...run, status: "cancelled", cancelReason: reason, endedAt };
  normalizeRun(next);
  return { ...store, runs: { ...store.runs, [runId]: next } };
}

export function completeRun(store: WorkspaceStore, runId: string, endedAt: string): WorkspaceStore {
  const run = store.runs[runId];
  if (!run) throw new AgentWorkspaceValidationError(`workspace run ${runId} is unknown`);
  if (run.status !== "active") throw new AgentWorkspaceConflictError(`workspace run ${runId} is already ${run.status}`);
  const next: TaskRun = { ...run, status: "completed", endedAt };
  normalizeRun(next);
  return { ...store, runs: { ...store.runs, [runId]: next } };
}

export function revertAction(
  store: WorkspaceStore,
  runId: string,
  actionId: string,
  reversingTransactionId: string,
): WorkspaceStore {
  const run = store.runs[runId];
  if (!run) throw new AgentWorkspaceValidationError(`workspace run ${runId} is unknown`);
  const index = run.actions.findIndex((entry) => entry.actionId === actionId);
  if (index === -1) throw new AgentWorkspaceValidationError(`workspace action ${actionId} is unknown`);
  const action = run.actions[index];
  if (!action.reversible) throw new AgentWorkspaceValidationError(`workspace action ${actionId} is not reversible`);
  if (action.reverted) throw new AgentWorkspaceConflictError(`workspace action ${actionId} was already reverted`);
  if (typeof reversingTransactionId !== "string" || reversingTransactionId.trim() === "") {
    throw new AgentWorkspaceValidationError("reversing transaction id is required");
  }
  const actions = [...run.actions];
  actions[index] = { ...action, reverted: true, revertedBy: reversingTransactionId };
  const next: TaskRun = { ...run, actions };
  return { ...store, runs: { ...store.runs, [runId]: next } };
}
