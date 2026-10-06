import { DeliveryGateError, DeliveryValidationError } from "./errors.ts";
import {
  DELIVERY_SCHEMA_VERSION,
  type AskUserRequest,
  type QualificationRecord,
} from "./types.ts";
import {
  canonicalDeliveryStringify,
  normalizeAskUserRequest,
  normalizeQualificationRecord,
  sha256Text,
} from "./validation.ts";

export function createQualificationId(record: Omit<QualificationRecord, "schemaVersion" | "qualificationId">): string {
  return `delivery-qualification:${sha256Text(canonicalDeliveryStringify(record)).slice(0, 32)}`;
}

/**
 * Repair ancestry: a repair starts a new qualification that references its
 * parent. The child carries no evidence until fresh runs complete, so prior
 * evidence can never silently qualify the repaired head.
 */
export function recordRepair(
  parentInput: QualificationRecord,
  repair: { candidateHead: string; actorId: string; intent: string; createdAt: string },
): QualificationRecord {
  const parent = normalizeQualificationRecord(parentInput);
  if (typeof repair.candidateHead !== "string" || repair.candidateHead === parent.candidateHead) {
    throw new DeliveryValidationError("a repair must advance to a new candidate head");
  }
  const child = normalizeQualificationRecord({
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    qualificationId: "pending",
    candidateHead: repair.candidateHead,
    base: parent.base,
    parentQualificationId: parent.qualificationId,
    actorId: repair.actorId,
    intent: repair.intent,
    createdAt: repair.createdAt,
    gates: [],
    ciChecks: [],
    worktrees: parent.worktrees,
    mergeStrategy: "merge",
    mutatedAfterQualification: false,
  });
  return child;
}

/**
 * Explicit ask-user state for genuine governance gates. Creation requires at
 * least one blocked gate; resolution requires an explicit resolver identity
 * and note. Nothing resolves implicitly.
 */
export function createAskUserRequest(input: {
  requestId: string;
  reason: string;
  blockedGates: string[];
  candidateHead: string;
  createdAt: string;
}): AskUserRequest {
  return normalizeAskUserRequest({
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    requestId: input.requestId,
    reason: input.reason,
    blockedGates: input.blockedGates,
    candidateHead: input.candidateHead,
    createdAt: input.createdAt,
    status: "open",
  });
}

export function resolveAskUserRequest(
  requestInput: AskUserRequest,
  resolution: { resolvedBy: string; resolutionNote: string },
): AskUserRequest {
  const request = normalizeAskUserRequest(requestInput);
  if (request.status !== "open") {
    throw new DeliveryGateError(`ask-user request ${request.requestId} is not open`);
  }
  return normalizeAskUserRequest({ ...request, status: "resolved", ...resolution });
}
