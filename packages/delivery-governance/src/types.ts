export const DELIVERY_SCHEMA_VERSION = 1;

export const DELIVERY_HARD_LIMITS = {
  maxFindings: 256,
  maxGates: 32,
  maxCiChecks: 64,
  maxMessageLength: 2048,
  maxSurfaceLength: 128,
  maxToolLength: 128,
  maxBranchLength: 256,
  maxReasonLength: 2048,
} as const;

export const FINDING_SEVERITIES = ["info", "minor", "major", "blocking"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const GATE_VERDICTS = ["pass", "fail", "ask-user"] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

export const CI_CONCLUSIONS = ["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral"] as const;
export type CiConclusion = (typeof CI_CONCLUSIONS)[number];

export const ASK_USER_STATUSES = ["open", "resolved"] as const;
export type AskUserStatus = (typeof ASK_USER_STATUSES)[number];

export const ALLOWED_MERGE_STRATEGIES = ["merge"] as const;
export type MergeStrategy = (typeof ALLOWED_MERGE_STRATEGIES)[number];

export interface DeliveryFinding {
  severity: FindingSeverity;
  surface: string;
  message: string;
  tool: string;
  remediation?: string;
}

export interface DeliveryGate {
  name: string;
  verdict: GateVerdict;
  findings: DeliveryFinding[];
}

export interface CiCheckRecord {
  name: string;
  conclusion: CiConclusion;
  headSha: string;
  runId?: string;
}

export interface WorktreeIdentity {
  canonicalPath: string;
  branch: string;
  head: string;
  base: string;
}

export interface QualificationRecord {
  schemaVersion: number;
  qualificationId: string;
  candidateHead: string;
  base: string;
  parentQualificationId: string | null;
  actorId: string;
  intent: string;
  createdAt: string;
  gates: DeliveryGate[];
  ciChecks: CiCheckRecord[];
  worktrees: WorktreeIdentity[];
  mergeStrategy: string;
  mutatedAfterQualification: boolean;
}

export interface AskUserRequest {
  schemaVersion: number;
  requestId: string;
  reason: string;
  blockedGates: string[];
  candidateHead: string;
  createdAt: string;
  status: AskUserStatus;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface EvidenceBundle {
  schemaVersion: number;
  bundleId: string;
  qualificationId: string;
  candidateHead: string;
  createdAt: string;
  records: QualificationRecord[];
  askUserRequests: AskUserRequest[];
}

export interface GateEvaluation {
  verdict: "qualified" | "blocked" | "ask-user";
  reasons: string[];
}
