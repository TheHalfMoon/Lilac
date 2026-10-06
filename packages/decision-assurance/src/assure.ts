import { types } from "node:util";
import {
  DECISION_HARD_LIMITS,
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
import { canonicalAssuranceStringify, normalizeAssuranceInput, scrubText, sha256Text } from "./validation.ts";

export interface AssureOptions {
  adapter?: DecisionAdapter;
  ledger?: DecisionRequestLedger;
}

export const FIT_DIMENSION: Readonly<DecisionDimension> = Object.freeze({
  name: "fit",
  labels: Object.freeze([...FIT_LABELS]) as unknown as string[],
  instructions: "Judge how well this deterministically screened design candidate serves the stated intent. Its findings are already scored; judge fit, not rule compliance.",
});

const ADAPTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const MAX_ADAPTER_TEXT = 500;

// The router hands adapters its own cell objects and reads them back afterwards. The real
// adapter only ever sees structured clones, so it cannot alter router state; name and
// classifyCells are read exactly once.
function isolateAdapter(adapter: unknown): DecisionAdapter {
  if (adapter === null || typeof adapter !== "object" || types.isProxy(adapter)) {
    throw new DecisionAssuranceValidationError("options.adapter must be a plain decision-router adapter object");
  }
  const record = adapter as Record<string, unknown>;
  const name = record.name;
  const classify = record.classifyCells;
  if (typeof name !== "string" || !ADAPTER_NAME.test(name)) {
    throw new DecisionAssuranceValidationError("options.adapter.name must be a short stable identifier");
  }
  if (typeof classify !== "function") throw new DecisionAssuranceValidationError("options.adapter.classifyCells must be a function");
  return Object.freeze({
    name,
    classifyCells: (cells, policy) => classify.call(adapter, structuredClone(cells), structuredClone(policy)),
  } satisfies DecisionAdapter);
}

// Router inputs are bounded by the router's own policy; a valid assurance input must never
// produce a request the router rejects. Rule ids are dropped first, then rationale halves.
function routerInput(intent: string, assessment: CandidateAssessment, maxChars: number): string {
  const allRuleIds = [...new Set(assessment.findings.map((finding) => finding.ruleId))].sort();
  let ruleIds = allRuleIds.slice(0, ASSURANCE_HARD_LIMITS.maxFindingRuleIdsInRouterInput);
  let rationale = assessment.rationale;
  const build = (): string => canonicalAssuranceStringify({
    intent: intent.slice(0, 1000).toWellFormed(),
    candidateId: assessment.candidateId,
    rationale,
    rationaleTruncated: rationale.length < assessment.rationale.length,
    penalty: assessment.penalty,
    findingRuleIds: ruleIds,
    omittedRuleIds: allRuleIds.length - ruleIds.length,
    findingCount: assessment.findings.length + assessment.truncatedFindings,
  });
  let text = build();
  while (text.length > maxChars && ruleIds.length > 0) {
    ruleIds = ruleIds.slice(0, -1);
    text = build();
  }
  while (text.length > maxChars && rationale.length > 0) {
    rationale = rationale.slice(0, Math.floor(rationale.length / 2)).toWellFormed();
    text = build();
  }
  return text;
}

function labelRank(assessment: CandidateAssessment): number {
  const fit = assessment.fit;
  if (!fit || fit.abstained || fit.label === null) return FIT_LABELS.length;
  return FIT_LABELS.indexOf(fit.label);
}

// Deterministic penalty ranks before fit: the adapter orders candidates only within equal
// penalty, so model preference never outweighs a deterministic finding of any severity.
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
 * eligibility; an optional decision-router adapter only orders eligible candidates of equal
 * penalty and can cause abstention, never selection of an ineligible one. Returns a record;
 * never mutates.
 */
export async function assureCandidates(inputValue: unknown, options: AssureOptions = {}): Promise<AssuranceRecord> {
  const input = normalizeAssuranceInput(inputValue);
  const inputSha256 = sha256Text(canonicalAssuranceStringify(input));
  const assessments = input.candidates.map((candidate) => assessCandidate(candidate, input.rulePacks, input.policy));

  let adapterName: string | null = null;
  let routerRecordId: string | null = null;
  let adapterFailure: string | null = null;
  if (options.adapter !== undefined) {
    const adapter = isolateAdapter(options.adapter);
    adapterName = adapter.name;
    const policy = defaultDecisionPolicy({ unsureBelow: input.policy.unsureBelow });
    const request = {
      schemaVersion: DECISION_SCHEMA_VERSION,
      requestId: `assurance:${input.decisionId}:${inputSha256.slice(0, 16)}`,
      actorId: input.actorId,
      intent: input.intent,
      at: input.at,
      inputs: assessments.map((assessment) => routerInput(input.intent, assessment, Math.min(policy.maxInputChars, DECISION_HARD_LIMITS.maxInputChars))),
      dimensions: [FIT_DIMENSION],
      policy,
    };
    const prechecks = assessments.flatMap((assessment, itemIndex) => (assessment.eligible
      ? []
      : [{ itemIndex, verdict: { kind: "abstain", reason: "deterministically-ineligible" } }]));
    try {
      const result = await routeDecision(request, { adapter, prechecks, ledger: options.ledger });
      const seen = new Set<number>();
      for (const decision of result.record.decisions) {
        const index = decision.itemIndex;
        if (!Number.isSafeInteger(index) || index < 0 || index >= assessments.length || seen.has(index)) {
          throw new DecisionAdapterError("router returned an out-of-range or duplicate decision index");
        }
        seen.add(index);
      }
      for (const decision of result.record.decisions) {
        assessments[decision.itemIndex].fit = {
          label: decision.label as FitLabel | null,
          confidence: decision.confidence,
          abstained: decision.abstained,
          abstainReason: decision.abstainReason === null ? null : scrubText(decision.abstainReason, MAX_ADAPTER_TEXT),
        };
      }
      routerRecordId = result.record.recordId;
    } catch (error) {
      if (!(error instanceof DecisionAdapterError)) throw error;
      for (const assessment of assessments) assessment.fit = null;
      adapterFailure = scrubText(error.message, MAX_ADAPTER_TEXT);
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
