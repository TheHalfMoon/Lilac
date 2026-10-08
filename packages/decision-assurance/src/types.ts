import type { DesignSnapshot, RulePack, RuleSeverity } from "@ninerr/design-method";

export const ASSURANCE_SCHEMA_VERSION = 1;

export const ASSURANCE_HARD_LIMITS = {
  minCandidatesToSelect: 2,
  maxCandidates: 16,
  maxRulePacks: 8,
  maxRationaleLength: 2000,
  maxIntentLength: 2048,
  maxFindingsPerCandidate: 512,
  maxAllowedTextSizes: 64,
  maxInputDepth: 32,
  // 16 candidates x 2048 snapshot nodes x (node + 12 fields), plus packs and policy headroom.
  maxInputValues: 600000,
  maxFindingRuleIdsInRouterInput: 16,
} as const;

export const SEVERITY_PENALTY: Readonly<Record<RuleSeverity, number>> = { info: 1, minor: 10, major: 100 };

export const FIT_LABELS = ["strong", "acceptable", "weak"] as const;
export type FitLabel = (typeof FIT_LABELS)[number];

export interface AssurancePolicy {
  blockingSeverities: RuleSeverity[];
  minTouchTarget: number;
  minTextSize: number;
  allowedTextSizes: number[] | null;
  spacingGrid: number | null;
  unsureBelow: number;
  tieMargin: number;
}

export interface CandidateInput {
  candidateId: string;
  rationale: string;
  snapshot: DesignSnapshot;
}

export interface AssuranceInput {
  schemaVersion: typeof ASSURANCE_SCHEMA_VERSION;
  decisionId: string;
  actorId: string;
  intent: string;
  at: string;
  candidates: CandidateInput[];
  rulePacks: RulePack[];
  policy: AssurancePolicy;
}

export type FindingSource = "builtin" | "rule-pack";

export interface AssuranceFinding {
  ruleId: string;
  source: FindingSource;
  severity: RuleSeverity;
  nodeId: string | null;
  measured: number | string | null;
  expected: string | null;
  message: string;
}

export interface CandidateFit {
  label: FitLabel | null;
  confidence: number | null;
  abstained: boolean;
  abstainReason: string | null;
}

export interface CandidateAssessment {
  candidateId: string;
  rationale: string;
  snapshotId: string;
  eligible: boolean;
  penalty: number;
  findings: AssuranceFinding[];
  truncatedFindings: number;
  fit: CandidateFit | null;
}

export const ABSTAIN_REASONS = [
  "insufficient-candidates",
  "no-eligible-candidate",
  "leading-candidate-abstained",
  "leading-candidate-weak",
  "adapter-failed",
  "tie",
] as const;
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

export type AssuranceOutcome =
  | { kind: "selected"; candidateId: string }
  | { kind: "abstained"; reason: AbstainReason; detail: string };

export interface AssuranceRecord {
  schemaVersion: typeof ASSURANCE_SCHEMA_VERSION;
  recordId: string;
  decisionId: string;
  actorId: string;
  intent: string;
  at: string;
  inputSha256: string;
  policy: AssurancePolicy;
  candidates: CandidateAssessment[];
  ranking: string[];
  outcome: AssuranceOutcome;
  adapter: string | null;
  routerRecordId: string | null;
}
