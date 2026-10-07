import { createHash } from "node:crypto";

import { canonicalStringify } from "@lilac/agent-runtime";
import { evaluateAccess } from "@lilac/collaboration";

import { MCPContractError, classifyPaperTool } from "./paper-tools.mjs";

// Tool-call authorization for the MCP surface. Every call is classified first: unknown
// tools are denied without consulting any policy; known tools need a document capability
// from the collaboration access oracle (transport "mcp"); consequential tools also need a
// confirmation bound to this exact call.

export const MCP_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

const CAPABILITY_BY_CLASS = Object.freeze({ read: "read", write: "document-write", consequential: "document-write" });
// Tools whose capability differs from their class default.
const CAPABILITY_BY_TOOL = Object.freeze({ set_comment_thread_status: "comments" });

const CALL_KEYS = new Set(["actor", "toolName", "arguments", "at", "linkGrantId", "confirmation"]);
const CONFIRMATION_KEYS = new Set(["toolName", "argumentsSha256", "actorId", "confirmedAt"]);

function assertKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MCPContractError(`${label} must be a plain object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new MCPContractError(`${label} has unsupported key ${key}`);
}

const timestamp = (value, label) => {
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new MCPContractError(`${label} must be an ISO-8601 UTC timestamp`);
  return parsed;
};

/** The sha256 a confirmation must carry for these tool arguments. */
export function mcpArgumentsSha256(args) {
  return createHash("sha256").update(canonicalStringify(args ?? {}), "utf8").digest("hex");
}

function confirmationProblem(call, at) {
  const { confirmation } = call;
  if (confirmation === undefined) return "consequential tool requires explicit confirmation";
  assertKeys(confirmation, CONFIRMATION_KEYS, "confirmation");
  if (confirmation.toolName !== call.toolName) return "confirmation is for a different tool";
  // A person confirms: the calling user, or for an agent its owning user, never the agent.
  const confirmer = call.actor?.kind === "agent" ? call.actor.ownerActorId : call.actor?.actorId;
  if (typeof confirmer !== "string" || confirmation.actorId !== confirmer) return "confirmation is not from the responsible person";
  if (confirmation.argumentsSha256 !== mcpArgumentsSha256(call.arguments)) return "confirmation is for different arguments";
  const confirmedAt = timestamp(confirmation.confirmedAt, "confirmation.confirmedAt");
  if (confirmedAt > at) return "confirmation is dated after the call";
  if (at - confirmedAt > MCP_CONFIRMATION_WINDOW_MS) return "confirmation has expired";
  return null;
}

export function authorizeMCPToolCall(policy, call) {
  assertKeys(call, CALL_KEYS, "tool call");
  if (typeof call.toolName !== "string" || call.toolName === "") throw new MCPContractError("tool call toolName must be a non-empty string");
  const at = timestamp(call.at, "tool call at");
  const toolClass = classifyPaperTool(call.toolName);
  if (toolClass === "unknown") {
    return { outcome: "denied", toolClass, capability: null, reason: `unknown tool ${call.toolName}`, policyRevision: null };
  }
  const capability = CAPABILITY_BY_TOOL[call.toolName] ?? CAPABILITY_BY_CLASS[toolClass];
  const access = evaluateAccess(policy, {
    actor: call.actor,
    transport: "mcp",
    capability,
    at: call.at,
    ...(call.linkGrantId === undefined ? {} : { linkGrantId: call.linkGrantId }),
  });
  const base = { toolClass, capability, policyRevision: access.policyRevision };
  if (access.outcome !== "allowed") return { ...base, outcome: access.outcome, reason: access.reason };
  if (toolClass === "consequential") {
    const problem = confirmationProblem(call, at);
    if (problem !== null) return { ...base, outcome: "confirmation-required", reason: problem };
  }
  return { ...base, outcome: "allowed", reason: access.reason };
}

export class MCPAuthorizationError extends MCPContractError {
  constructor(decision) {
    super(`MCP tool call ${decision.outcome}: ${decision.reason}`);
    this.name = "MCPAuthorizationError";
    this.decision = decision;
  }
}

/** authorizeMCPToolCall, throwing unless the call is allowed. */
export function requireMCPToolCall(policy, call) {
  const decision = authorizeMCPToolCall(policy, call);
  if (decision.outcome !== "allowed") throw new MCPAuthorizationError(decision);
  return decision;
}
