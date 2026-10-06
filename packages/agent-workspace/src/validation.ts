import { createHash } from "node:crypto";
import { AgentWorkspaceValidationError } from "./errors.ts";
import {
  AGENT_WORKSPACE_HARD_LIMITS,
  AGENT_WORKSPACE_SCHEMA_VERSION,
  RUN_STATUSES,
  type AgentAction,
  type RoleAssignment,
  type TaskRun,
  type WorkspaceRole,
} from "./types.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalWorkspaceStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new AgentWorkspaceValidationError("workspace value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalWorkspaceStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalWorkspaceStringify(record[key])}`).join(",")}}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentWorkspaceValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentWorkspaceValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new AgentWorkspaceValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentWorkspaceValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new AgentWorkspaceValidationError(`${label} exceeds ${max} characters`);
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 128);
  if (Number.isNaN(Date.parse(value))) throw new AgentWorkspaceValidationError(`${label} must be an ISO-compatible timestamp`);
}

export function assertIdentifier(value: unknown, label: string, max = 128): void {
  assertBoundedString(value, label, max);
  if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(value as string)) {
    throw new AgentWorkspaceValidationError(`${label} must be an identifier`);
  }
}

function normalizeCapabilities(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_WORKSPACE_HARD_LIMITS.maxCapabilitiesPerRole) {
    throw new AgentWorkspaceValidationError(`${label} must be a bounded non-empty array`);
  }
  for (const capability of value) assertIdentifier(capability, `${label}.capability`, 128);
  if (new Set(value as string[]).size !== (value as string[]).length) {
    throw new AgentWorkspaceValidationError(`${label} must be distinct`);
  }
  return [...value as string[]];
}

export function normalizeRole(value: unknown): WorkspaceRole {
  assertPlainObject(value, "workspace.role");
  assertAllowedKeys(value, ["id", "title", "description", "capabilities"], "workspace.role");
  assertIdentifier(value.id, "workspace.role.id");
  assertBoundedString(value.title, "workspace.role.title", 256);
  assertBoundedString(value.description, "workspace.role.description", 2048);
  return {
    id: value.id as string,
    title: value.title as string,
    description: value.description as string,
    capabilities: normalizeCapabilities(value.capabilities, "workspace.role.capabilities"),
  };
}

export const BUILTIN_ROLES: WorkspaceRole[] = [
  {
    id: "product-designer",
    title: "Product designer",
    description: "Owns screen composition, hierarchy, and flows within the task scope.",
    capabilities: ["inspect-design", "propose-layout", "edit-copy"],
  },
  {
    id: "ux-critic",
    title: "UX critic",
    description: "Reviews flows and interactions for usability hazards; never edits directly.",
    capabilities: ["inspect-design", "file-finding"],
  },
  {
    id: "accessibility-reviewer",
    title: "Accessibility reviewer",
    description: "Checks names, labels, targets, and themes against the method rules.",
    capabilities: ["inspect-design", "file-finding", "run-method-checks"],
  },
  {
    id: "design-system-guardian",
    title: "Design-system guardian",
    description: "Guards tokens, components, and registry contracts against drift.",
    capabilities: ["inspect-design", "inspect-contract", "file-finding"],
  },
  {
    id: "frontend-implementer",
    title: "Frontend implementer",
    description: "Implements subset components through verified patches with attribution.",
    capabilities: ["inspect-design", "inspect-contract", "author-patch", "commit-proposal"],
  },
  {
    id: "content-reviewer",
    title: "Content reviewer",
    description: "Reviews copy, tone, and terminology; proposes text edits.",
    capabilities: ["inspect-design", "propose-copy", "file-finding"],
  },
  {
    id: "visual-regression-reviewer",
    title: "Visual-regression reviewer",
    description: "Compares snapshots across revisions and reports visual drift.",
    capabilities: ["inspect-design", "compare-snapshots", "file-finding"],
  },
];

export function builtinRoles(): WorkspaceRole[] {
  return BUILTIN_ROLES.map((role) => normalizeRole(role));
}

export function normalizeAssignment(value: unknown): RoleAssignment {
  assertPlainObject(value, "workspace.assignment");
  assertAllowedKeys(value, ["assignmentId", "roleId", "taskId", "actorId", "capabilities", "assignedAt"], "workspace.assignment");
  assertBoundedString(value.assignmentId, "workspace.assignment.assignmentId", 256);
  assertIdentifier(value.roleId, "workspace.assignment.roleId");
  assertBoundedString(value.taskId, "workspace.assignment.taskId", 256);
  assertBoundedString(value.actorId, "workspace.assignment.actorId", 256);
  assertTimestamp(value.assignedAt, "workspace.assignment.assignedAt");
  return {
    assignmentId: value.assignmentId as string,
    roleId: value.roleId as string,
    taskId: value.taskId as string,
    actorId: value.actorId as string,
    capabilities: normalizeCapabilities(value.capabilities, "workspace.assignment.capabilities"),
    assignedAt: value.assignedAt as string,
  };
}

export function normalizeAction(value: unknown): AgentAction {
  assertPlainObject(value, "workspace.action");
  assertAllowedKeys(value, ["actionId", "runId", "actorId", "roleId", "intent", "tool", "operation", "affectedNodes", "transactionId", "reversible", "reverted", "revertedBy", "at"], "workspace.action");
  assertBoundedString(value.actionId, "workspace.action.actionId", 256);
  assertBoundedString(value.runId, "workspace.action.runId", 256);
  assertBoundedString(value.actorId, "workspace.action.actorId", 256);
  assertIdentifier(value.roleId, "workspace.action.roleId");
  assertBoundedString(value.intent, "workspace.action.intent", 2048);
  assertBoundedString(value.tool, "workspace.action.tool", 256);
  assertBoundedString(value.operation, "workspace.action.operation", 1024);
  if (!Array.isArray(value.affectedNodes) || value.affectedNodes.length > AGENT_WORKSPACE_HARD_LIMITS.maxAffectedNodes) {
    throw new AgentWorkspaceValidationError("workspace.action.affectedNodes exceeds its bounded budget");
  }
  for (const node of value.affectedNodes) assertBoundedString(node, "workspace.action.node", 256);
  if (value.transactionId !== null) assertBoundedString(value.transactionId, "workspace.action.transactionId", 256);
  if (typeof value.reversible !== "boolean" || typeof value.reverted !== "boolean") {
    throw new AgentWorkspaceValidationError("workspace.action reversible flags must be booleans");
  }
  if (value.revertedBy !== null) assertBoundedString(value.revertedBy, "workspace.action.revertedBy", 256);
  if (value.reverted && !value.reversible) {
    throw new AgentWorkspaceValidationError("workspace.action cannot be reverted when not reversible");
  }
  assertTimestamp(value.at, "workspace.action.at");
  return {
    actionId: value.actionId as string,
    runId: value.runId as string,
    actorId: value.actorId as string,
    roleId: value.roleId as string,
    intent: value.intent as string,
    tool: value.tool as string,
    operation: value.operation as string,
    affectedNodes: [...value.affectedNodes as string[]],
    transactionId: value.transactionId as string | null,
    reversible: value.reversible as boolean,
    reverted: value.reverted as boolean,
    revertedBy: value.revertedBy as string | null,
    at: value.at as string,
  };
}

export function normalizeRun(value: unknown): TaskRun {
  assertPlainObject(value, "workspace.run");
  assertAllowedKeys(value, ["runId", "taskId", "roleId", "actorId", "intent", "status", "cancelReason", "startedAt", "endedAt", "actions"], "workspace.run");
  assertBoundedString(value.runId, "workspace.run.runId", 256);
  assertBoundedString(value.taskId, "workspace.run.taskId", 256);
  assertIdentifier(value.roleId, "workspace.run.roleId");
  assertBoundedString(value.actorId, "workspace.run.actorId", 256);
  assertBoundedString(value.intent, "workspace.run.intent", 2048);
  if (!RUN_STATUSES.includes(value.status as (typeof RUN_STATUSES)[number])) {
    throw new AgentWorkspaceValidationError("workspace.run.status is unsupported");
  }
  if (value.cancelReason !== null) assertBoundedString(value.cancelReason, "workspace.run.cancelReason", AGENT_WORKSPACE_HARD_LIMITS.maxReasonLength);
  assertTimestamp(value.startedAt, "workspace.run.startedAt");
  if (value.endedAt !== null) assertTimestamp(value.endedAt, "workspace.run.endedAt");
  if (!Array.isArray(value.actions) || value.actions.length > AGENT_WORKSPACE_HARD_LIMITS.maxActionsPerRun) {
    throw new AgentWorkspaceValidationError("workspace.run.actions exceeds its bounded budget");
  }
  const actions = (value.actions as unknown[]).map(normalizeAction);
  if (new Set(actions.map((action) => action.actionId)).size !== actions.length) {
    throw new AgentWorkspaceValidationError("workspace.run action ids must be distinct");
  }
  for (const action of actions) {
    if (action.runId !== value.runId) throw new AgentWorkspaceValidationError("workspace.run actions must belong to the run");
  }
  return {
    runId: value.runId as string,
    taskId: value.taskId as string,
    roleId: value.roleId as string,
    actorId: value.actorId as string,
    intent: value.intent as string,
    status: value.status as TaskRun["status"],
    cancelReason: value.cancelReason as string | null,
    startedAt: value.startedAt as string,
    endedAt: value.endedAt as string | null,
    actions,
  };
}
