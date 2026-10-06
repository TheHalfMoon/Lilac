import {
  DECISION_SCHEMA_VERSION,
  DecisionAdapterError,
  defaultDecisionPolicy,
  routeDecision,
  type DecisionAdapter,
  type DecisionDimension,
  type DecisionRequestLedger,
} from "@lilac/decision-router";
import { assessCandidate } from "./checks.ts";
import { DecisionAssuranceValidationError } from "./errors.ts";
import {
  ASSURANCE_HARD_LIMITS,
  ASSURANCE_SCHEMA_VERSION,
  FIT_LABELS,
  type AssuranceOutcome,
  type AssuranceRecord,
  type CandidateAssessment,
  type FitLabel,
} from "./types.ts";
import { canonicalAssuranceStringify, normalizeAssuranceInput, sha256Text } from "./validation.ts";

export interface AssureOptions {
  adapter?: DecisionAdapter;
  ledger?: DecisionRequestLedger;
}

export const FIT_DIMENSION: DecisionDimension = {
  name: "fit",
  labels: [...FIT_LABELS],
  instructions: "Judge how well this deterministically screened design candidate serves the stated intent. Its findings are already scored; judge fit, not rule compliance.",
};

const MAX_RULE_IDS_IN_ROUTER_INPUT = 16;

function routerInput(intent: string, assessment: CandidateAssessment): string {
  const ruleIds = [...new Set(assessment.findings.map((finding) => finding.ruleId))].sort();
  return canonicalAssuranceStringify({
    intent: intent.slice(0, 1000),
    candidateId: assessment.candidateId,
    rationale: assessment.rationale,
    penalty: assessment.penalty,
    findingRuleIds: ruleIds.slice(0, MAX_RULE_IDS_IN_ROUTER_INPUT),
    findingCount: assessment.findings.length + assessment.truncatedFindings,
  });
}

function labelRank(assessment: CandidateAssessment): number {
  const fit = assessment.fit;
  if (!fit || fit.abstained || fit.label === null) return FIT_LABELS.length;
  return FIT_LABELS.indexOf(fit.label);
}

function compareCandidates(left: CandidateAssessment, right: CandidateAssessment): number {
  return Number(right.eligible) - Number(left.eligible)
    || left.penalty - right.penalty
    || labelRank(left) - labelRank(right)
    || (right.fit?.confidence ?? -1) - (left.fit?.confidence ?? -1)
    || Number(left.candidateId > right.candidateId) - Number(left.candidateId < right.candidateId);
}

function decideOutcome(
  ranked: CandidateAssessment[],
  adapterUsed: boolean,
  adapterFailure: string | null,
  tieMargin: number,
): AssuranceOutcome {
  if (ranked.length < ASSURANCE_HARD_LIMITS.minCandidatesToSelect) {
    return { kind: "abstained", reason: "insufficient-candidates", detail: `${ranked.length} candidate supplied; at least ${ASSURANCE_HARD_LIMITS.minCandidatesToSelect} are required to choose` };
  }
  const eligible = ranked.filter((assessment) => assessment.eligible);
  if (eligible.length === 0) {
    return { kind: "abstained", reason: "no-eligible-candidate", detail: "every candidate has a blocking deterministic finding" };
  }
  if (adapterFailure !== null) return { kind: "abstained", reason: "adapter-failed", detail: adapterFailure };
  const [leader, second] = eligible;
  if (adapterUsed) {
    if (!leader.fit || leader.fit.abstained) {
      return { kind: "abstained", reason: "leading-candidate-abstained", detail: leader.fit?.abstainReason ?? "no fit decision" };
    }
    if (leader.fit.label === "weak") {
      return { kind: "abstained", reason: "leading-candidate-weak", detail: `best eligible candidate ${leader.candidateId} was judged weak` };
    }
  }
  if (second && second.penalty === leader.penalty) {
    const sameFit = !adapterUsed || (
      labelRank(second) === labelRank(leader)
      && Math.abs((leader.fit?.confidence ?? 0) - (second.fit?.confidence ?? 0)) <= tieMargin
    );
    if (sameFit) {
      return { kind: "abstained", reason: "tie", detail: `${leader.candidateId} and ${second.candidateId} are indistinguishable at penalty ${leader.penalty}` };
    }
  }
  return { kind: "selected", candidateId: leader.candidateId };
}

/**
 * Assure a set of agent-generated alternatives. Deterministic checks run first and decide
 * eligibility; an optional decision-router adapter only orders eligible candidates and can
 * cause abstention, never selection of an ineligible one. Returns a record; never mutates.
 */
export async function assureCandidates(inputValue: unknown, options: AssureOptions = {}): Promise<AssuranceRecord> {
  const input = normalizeAssuranceInput(inputValue);
  const inputSha256 = sha256Text(canonicalAssuranceStringify(input));
  const assessments = input.candidates.map((candidate) => assessCandidate(candidate, input.rulePacks, input.policy));

  let adapterName: string | null = null;
  let routerRecordId: string | null = null;
  let adapterFailure: string | null = null;
  const adapter = options.adapter;
  if (adapter !== undefined) {
    if (adapter === null || typeof adapter !== "object" || typeof adapter.name !== "string" || typeof adapter.classifyCells !== "function") {
      throw new DecisionAssuranceValidationError("options.adapter must be a decision-router adapter");
    }
    adapterName = adapter.name;
    const request = {
      schemaVersion: DECISION_SCHEMA_VERSION,
      requestId: `assurance:${input.decisionId}:${inputSha256.slice(0, 16)}`,
      actorId: input.actorId,
      intent: input.intent,
      at: input.at,
      inputs: assessments.map((assessment) => routerInput(input.intent, assessment)),
      dimensions: [FIT_DIMENSION],
      policy: defaultDecisionPolicy({ unsureBelow: input.policy.unsureBelow }),
    };
    const prechecks = assessments.flatMap((assessment, itemIndex) => (assessment.eligible
      ? []
      : [{ itemIndex, verdict: { kind: "abstain", reason: "deterministically-ineligible" } }]));
    try {
      const result = await routeDecision(request, { adapter, prechecks, ledger: options.ledger });
      routerRecordId = result.record.recordId;
      for (const decision of result.record.decisions) {
        assessments[decision.itemIndex].fit = {
          label: decision.label as FitLabel | null,
          confidence: decision.confidence,
          abstained: decision.abstained,
          abstainReason: decision.abstainReason,
        };
      }
    } catch (error) {
      if (!(error instanceof DecisionAdapterError)) throw error;
      adapterFailure = error.message.slice(0, 1000);
    }
  }

  const ranked = [...assessments].sort(compareCandidates);
  const outcome = decideOutcome(ranked, adapterName !== null && adapterFailure === null, adapterFailure, input.policy.tieMargin);
  const body = {
    schemaVersion: ASSURANCE_SCHEMA_VERSION,
    decisionId: input.decisionId,
    actorId: input.actorId,
    intent: input.intent,
    at: input.at,
    inputSha256,
    policy: input.policy,
    candidates: assessments,
    ranking: ranked.map((assessment) => assessment.candidateId),
    outcome,
    adapter: adapterName,
    routerRecordId,
  };
  return { ...body, recordId: `assurance-record:${sha256Text(canonicalAssuranceStringify(body)).slice(0, 32)}` };
}

export function serializeAssuranceRecord(record: AssuranceRecord): string {
  return canonicalAssuranceStringify(record);
}
