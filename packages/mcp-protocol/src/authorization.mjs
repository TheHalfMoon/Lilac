import { createHash } from "node:crypto";

import { canonicalStringify } from "@ninerr/agent-runtime";
import { evaluateAccess } from "@ninerr/collaboration";

import { MCPContractError, classifyTool } from "./tools.mjs";

// Tool-call authorization for the MCP surface. Every call is classified first: unknown
// tools are denied without consulting any policy; known tools need a document capability
// from the collaboration access oracle (transport "mcp"); consequential tools also need a
// confirmation bound to this exact call on this document.
//
// Trust boundary (an obligation on the MCP server, #82): `actor` must be the identity the
// server authenticated for the session (for an agent, `ownerActorId` must be an
// authenticated user identity), and `confirmation` must come from the server's own
// confirmation flow with the responsible person. Neither may be taken from the MCP
// client's request payload; this function cannot tell who built them.

export const MCP_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

// Every tool acts on the open document, so its class alone decides the capability it needs.
const CAPABILITY_BY_CLASS = Object.freeze({ read: "read", write: "document-write", consequential: "document-write" });

const CALL_KEYS = new Set(["actor", "toolName", "arguments", "at", "linkGrantId", "confirmation"]);
const CONFIRMATION_KEYS = new Set(["documentId", "toolName", "argumentsSha256", "actorId", "confirmedAt"]);

function assertKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MCPContractError(`${label} must be a plain object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new MCPContractError(`${label} has unsupported key ${key}`);
}

// A real UTC instant: calendar-invalid forms such as 2026-02-30 or T24:00 are refused.
const timestamp = (value, label) => {
  const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z$/u.exec(value) : null;
  const parsed = match === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== match[1]) throw new MCPContractError(`${label} must be an ISO-8601 UTC timestamp`);
  return parsed;
};

// MCP tool arguments are an object (or absent).
function canonicalArguments(args) {
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    throw new MCPContractError("tool call arguments must be an object");
  }
  try {
    return canonicalStringify(args === undefined ? {} : args);
  } catch (error) {
    throw new MCPContractError(`tool call arguments must be JSON data: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The sha256 a confirmation must carry for these tool arguments. */
export function mcpArgumentsSha256(args) {
  return createHash("sha256").update(canonicalArguments(args), "utf8").digest("hex");
}

function confirmationProblem(policy, call, at, documentId) {
  const { confirmation } = call;
  if (confirmation === undefined) return "consequential tool requires explicit confirmation";
  assertKeys(confirmation, CONFIRMATION_KEYS, "confirmation");
  if (confirmation.documentId !== documentId) return "confirmation is for a different document";
  if (confirmation.toolName !== call.toolName) return "confirmation is for a different tool";
  // A person confirms: the calling user, or for an agent its owning user, never the agent.
  const confirmer = call.actor?.kind === "agent" ? call.actor.ownerActorId : call.actor?.actorId;
  if (typeof confirmer !== "string" || confirmer === (call.actor?.kind === "agent" ? call.actor.actorId : undefined) || confirmation.actorId !== confirmer) {
    return "confirmation is not from the responsible person";
  }
  // The person confirming must themselves be allowed to make this change on this document.
  const confirmerAccess = evaluateAccess(policy, {
    actor: { actorId: confirmer, kind: "user", accessClass: "member", displayName: confirmer },
    transport: "mcp",
    capability: "document-write",
    at: call.at,
  });
  if (confirmerAccess.outcome !== "allowed") return "the confirming person may not change this document";
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
  const toolClass = classifyTool(call.toolName);
  if (toolClass === "unknown") {
    return { outcome: "denied", toolClass, capability: null, documentId: null, reason: `unknown tool ${JSON.stringify(call.toolName).slice(0, 80)}`, policyRevision: null };
  }
  canonicalArguments(call.arguments);
  const capability = CAPABILITY_BY_CLASS[toolClass];
  const access = evaluateAccess(policy, {
    actor: call.actor,
    transport: "mcp",
    capability,
    at: call.at,
    ...(call.linkGrantId === undefined ? {} : { linkGrantId: call.linkGrantId }),
  });
  const base = { toolClass, capability, documentId: access.documentId, policyRevision: access.policyRevision };
  if (access.outcome !== "allowed") return { ...base, outcome: access.outcome, reason: access.reason };
  if (toolClass === "consequential") {
    const problem = confirmationProblem(policy, call, at, access.documentId);
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
