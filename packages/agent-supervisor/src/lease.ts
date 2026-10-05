import { cloneJson } from "@lilac/agent-runtime";
import { SupervisorLeaseError, SupervisorOwnershipError } from "./errors.ts";
import type { LeaseLivenessEvidence, SupervisorLease } from "./types.ts";

export interface LeaseClaimRequest {
  ownerId: string;
  generationId: string;
  claimedAt: string;
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new SupervisorLeaseError(`${label} must be non-empty`);
}

function assertClaim(request: LeaseClaimRequest): void {
  assertIdentity(request.ownerId, "lease ownerId");
  assertIdentity(request.generationId, "lease generationId");
  if (Number.isNaN(Date.parse(request.claimedAt))) throw new SupervisorLeaseError("lease claimedAt must be a timestamp");
}

export function acquireLease(
  current: SupervisorLease | null,
  request: LeaseClaimRequest,
  evidence: LeaseLivenessEvidence | null,
): SupervisorLease {
  assertClaim(request);
  if (current === null) return cloneJson(request);

  if (current.ownerId === request.ownerId && current.generationId === request.generationId) {
    return cloneJson(request);
  }

  if (evidence === null) {
    throw new SupervisorLeaseError("foreign lease requires explicit liveness evidence");
  }
  if (evidence.ownerId !== current.ownerId || evidence.generationId !== current.generationId) {
    throw new SupervisorLeaseError("lease liveness evidence does not match the recorded lease");
  }
  if (evidence.status !== "stale") {
    throw new SupervisorLeaseError(`foreign lease is ${evidence.status}; ownership transfer refused`);
  }
  return cloneJson(request);
}

export function assertLeaseOwner(
  lease: SupervisorLease | null,
  ownerId: string,
  generationId: string,
): void {
  if (lease === null) throw new SupervisorOwnershipError("task has no mutation lease");
  if (lease.ownerId !== ownerId || lease.generationId !== generationId) {
    throw new SupervisorOwnershipError("task mutation lease belongs to another supervisor generation");
  }
}

export function releaseLease(
  current: SupervisorLease | null,
  ownerId: string,
  generationId: string,
): null {
  assertIdentity(ownerId, "lease ownerId");
  assertIdentity(generationId, "lease generationId");
  if (current === null) return null;
  assertLeaseOwner(current, ownerId, generationId);
  return null;
}
