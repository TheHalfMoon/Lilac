import test from "node:test";
import assert from "node:assert/strict";

import {
  MCPAuthorizationError,
  MCPContractError,
  MCP_CONFIRMATION_WINDOW_MS,
  PAPER_MCP_TOOL_NAMES,
  authorizeMCPToolCall,
  classifyPaperTool,
  mcpArgumentsSha256,
  requireMCPToolCall,
} from "../packages/mcp-protocol/src/index.mjs";
import { createAccessPolicy, updateAccessPolicy } from "../packages/collaboration/src/index.ts";

// P06 gate 8 (#128): MCP tool calls are authorized by tool class through the
// collaboration access oracle.

const AT = "2026-10-07T12:00:00.000Z";
const user = { actorId: "user-1", kind: "user", accessClass: "member", displayName: "User" };
const agent = { actorId: "agent-1", kind: "agent", accessClass: "service", displayName: "Agent", ownerActorId: "user-1", operationId: "op-1", workerTaskId: "task-1" };
const CAPABILITIES = ["read", "presence", "document-write", "comments", "admin", "durable-secret"];

const policyFor = (capabilities, actor = user) => createAccessPolicy("doc-1", capabilities.length === 0 ? [] : [{ principalKind: "actor", principalId: actor.actorId, capabilities }]);
const call = (toolName, extra = {}) => ({ actor: user, toolName, arguments: { nodeIds: ["n1"] }, at: AT, ...extra });
const confirmation = (toolName, args = { nodeIds: ["n1"] }, overrides = {}) => ({ toolName, argumentsSha256: mcpArgumentsSha256(args), actorId: user.actorId, confirmedAt: "2026-10-07T11:59:00.000Z", ...overrides });

const subsets = (items) => items.reduce((all, item) => all.concat(all.map((set) => [...set, item])), [[]]);
const required = (tool) => (classifyPaperTool(tool) === "read" ? "read" : tool === "set_comment_thread_status" ? "comments" : "document-write");

test("every Paper tool over every capability set: allowed exactly when its capability is granted", () => {
  for (const capabilities of subsets(CAPABILITIES)) {
    const policy = policyFor(capabilities);
    for (const tool of PAPER_MCP_TOOL_NAMES) {
      const toolClass = classifyPaperTool(tool);
      const withConfirmation = toolClass === "consequential" ? { confirmation: confirmation(tool) } : {};
      const decision = authorizeMCPToolCall(policy, call(tool, withConfirmation));
      assert.equal(decision.toolClass, toolClass);
      assert.equal(decision.capability, required(tool));
      assert.equal(decision.outcome, capabilities.includes(required(tool)) ? "allowed" : "denied", `${tool} with [${capabilities}]`);
    }
  }
});

test("read grants cannot write", () => {
  for (const capabilities of [["read"], ["read", "presence"], ["read", "presence", "comments"]]) {
    const policy = policyFor(capabilities);
    for (const tool of PAPER_MCP_TOOL_NAMES.filter((name) => classifyPaperTool(name) !== "read" && name !== "set_comment_thread_status")) {
      const decision = authorizeMCPToolCall(policy, call(tool, { confirmation: confirmation(tool) }));
      assert.equal(decision.outcome, "denied", tool);
      assert.throws(() => requireMCPToolCall(policy, call(tool, { confirmation: confirmation(tool) })), MCPAuthorizationError);
    }
  }
});

test("consequential tools require a confirmation bound to this exact call", () => {
  const policy = policyFor(["read", "document-write"]);
  const tool = "delete_nodes";
  assert.equal(classifyPaperTool(tool), "consequential");
  const refused = (extra, reason) => {
    const decision = authorizeMCPToolCall(policy, call(tool, extra));
    assert.equal(decision.outcome, "confirmation-required", reason);
    assert.throws(() => requireMCPToolCall(policy, call(tool, extra)), (error) => error instanceof MCPAuthorizationError && error.decision.outcome === "confirmation-required");
    return decision.reason;
  };
  assert.match(refused({}, "none"), /requires explicit confirmation/u);
  assert.match(refused({ confirmation: confirmation("rename_nodes") }, "other tool"), /different tool/u);
  assert.match(refused({ confirmation: confirmation(tool, { nodeIds: ["n2"] }) }, "other arguments"), /different arguments/u);
  assert.match(refused({ confirmation: confirmation(tool, undefined, { actorId: "user-2" }) }, "other actor"), /not from the responsible person/u);
  assert.match(refused({ confirmation: confirmation(tool, undefined, { confirmedAt: "2026-10-07T11:54:59.999Z" }) }, "expired"), /expired/u);
  assert.match(refused({ confirmation: confirmation(tool, undefined, { confirmedAt: "2026-10-07T12:00:00.001Z" }) }, "future"), /after the call/u);
  assert.equal(authorizeMCPToolCall(policy, call(tool, { confirmation: confirmation(tool) })).outcome, "allowed");
  const edge = new Date(Date.parse(AT) - MCP_CONFIRMATION_WINDOW_MS).toISOString();
  assert.equal(authorizeMCPToolCall(policy, call(tool, { confirmation: confirmation(tool, undefined, { confirmedAt: edge }) })).outcome, "allowed", "the window's edge is inside");
  // Argument key order does not matter; content does.
  const args = { nodeIds: ["a", "b"], cascade: true };
  assert.equal(authorizeMCPToolCall(policy, call(tool, { arguments: { cascade: true, nodeIds: ["a", "b"] }, confirmation: confirmation(tool, args) })).outcome, "allowed");
  assert.equal(authorizeMCPToolCall(policy, call(tool, { arguments: { cascade: true, nodeIds: ["b", "a"] }, confirmation: confirmation(tool, args) })).outcome, "confirmation-required");
  // Without the capability, a confirmation does not help: denied, not confirmation-required.
  assert.equal(authorizeMCPToolCall(policyFor(["read"]), call(tool, { confirmation: confirmation(tool) })).outcome, "denied");
  assert.throws(() => authorizeMCPToolCall(policy, call(tool, { confirmation: { ...confirmation(tool), extra: 1 } })), MCPContractError);
});

test("unknown tools are denied without consulting the policy", () => {
  const policy = policyFor(CAPABILITIES);
  for (const name of ["shell", "delete_all", "DELETE_NODES", "delete_nodes ", "get_jsx\u0000", "__proto__", "constructor", "toString", "get_nodes_info"]) {
    const decision = authorizeMCPToolCall(policy, call(name));
    assert.equal(decision.outcome, "denied", name);
    assert.equal(decision.toolClass, "unknown");
    assert.equal(decision.policyRevision, null, "the policy was not consulted");
  }
  // Even a malformed policy is never consulted for an unknown tool.
  assert.equal(authorizeMCPToolCall({ not: "a policy" }, call("shell")).outcome, "denied");
  assert.throws(() => authorizeMCPToolCall(policy, call("")), MCPContractError);
  assert.throws(() => authorizeMCPToolCall(policy, { ...call("get_jsx"), extra: true }), MCPContractError);
  assert.throws(() => authorizeMCPToolCall(policy, call("get_jsx", { at: "yesterday" })), MCPContractError);
});

test("revoked grants fail closed", () => {
  const granted = policyFor(["read", "document-write"]);
  assert.equal(authorizeMCPToolCall(granted, call("update_styles")).outcome, "allowed");
  const removed = updateAccessPolicy(granted, { grants: [], expectedRevision: granted.policyRevision });
  assert.equal(authorizeMCPToolCall(removed, call("update_styles")).outcome, "denied");
  assert.equal(authorizeMCPToolCall(removed, call("get_jsx")).outcome, "denied");
  assert.equal(authorizeMCPToolCall(removed, call("update_styles")).policyRevision, 1);
  const narrowed = updateAccessPolicy(granted, { grants: [{ principalKind: "actor", principalId: user.actorId, capabilities: ["read"] }], expectedRevision: 0 });
  assert.equal(authorizeMCPToolCall(narrowed, call("update_styles")).outcome, "denied");
  assert.equal(authorizeMCPToolCall(narrowed, call("get_jsx")).outcome, "allowed");
  const expiring = createAccessPolicy("doc-1", [{ principalKind: "actor", principalId: user.actorId, capabilities: ["read"], expiresAt: "2026-10-07T11:00:00.000Z" }]);
  assert.equal(authorizeMCPToolCall(expiring, call("get_jsx")).outcome, "denied", "expired grant");
  const deleted = updateAccessPolicy(granted, { deleted: true, expectedRevision: 0 });
  assert.equal(authorizeMCPToolCall(deleted, call("get_jsx")).outcome, "not-found");
  assert.throws(() => requireMCPToolCall(deleted, call("get_jsx")), (error) => error.decision.outcome === "not-found");
  const link = createAccessPolicy("doc-1", [{ principalKind: "link", principalId: "link-1", capabilities: ["read"] }]);
  assert.equal(authorizeMCPToolCall(link, call("get_jsx", { linkGrantId: "link-1" })).outcome, "allowed");
  const linkRevoked = updateAccessPolicy(link, { grants: [], expectedRevision: 0 });
  assert.equal(authorizeMCPToolCall(linkRevoked, call("get_jsx", { linkGrantId: "link-1" })).outcome, "denied");
  assert.equal(authorizeMCPToolCall(link, call("get_jsx", { linkGrantId: "link-2" })).outcome, "denied", "another link id");
});

test("agents are judged by their own grant, not their owner's", () => {
  const ownerOnly = policyFor(["read", "document-write"], user);
  assert.equal(authorizeMCPToolCall(ownerOnly, call("update_styles", { actor: agent })).outcome, "denied");
  const agentRead = createAccessPolicy("doc-1", [
    { principalKind: "actor", principalId: user.actorId, capabilities: ["read", "document-write"] },
    { principalKind: "actor", principalId: agent.actorId, capabilities: ["read"] },
  ]);
  assert.equal(authorizeMCPToolCall(agentRead, call("get_jsx", { actor: agent })).outcome, "allowed");
  assert.equal(authorizeMCPToolCall(agentRead, call("update_styles", { actor: agent })).outcome, "denied");
  // An agent's consequential call is confirmed by its owning person, never by the agent
  // itself or by another person.
  const agentWrite = createAccessPolicy("doc-1", [{ principalKind: "actor", principalId: agent.actorId, capabilities: ["read", "document-write"] }]);
  const agentCall = (actorId) => call("delete_nodes", { actor: agent, confirmation: confirmation("delete_nodes", undefined, { actorId }) });
  assert.equal(authorizeMCPToolCall(agentWrite, agentCall(agent.actorId)).outcome, "confirmation-required", "self-confirmation");
  assert.equal(authorizeMCPToolCall(agentWrite, agentCall("user-2")).outcome, "confirmation-required", "another person");
  assert.equal(authorizeMCPToolCall(agentWrite, agentCall(user.actorId)).outcome, "allowed", "the owner confirms");
});
