import { canonicalStringify } from "@ninerr/agent-runtime";
import { CollaborationAuthorizationError, CollaborationNotFoundError, CollaborationValidationError } from "./errors.ts";
import { assertAllowedKeys, assertBoundedString, assertPlainObject, assertTimestamp, normalizeActor } from "./validation.ts";
import {
  COLLABORATION_SCHEMA_VERSION,
  MAX_GRANTS,
  type AccessDecision,
  type AccessGrant,
  type AccessRequest,
  type CollaborationCapability,
  type DocumentAccessPolicy,
} from "./types.ts";

const CAPABILITIES = new Set<CollaborationCapability>(["read", "presence", "document-write", "comments", "admin", "durable-secret"]);
const TRANSPORTS = new Set(["http", "realtime", "mcp", "agent"]);

function normalizeGrant(grant: AccessGrant, index: number): AccessGrant {
  assertPlainObject(grant, `policy.grants[${index}]`);
  assertAllowedKeys(grant, `policy.grants[${index}]`, ["principalKind", "principalId", "capabilities", "expiresAt"]);
  if (grant.principalKind !== "actor" && grant.principalKind !== "link") throw new CollaborationValidationError(`policy.grants[${index}].principalKind is unsupported`);
  assertBoundedString(grant.principalId, `policy.grants[${index}].principalId`);
  if (!Array.isArray(grant.capabilities) || grant.capabilities.length === 0) throw new CollaborationValidationError(`policy.grants[${index}].capabilities must be non-empty`);
  const unique = [...new Set(grant.capabilities)];
  if (unique.some((capability) => !CAPABILITIES.has(capability))) throw new CollaborationValidationError(`policy.grants[${index}] contains unsupported capability`);
  if (grant.principalKind === "link" && (unique.includes("admin") || unique.includes("durable-secret"))) {
    throw new CollaborationValidationError("link grants cannot authorize administrative or durable-secret capability");
  }
  if (grant.expiresAt !== undefined) assertTimestamp(grant.expiresAt, `policy.grants[${index}].expiresAt`);
  return {
    principalKind: grant.principalKind,
    principalId: grant.principalId,
    capabilities: unique.sort(),
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
  };
}

export function normalizeAccessPolicy(policy: DocumentAccessPolicy): DocumentAccessPolicy {
  assertPlainObject(policy, "policy");
  assertAllowedKeys(policy, "policy", ["version", "documentId", "policyRevision", "deleted", "grants"]);
  if (policy.version !== COLLABORATION_SCHEMA_VERSION) throw new CollaborationValidationError("policy version is unsupported");
  assertBoundedString(policy.documentId, "policy.documentId");
  if (!Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 0) throw new CollaborationValidationError("policy.policyRevision must be a non-negative safe integer");
  if (typeof policy.deleted !== "boolean") throw new CollaborationValidationError("policy.deleted must be boolean");
  if (!Array.isArray(policy.grants) || policy.grants.length > MAX_GRANTS) throw new CollaborationValidationError(`policy.grants exceeds ${MAX_GRANTS} entries`);
  const grants = policy.grants.map(normalizeGrant);
  const identities = new Set<string>();
  for (const grant of grants) {
    const key = `${grant.principalKind}:${grant.principalId}`;
    if (identities.has(key)) throw new CollaborationValidationError(`duplicate access grant ${key}`);
    identities.add(key);
  }
  return { version: COLLABORATION_SCHEMA_VERSION, documentId: policy.documentId, policyRevision: policy.policyRevision, deleted: policy.deleted, grants };
}

export function createAccessPolicy(documentId: string, grants: AccessGrant[] = []): DocumentAccessPolicy {
  return normalizeAccessPolicy({ version: COLLABORATION_SCHEMA_VERSION, documentId, policyRevision: 0, deleted: false, grants });
}

function grantActive(grant: AccessGrant, at: string): boolean {
  return grant.expiresAt === undefined || Date.parse(grant.expiresAt) >= Date.parse(at);
}

export function evaluateAccess(policyInput: DocumentAccessPolicy, request: AccessRequest): AccessDecision {
  const policy = normalizeAccessPolicy(policyInput);
  assertPlainObject(request, "access");
  assertAllowedKeys(request, "access", ["actor", "transport", "capability", "at", "linkGrantId"]);
  const actor = normalizeActor(request.actor);
  if (!TRANSPORTS.has(request.transport)) throw new CollaborationValidationError("access transport is unsupported");
  if (!CAPABILITIES.has(request.capability)) throw new CollaborationValidationError("access capability is unsupported");
  assertTimestamp(request.at, "access.at");
  if (request.linkGrantId !== undefined) assertBoundedString(request.linkGrantId, "access.linkGrantId");
  if (policy.deleted) {
    return { outcome: "not-found", documentId: policy.documentId, actorId: actor.actorId, capability: request.capability, transport: request.transport, policyRevision: policy.policyRevision, reason: "document is deleted" };
  }
  const candidates = policy.grants.filter((grant) => {
    if (!grantActive(grant, request.at)) return false;
    if (grant.principalKind === "actor") return grant.principalId === actor.actorId;
    return request.linkGrantId !== undefined && grant.principalId === request.linkGrantId;
  });
  const allowed = candidates.some((grant) => grant.capabilities.includes(request.capability));
  return {
    outcome: allowed ? "allowed" : "denied",
    documentId: policy.documentId,
    actorId: actor.actorId,
    capability: request.capability,
    transport: request.transport,
    policyRevision: policy.policyRevision,
    reason: allowed ? "capability granted by document policy" : "document policy does not grant capability",
  };
}

export function requireAccess(policy: DocumentAccessPolicy, request: AccessRequest): AccessDecision {
  const decision = evaluateAccess(policy, request);
  if (decision.outcome === "not-found") throw new CollaborationNotFoundError(`document ${decision.documentId} is not found`);
  if (decision.outcome !== "allowed") throw new CollaborationAuthorizationError(`access denied for ${decision.capability} over ${decision.transport}`);
  return decision;
}

export function updateAccessPolicy(
  policyInput: DocumentAccessPolicy,
  input: { grants?: AccessGrant[]; deleted?: boolean; expectedRevision: number },
): DocumentAccessPolicy {
  const policy = normalizeAccessPolicy(policyInput);
  if (input.expectedRevision !== policy.policyRevision) throw new CollaborationValidationError("access policy revision conflict");
  return normalizeAccessPolicy({
    ...policy,
    policyRevision: policy.policyRevision + 1,
    grants: input.grants ?? policy.grants,
    deleted: input.deleted ?? policy.deleted,
  });
}

export function serializeAccessPolicy(policy: DocumentAccessPolicy): string {
  return canonicalStringify(normalizeAccessPolicy(policy));
}
