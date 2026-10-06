import { DeliveryGateError } from "./errors.ts";
import {
  type CiCheckRecord,
  type GateEvaluation,
  type QualificationRecord,
} from "./types.ts";
import { normalizeCiCheck, normalizeQualificationRecord } from "./validation.ts";

/**
 * Exact-head proof: evidence qualifies only the recorded candidate head.
 * Any other observed head invalidates the record for merge purposes.
 */
export function verifyExactHead(recordInput: QualificationRecord, observedHead: string): void {
  const record = normalizeQualificationRecord(recordInput);
  if (typeof observedHead !== "string" || observedHead !== record.candidateHead) {
    throw new DeliveryGateError(`exact-head proof failed: evidence covers ${record.candidateHead} but observed ${observedHead}`);
  }
  if (record.mutatedAfterQualification) {
    throw new DeliveryGateError("qualification was invalidated by a recorded mutation after qualification");
  }
}

/** Base movement protection: the recorded base must still match. */
export function verifyBaseUnmoved(recordInput: QualificationRecord, observedBase: string): void {
  const record = normalizeQualificationRecord(recordInput);
  if (typeof observedBase !== "string" || observedBase !== record.base) {
    throw new DeliveryGateError(`base movement detected: evidence base ${record.base} but observed ${observedBase}`);
  }
}

/** Worktree head movement protection for every registered validation worktree. */
export function verifyWorktreeHeads(recordInput: QualificationRecord, observed: Array<{ canonicalPath: string; head: string }>): void {
  const record = normalizeQualificationRecord(recordInput);
  for (const worktree of record.worktrees) {
    const match = observed.find((entry) => entry.canonicalPath === worktree.canonicalPath);
    if (!match) throw new DeliveryGateError(`validation worktree ${worktree.canonicalPath} is missing`);
    if (match.head !== worktree.head) {
      throw new DeliveryGateError(`validation worktree ${worktree.canonicalPath} moved from ${worktree.head} to ${match.head}`);
    }
  }
}

/** CI/PR qualification model: every recorded check must succeed on the candidate head. */
export function verifyCiChecks(recordInput: QualificationRecord, observedInput: CiCheckRecord[]): void {
  const record = normalizeQualificationRecord(recordInput);
  const observed = observedInput.map(normalizeCiCheck);
  for (const required of record.ciChecks) {
    const match = observed.find((entry) => entry.name === required.name);
    if (!match) throw new DeliveryGateError(`required CI check ${required.name} has no observation`);
    if (match.conclusion !== "success") {
      throw new DeliveryGateError(`required CI check ${required.name} concluded ${match.conclusion}`);
    }
    if (match.headSha !== record.candidateHead) {
      throw new DeliveryGateError(`CI check ${required.name} covers ${match.headSha}, not candidate ${record.candidateHead}`);
    }
  }
}

/**
 * Full gate evaluation: gates, CI, head, base, mutation state, and ask-user
 * routing. Blocking findings without an explicit human decision block;
 * ask-user verdicts route to the founder instead of passing silently.
 */
export function evaluateQualification(
  recordInput: QualificationRecord,
  observed: { head: string; base: string; ciChecks: CiCheckRecord[] },
): GateEvaluation {
  const record = normalizeQualificationRecord(recordInput);
  const reasons: string[] = [];
  if (record.mutatedAfterQualification) {
    return { verdict: "blocked", reasons: ["qualification invalidated by recorded mutation"] };
  }
  if (observed.head !== record.candidateHead) {
    return { verdict: "blocked", reasons: [`head moved: evidence covers ${record.candidateHead}`] };
  }
  if (observed.base !== record.base) {
    return { verdict: "blocked", reasons: [`base moved: evidence covers ${record.base}`] };
  }
  if (record.gates.length === 0) {
    return { verdict: "blocked", reasons: ["no qualification gates recorded"] };
  }
  if (record.ciChecks.length === 0) {
    return { verdict: "blocked", reasons: ["no CI checks recorded"] };
  }
  let askUser = false;
  for (const gate of record.gates) {
    if (gate.verdict === "fail") {
      reasons.push(`gate ${gate.name} failed`);
      continue;
    }
    if (gate.verdict === "ask-user") {
      askUser = true;
      reasons.push(`gate ${gate.name} parked for human decision`);
      continue;
    }
    const blocking = gate.findings.filter((finding) => finding.severity === "blocking");
    if (blocking.length > 0) {
      reasons.push(`gate ${gate.name} carries ${blocking.length} unresolved blocking findings`);
    }
  }
  for (const required of record.ciChecks) {
    const match = observed.ciChecks.find((entry) => entry.name === required.name);
    if (!match || match.conclusion !== "success" || match.headSha !== record.candidateHead) {
      reasons.push(`CI check ${required.name} is not green on the candidate head`);
    }
  }
  if (reasons.some((reason) => reason.includes("failed") || reason.includes("unresolved") || reason.includes("not green"))) {
    return { verdict: "blocked", reasons };
  }
  if (askUser) return { verdict: "ask-user", reasons };
  return { verdict: "qualified", reasons: [] };
}
