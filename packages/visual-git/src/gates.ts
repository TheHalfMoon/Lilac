import { VisualGitConflictError, VisualGitValidationError } from "./errors.ts";
import {
  CHECK_VERDICTS,
  VISUAL_GIT_HARD_LIMITS,
  type AcceptanceCheck,
  type AcceptanceResult,
  type CheckVerdict,
  type GateBlock,
} from "./types.ts";
import {
  assertAllowedKeys,
  assertBoundedArray,
  assertBoundedString,
  assertCommit,
  assertPlainObject,
  assertStableId,
  normalizeSnapshot,
} from "./validation.ts";

export function normalizeCheck(value: unknown): AcceptanceCheck {
  assertPlainObject(value, "gate.check");
  assertAllowedKeys(value, ["name", "verdict", "detail"], "gate.check");
  assertStableId(value.name, "gate.check.name");
  if (!CHECK_VERDICTS.includes(value.verdict as CheckVerdict)) {
    throw new VisualGitValidationError(`gate.check ${value.name} verdict is unsupported`);
  }
  assertBoundedString(value.detail, "gate.check.detail", VISUAL_GIT_HARD_LIMITS.maxCheckDetailLength);
  return { name: value.name, verdict: value.verdict as CheckVerdict, detail: value.detail };
}

export function evaluateAcceptance(input: unknown): AcceptanceResult {
  assertPlainObject(input, "gate");
  assertAllowedKeys(input, ["snapshot", "baseCommit", "headCommit", "checks", "requiredChecks"], "gate");
  const snapshot = normalizeSnapshot(input.snapshot);
  assertCommit(input.baseCommit, "gate.baseCommit");
  assertCommit(input.headCommit, "gate.headCommit");
  assertBoundedArray(input.checks, "gate.checks", VISUAL_GIT_HARD_LIMITS.maxChecks);
  assertBoundedArray(input.requiredChecks, "gate.requiredChecks", VISUAL_GIT_HARD_LIMITS.maxChecks);
  const checks = new Map<string, AcceptanceCheck>();
  for (const entry of input.checks) {
    const check = normalizeCheck(entry);
    if (checks.has(check.name)) throw new VisualGitConflictError(`gate check ${check.name} is reported twice`);
    checks.set(check.name, check);
  }
  const required = new Set<string>();
  for (const name of input.requiredChecks) {
    assertStableId(name, "gate.requiredChecks.name");
    if (required.has(name)) throw new VisualGitConflictError(`required check ${name} is listed twice`);
    required.add(name);
  }
  const blocks: GateBlock[] = [];
  if (snapshot.sourceCommit !== input.headCommit) blocks.push({ reason: "stale-snapshot", check: null });
  if (checks.size === 0) blocks.push({ reason: "no-checks", check: null });
  for (const name of [...required].sort()) {
    const check = checks.get(name);
    if (!check) blocks.push({ reason: "missing-required-check", check: name });
    else if (check.verdict === "skipped") blocks.push({ reason: "skipped-required-check", check: name });
  }
  for (const name of [...checks.keys()].sort()) {
    const verdict = (checks.get(name) as AcceptanceCheck).verdict;
    if (verdict === "fail") blocks.push({ reason: "failing-check", check: name });
    if (verdict === "pending") blocks.push({ reason: "pending-check", check: name });
  }
  return {
    snapshotId: snapshot.snapshotId,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    verdict: blocks.length === 0 ? "accepted" : "blocked",
    blocks,
  };
}
