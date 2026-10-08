import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_WORKSPACE_PROVENANCE,
  AGENT_WORKSPACE_SCHEMA_VERSION,
  AgentWorkspaceConflictError,
  AgentWorkspaceValidationError,
  assignRole,
  builtinRoles,
  cancelRun,
  canonicalWorkspaceStringify,
  completeRun,
  createWorkspaceStore,
  normalizeRole,
  recordAction,
  revertAction,
  sha256Text,
  startRun,
} from "../packages/agent-workspace/src/index.ts";

const AT = "2026-10-06T00:00:00.000Z";

function action(overrides = {}) {
  return {
    actionId: overrides.actionId ?? "action-1",
    runId: overrides.runId ?? "run-1",
    actorId: overrides.actorId ?? "agent-1",
    roleId: overrides.roleId ?? "frontend-implementer",
    intent: overrides.intent ?? "Apply accent variant",
    tool: overrides.tool ?? "author-patch",
    operation: overrides.operation ?? "update-prop tone",
    affectedNodes: overrides.affectedNodes ?? ["node-1"],
    transactionId: overrides.transactionId ?? "tx-1",
    reversible: overrides.reversible ?? true,
    at: overrides.at ?? AT,
  };
}

function assignedStore() {
  let store = createWorkspaceStore();
  store = assignRole(store, {
    assignmentId: "assign-1",
    roleId: "frontend-implementer",
    taskId: "task-1",
    actorId: "agent-1",
    assignedAt: AT,
  });
  store = startRun(store, {
    runId: "run-1",
    taskId: "task-1",
    roleId: "frontend-implementer",
    actorId: "agent-1",
    intent: "Apply accent variant",
    startedAt: AT,
  });
  return store;
}

test("built-in roles validate with the program set", () => {
  const roles = builtinRoles();
  const ids = roles.map((role) => role.id).sort();
  assert.deepEqual(ids, [
    "accessibility-reviewer",
    "content-reviewer",
    "design-system-guardian",
    "frontend-implementer",
    "product-designer",
    "ux-critic",
    "visual-regression-reviewer",
  ]);
  assert.throws(() => normalizeRole({ ...roles[0], capabilities: [] }), AgentWorkspaceValidationError);
  assert.throws(() => createWorkspaceStore([{ ...roles[0] }]), AgentWorkspaceConflictError);
});

test("assignment binds known roles, tasks, and scopes", () => {
  const store = assignedStore();
  assert.equal(store.assignments["assign-1"].capabilities.includes("author-patch"), true);
  assert.throws(() => assignRole(store, {
    assignmentId: "assign-2", roleId: "no-such-role", taskId: "task-1", actorId: "agent-1", assignedAt: AT,
  }), AgentWorkspaceValidationError);
  assert.throws(() => assignRole(store, {
    assignmentId: "assign-2", roleId: "ux-critic", taskId: "task-1", actorId: "agent-1",
    capabilities: ["author-patch"], assignedAt: AT,
  }), /does not grant capability/u);
  assert.throws(() => assignRole(store, {
    assignmentId: "assign-1", roleId: "frontend-implementer", taskId: "task-1", actorId: "agent-1", assignedAt: AT,
  }), AgentWorkspaceConflictError);
  assert.throws(() => startRun(store, {
    runId: "run-1", taskId: "task-1", roleId: "frontend-implementer", actorId: "agent-1", intent: "x", startedAt: AT,
  }), AgentWorkspaceConflictError);
});

test("out-of-scope actions are rejected before records exist", () => {
  let critic = createWorkspaceStore();
  critic = assignRole(critic, {
    assignmentId: "assign-critic",
    roleId: "ux-critic",
    taskId: "task-9",
    actorId: "agent-9",
    assignedAt: AT,
  });
  critic = startRun(critic, {
    runId: "run-9",
    taskId: "task-9",
    roleId: "ux-critic",
    actorId: "agent-9",
    intent: "Review the flow",
    startedAt: AT,
  });
  assert.throws(() => recordAction(critic, action({
    runId: "run-9", actorId: "agent-9", roleId: "ux-critic", tool: "author-patch",
  })), /outside the role scope/u);
  const store = assignedStore();
  const scoped = recordAction(store, action());
  assert.equal(scoped.runs["run-1"].actions.length, 1);
  const entry = scoped.runs["run-1"].actions[0];
  assert.equal(entry.actorId, "agent-1");
  assert.equal(entry.tool, "author-patch");
  assert.equal(entry.transactionId, "tx-1");
  assert.throws(() => recordAction(scoped, action()), AgentWorkspaceConflictError);
});

test("cancellation blocks later actions and refuses completed runs", () => {
  const store = assignedStore();
  const cancelled = cancelRun(store, "run-1", "Superseded by a new plan", AT);
  assert.equal(cancelled.runs["run-1"].status, "cancelled");
  assert.throws(() => recordAction(cancelled, action()), /is cancelled/u);
  assert.throws(() => cancelRun(cancelled, "run-1", "again", AT), /already cancelled/u);
  const done = completeRun(store, "run-1", AT);
  assert.equal(done.runs["run-1"].status, "completed");
  assert.throws(() => recordAction(done, action()), /is completed/u);
  assert.throws(() => cancelRun(done, "run-1", "too late", AT), /already completed/u);
});

test("reversal requires transaction ids and refuses double reversal", () => {
  let store = assignedStore();
  store = recordAction(store, action());
  store = revertAction(store, "run-1", "action-1", "tx-2");
  assert.equal(store.runs["run-1"].actions[0].reverted, true);
  assert.equal(store.runs["run-1"].actions[0].revertedBy, "tx-2");
  assert.throws(() => revertAction(store, "run-1", "action-1", "tx-3"), /already reverted/u);
  assert.throws(() => revertAction(store, "run-1", "action-missing", "tx-3"), /unknown/u);
  let second = assignedStore();
  second = recordAction(second, action({ actionId: "action-9", reversible: false, transactionId: null }));
  assert.throws(() => revertAction(second, "run-1", "action-9", "tx-3"), /not reversible/u);
});

test("malformed entries fail closed", () => {
  const store = assignedStore();
  assert.throws(() => recordAction(store, action({ actorId: "agent-2" })), /must match the run/u);
  assert.throws(() => recordAction(store, action({ affectedNodes: ["x".repeat(300)] })), AgentWorkspaceValidationError);
  assert.throws(() => cancelRun(store, "run-missing", "x", AT), /unknown/u);
  assert.throws(() => startRun(store, { runId: "run-2", taskId: "task-1", roleId: "ux-critic", actorId: "agent-1", intent: "", startedAt: AT }), AgentWorkspaceValidationError);
});

test("deterministic serialization for identical inputs", () => {
  const first = assignedStore();
  const second = assignedStore();
  assert.equal(canonicalWorkspaceStringify(first), canonicalWorkspaceStringify(second));
  assert.equal(sha256Text("lilac").length, 64);
});

test("provenance marks the package as project-owned", () => {
  assert.equal(AGENT_WORKSPACE_PROVENANCE.package, "@ninerr/agent-workspace");
  assert.equal(AGENT_WORKSPACE_SCHEMA_VERSION, 1);
});
