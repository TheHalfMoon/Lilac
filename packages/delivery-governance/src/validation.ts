import { createHash } from "node:crypto";
import { DeliveryValidationError } from "./errors.ts";
import {
  ALLOWED_MERGE_STRATEGIES,
  ASK_USER_STATUSES,
  CI_CONCLUSIONS,
  DELIVERY_HARD_LIMITS,
  DELIVERY_SCHEMA_VERSION,
  FINDING_SEVERITIES,
  GATE_VERDICTS,
  type AskUserRequest,
  type CiCheckRecord,
  type DeliveryFinding,
  type DeliveryGate,
  type QualificationRecord,
  type WorktreeIdentity,
} from "./types.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalDeliveryStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new DeliveryValidationError("delivery value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalDeliveryStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalDeliveryStringify(record[key])}`).join(",")}}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DeliveryValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new DeliveryValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DeliveryValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new DeliveryValidationError(`${label} exceeds ${max} characters`);
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 128);
  if (Number.isNaN(Date.parse(value))) throw new DeliveryValidationError(`${label} must be an ISO-compatible timestamp`);
}

export function assertCommitSha(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 64);
  if (!/^[0-9a-f]{40}$/u.test(value as string) && !/^[0-9a-f]{64}$/u.test(value as string)) {
    throw new DeliveryValidationError(`${label} must be a lowercase hex commit SHA`);
  }
}

export function normalizeFinding(value: unknown): DeliveryFinding {
  assertPlainObject(value, "delivery.finding");
  assertAllowedKeys(value, ["severity", "surface", "message", "tool", "remediation"], "delivery.finding");
  if (!FINDING_SEVERITIES.includes(value.severity as (typeof FINDING_SEVERITIES)[number])) {
    throw new DeliveryValidationError("delivery.finding.severity is unsupported");
  }
  assertBoundedString(value.surface, "delivery.finding.surface", DELIVERY_HARD_LIMITS.maxSurfaceLength);
  assertBoundedString(value.message, "delivery.finding.message", DELIVERY_HARD_LIMITS.maxMessageLength);
  assertBoundedString(value.tool, "delivery.finding.tool", DELIVERY_HARD_LIMITS.maxToolLength);
  const finding: DeliveryFinding = {
    severity: value.severity as DeliveryFinding["severity"],
    surface: value.surface as string,
    message: value.message as string,
    tool: value.tool as string,
  };
  if (value.remediation !== undefined) {
    assertBoundedString(value.remediation, "delivery.finding.remediation", DELIVERY_HARD_LIMITS.maxMessageLength);
    finding.remediation = value.remediation as string;
  }
  return finding;
}

export function normalizeGate(value: unknown): DeliveryGate {
  assertPlainObject(value, "delivery.gate");
  assertAllowedKeys(value, ["name", "verdict", "findings"], "delivery.gate");
  assertBoundedString(value.name, "delivery.gate.name", DELIVERY_HARD_LIMITS.maxSurfaceLength);
  if (!GATE_VERDICTS.includes(value.verdict as (typeof GATE_VERDICTS)[number])) {
    throw new DeliveryValidationError("delivery.gate.verdict is unsupported");
  }
  if (!Array.isArray(value.findings) || value.findings.length > DELIVERY_HARD_LIMITS.maxFindings) {
    throw new DeliveryValidationError("delivery.gate.findings exceeds its bounded budget");
  }
  return {
    name: value.name as string,
    verdict: value.verdict as DeliveryGate["verdict"],
    findings: (value.findings as unknown[]).map(normalizeFinding),
  };
}

export function normalizeCiCheck(value: unknown): CiCheckRecord {
  assertPlainObject(value, "delivery.ciCheck");
  assertAllowedKeys(value, ["name", "conclusion", "headSha", "runId"], "delivery.ciCheck");
  assertBoundedString(value.name, "delivery.ciCheck.name", DELIVERY_HARD_LIMITS.maxSurfaceLength);
  if (!CI_CONCLUSIONS.includes(value.conclusion as (typeof CI_CONCLUSIONS)[number])) {
    throw new DeliveryValidationError("delivery.ciCheck.conclusion is unsupported");
  }
  assertCommitSha(value.headSha, "delivery.ciCheck.headSha");
  const check: CiCheckRecord = {
    name: value.name as string,
    conclusion: value.conclusion as CiCheckRecord["conclusion"],
    headSha: value.headSha as string,
  };
  if (value.runId !== undefined) {
    assertBoundedString(value.runId, "delivery.ciCheck.runId", 128);
    check.runId = value.runId as string;
  }
  return check;
}

export function normalizeWorktreeIdentity(value: unknown): WorktreeIdentity {
  assertPlainObject(value, "delivery.worktree");
  assertAllowedKeys(value, ["canonicalPath", "branch", "head", "base"], "delivery.worktree");
  assertBoundedString(value.canonicalPath, "delivery.worktree.canonicalPath", 4096);
  assertBoundedString(value.branch, "delivery.worktree.branch", DELIVERY_HARD_LIMITS.maxBranchLength);
  assertCommitSha(value.head, "delivery.worktree.head");
  assertCommitSha(value.base, "delivery.worktree.base");
  return {
    canonicalPath: value.canonicalPath as string,
    branch: value.branch as string,
    head: value.head as string,
    base: value.base as string,
  };
}

export function normalizeQualificationRecord(value: unknown): QualificationRecord {
  assertPlainObject(value, "delivery.qualification");
  assertAllowedKeys(value, [
    "schemaVersion", "qualificationId", "candidateHead", "base", "parentQualificationId",
    "actorId", "intent", "createdAt", "gates", "ciChecks", "worktrees", "mergeStrategy", "mutatedAfterQualification",
  ], "delivery.qualification");
  if (value.schemaVersion !== DELIVERY_SCHEMA_VERSION) {
    throw new DeliveryValidationError("unsupported delivery qualification schema version");
  }
  assertBoundedString(value.qualificationId, "delivery.qualificationId", 256);
  assertCommitSha(value.candidateHead, "delivery.candidateHead");
  assertCommitSha(value.base, "delivery.base");
  if (value.parentQualificationId !== null) {
    assertBoundedString(value.parentQualificationId, "delivery.parentQualificationId", 256);
  }
  assertBoundedString(value.actorId, "delivery.actorId", 256);
  assertBoundedString(value.intent, "delivery.intent", 2048);
  assertTimestamp(value.createdAt, "delivery.createdAt");
  if (!Array.isArray(value.gates) || value.gates.length > DELIVERY_HARD_LIMITS.maxGates) {
    throw new DeliveryValidationError("delivery.qualification.gates exceeds its bounded budget");
  }
  if (!Array.isArray(value.ciChecks) || value.ciChecks.length > DELIVERY_HARD_LIMITS.maxCiChecks) {
    throw new DeliveryValidationError("delivery.qualification.ciChecks exceeds its bounded budget");
  }
  if (!Array.isArray(value.worktrees)) {
    throw new DeliveryValidationError("delivery.qualification.worktrees must be an array");
  }
  if (!ALLOWED_MERGE_STRATEGIES.includes(value.mergeStrategy as (typeof ALLOWED_MERGE_STRATEGIES)[number])) {
    throw new DeliveryValidationError("delivery.mergeStrategy must be a normal merge commit");
  }
  if (typeof value.mutatedAfterQualification !== "boolean") {
    throw new DeliveryValidationError("delivery.mutatedAfterQualification must be a boolean");
  }
  return {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    qualificationId: value.qualificationId as string,
    candidateHead: value.candidateHead as string,
    base: value.base as string,
    parentQualificationId: value.parentQualificationId as string | null,
    actorId: value.actorId as string,
    intent: value.intent as string,
    createdAt: value.createdAt as string,
    gates: (value.gates as unknown[]).map(normalizeGate),
    ciChecks: (value.ciChecks as unknown[]).map(normalizeCiCheck),
    worktrees: (value.worktrees as unknown[]).map(normalizeWorktreeIdentity),
    mergeStrategy: value.mergeStrategy as string,
    mutatedAfterQualification: value.mutatedAfterQualification as boolean,
  };
}

export function normalizeAskUserRequest(value: unknown): AskUserRequest {
  assertPlainObject(value, "delivery.askUser");
  assertAllowedKeys(value, ["schemaVersion", "requestId", "reason", "blockedGates", "candidateHead", "createdAt", "status", "resolvedBy", "resolutionNote"], "delivery.askUser");
  if (value.schemaVersion !== DELIVERY_SCHEMA_VERSION) {
    throw new DeliveryValidationError("unsupported ask-user schema version");
  }
  assertBoundedString(value.requestId, "delivery.askUser.requestId", 256);
  assertBoundedString(value.reason, "delivery.askUser.reason", DELIVERY_HARD_LIMITS.maxReasonLength);
  if (!Array.isArray(value.blockedGates) || value.blockedGates.length === 0) {
    throw new DeliveryValidationError("delivery.askUser.blockedGates must be a non-empty array");
  }
  for (const gate of value.blockedGates) assertBoundedString(gate, "delivery.askUser.blockedGate", DELIVERY_HARD_LIMITS.maxSurfaceLength);
  assertCommitSha(value.candidateHead, "delivery.askUser.candidateHead");
  assertTimestamp(value.createdAt, "delivery.askUser.createdAt");
  if (!ASK_USER_STATUSES.includes(value.status as (typeof ASK_USER_STATUSES)[number])) {
    throw new DeliveryValidationError("delivery.askUser.status is unsupported");
  }
  const request: AskUserRequest = {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    requestId: value.requestId as string,
    reason: value.reason as string,
    blockedGates: [...value.blockedGates as string[]],
    candidateHead: value.candidateHead as string,
    createdAt: value.createdAt as string,
    status: value.status as AskUserRequest["status"],
  };
  if (value.resolvedBy !== undefined) {
    assertBoundedString(value.resolvedBy, "delivery.askUser.resolvedBy", 256);
    request.resolvedBy = value.resolvedBy as string;
  }
  if (value.resolutionNote !== undefined) {
    assertBoundedString(value.resolutionNote, "delivery.askUser.resolutionNote", DELIVERY_HARD_LIMITS.maxReasonLength);
    request.resolutionNote = value.resolutionNote as string;
  }
  if (request.status === "open" && (request.resolvedBy !== undefined || request.resolutionNote !== undefined)) {
    throw new DeliveryValidationError("an open ask-user request must not carry resolution");
  }
  return request;
}
