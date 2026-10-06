import { createHash } from "node:crypto";
import { types } from "node:util";
import { RULE_SEVERITIES, normalizeRulePack, normalizeSnapshot, type RuleSeverity } from "@lilac/design-method";
import { DecisionAssuranceValidationError } from "./errors.ts";
import {
  ASSURANCE_HARD_LIMITS,
  ASSURANCE_SCHEMA_VERSION,
  type AssuranceInput,
  type AssurancePolicy,
  type CandidateInput,
} from "./types.ts";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// Text is shown to people and read by agents: controls, format characters (bidi,
// zero-width, tag "smuggling" characters), separators, and blank-looking fillers could
// hide or reorder content. Tab/newline/CR and ZWNJ/ZWJ (emoji, complex scripts) stay legal.
const HIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{34f}\u{115f}\u{1160}\u{3164}\u{ffa0}]/u;
const VISIBLE_FORMAT = /[\t\n\r\u{200c}\u{200d}]/gu;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalAssuranceStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new DecisionAssuranceValidationError("assurance value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalAssuranceStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalAssuranceStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
}

export function assertVisibleText(value: string, label: string): void {
  if (!value.isWellFormed() || HIDDEN_TEXT.test(value.replace(VISIBLE_FORMAT, ""))) {
    throw new DecisionAssuranceValidationError(`${label} must not contain control or hidden characters`);
  }
}

// One read of the untrusted input. Proxies, accessors, foreign prototypes, symbol keys,
// sparse or decorated arrays, non-finite numbers, and hidden text are rejected; the copy
// is inert, so every later validator (including design-method's) reads stable data.
export function inertCopy(value: unknown, label = "input"): unknown {
  let budget: number = ASSURANCE_HARD_LIMITS.maxInputValues;
  const walk = (entry: unknown, path: string, depth: number): unknown => {
    budget -= 1;
    if (budget < 0) throw new DecisionAssuranceValidationError(`${label} exceeds ${ASSURANCE_HARD_LIMITS.maxInputValues} values`);
    if (depth > ASSURANCE_HARD_LIMITS.maxInputDepth) throw new DecisionAssuranceValidationError(`${path} is nested too deeply`);
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "string") {
      assertVisibleText(entry, path);
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new DecisionAssuranceValidationError(`${path} must be a finite number`);
      return Object.is(entry, -0) ? 0 : entry;
    }
    if (typeof entry !== "object") throw new DecisionAssuranceValidationError(`${path} has an unsupported value type`);
    if (types.isProxy(entry)) throw new DecisionAssuranceValidationError(`${path} must not be a proxy`);
    if (Object.getOwnPropertySymbols(entry).length > 0) throw new DecisionAssuranceValidationError(`${path} must not have symbol keys`);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) throw new DecisionAssuranceValidationError(`${path}.${key} must not be an accessor`);
    }
    if (Array.isArray(entry)) {
      if (Object.getPrototypeOf(entry) !== Array.prototype) throw new DecisionAssuranceValidationError(`${path} must be a plain array`);
      const length = descriptors.length.value as number;
      if (Object.keys(descriptors).length !== length + 1) throw new DecisionAssuranceValidationError(`${path} must be a dense array without extra properties`);
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = descriptors[String(index)];
        if (!item) throw new DecisionAssuranceValidationError(`${path} must be a dense array`);
        copy.push(walk(item.value, `${path}[${index}]`, depth + 1));
      }
      return copy;
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) throw new DecisionAssuranceValidationError(`${path} must be a plain object`);
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "__proto__") throw new DecisionAssuranceValidationError(`${path} must not define __proto__`);
      assertVisibleText(key, `${path} key`);
      copy[key] = walk(descriptor.value, `${path}.${key}`, depth + 1);
    }
    return copy;
  };
  return walk(value, label, 0);
}

function assertRecord(value: unknown, label: string, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DecisionAssuranceValidationError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new DecisionAssuranceValidationError(`${label} contains unsupported field ${key}`);
  }
}

function assertStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new DecisionAssuranceValidationError(`${label} must be a stable identifier`);
  }
}

function assertText(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new DecisionAssuranceValidationError(`${label} must be a non-empty string`);
  if (value.length > max) throw new DecisionAssuranceValidationError(`${label} exceeds ${max} characters`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertText(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DecisionAssuranceValidationError(`${label} must be an ISO-8601 timestamp`);
  }
}

function positiveNumber(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new DecisionAssuranceValidationError(`${label} must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

export function defaultAssurancePolicy(): AssurancePolicy {
  return {
    blockingSeverities: ["major"],
    minTouchTarget: 44,
    minTextSize: 12,
    allowedTextSizes: null,
    spacingGrid: null,
    unsureBelow: 0.7,
    tieMargin: 0.05,
  };
}

export function normalizeAssurancePolicy(value: unknown): AssurancePolicy {
  const defaults = defaultAssurancePolicy();
  if (value === undefined) return defaults;
  assertRecord(value, "policy", ["blockingSeverities", "minTouchTarget", "minTextSize", "allowedTextSizes", "spacingGrid", "unsureBelow", "tieMargin"]);
  const policy = { ...defaults };
  if (value.blockingSeverities !== undefined) {
    if (!Array.isArray(value.blockingSeverities) || value.blockingSeverities.length === 0) {
      throw new DecisionAssuranceValidationError("policy.blockingSeverities must be a non-empty array");
    }
    const severities = new Set<RuleSeverity>();
    for (const entry of value.blockingSeverities) {
      if (!RULE_SEVERITIES.includes(entry as RuleSeverity)) throw new DecisionAssuranceValidationError("policy.blockingSeverities contains an unknown severity");
      severities.add(entry as RuleSeverity);
    }
    policy.blockingSeverities = RULE_SEVERITIES.filter((severity) => severities.has(severity));
  }
  if (value.minTouchTarget !== undefined) policy.minTouchTarget = positiveNumber(value.minTouchTarget, "policy.minTouchTarget");
  if (value.minTextSize !== undefined) policy.minTextSize = positiveNumber(value.minTextSize, "policy.minTextSize");
  if (value.allowedTextSizes !== undefined && value.allowedTextSizes !== null) {
    if (!Array.isArray(value.allowedTextSizes) || value.allowedTextSizes.length === 0 || value.allowedTextSizes.length > ASSURANCE_HARD_LIMITS.maxAllowedTextSizes) {
      throw new DecisionAssuranceValidationError(`policy.allowedTextSizes must hold 1..${ASSURANCE_HARD_LIMITS.maxAllowedTextSizes} sizes`);
    }
    const sizes = value.allowedTextSizes.map((size, index) => positiveNumber(size, `policy.allowedTextSizes[${index}]`));
    policy.allowedTextSizes = [...new Set(sizes)].sort((left, right) => left - right);
  }
  if (value.spacingGrid !== undefined && value.spacingGrid !== null) {
    policy.spacingGrid = positiveNumber(value.spacingGrid, "policy.spacingGrid", true);
  }
  if (value.unsureBelow !== undefined) {
    const unsureBelow = positiveNumber(value.unsureBelow, "policy.unsureBelow");
    if (unsureBelow >= 1) throw new DecisionAssuranceValidationError("policy.unsureBelow must be below 1");
    policy.unsureBelow = unsureBelow;
  }
  if (value.tieMargin !== undefined) {
    if (typeof value.tieMargin !== "number" || !Number.isFinite(value.tieMargin) || value.tieMargin < 0 || value.tieMargin >= 1) {
      throw new DecisionAssuranceValidationError("policy.tieMargin must be in [0, 1)");
    }
    policy.tieMargin = value.tieMargin;
  }
  return policy;
}

function normalizeCandidate(value: unknown, index: number): CandidateInput {
  const label = `candidates[${index}]`;
  assertRecord(value, label, ["candidateId", "rationale", "snapshot"]);
  assertStableId(value.candidateId, `${label}.candidateId`);
  assertText(value.rationale, `${label}.rationale`, ASSURANCE_HARD_LIMITS.maxRationaleLength);
  let snapshot;
  try {
    snapshot = normalizeSnapshot(value.snapshot as never);
  } catch (error) {
    throw new DecisionAssuranceValidationError(`${label}.snapshot is invalid: ${(error as Error).message}`);
  }
  return { candidateId: value.candidateId, rationale: value.rationale, snapshot };
}

export function normalizeAssuranceInput(value: unknown): AssuranceInput {
  const input = inertCopy(value);
  assertRecord(input, "input", ["schemaVersion", "decisionId", "actorId", "intent", "at", "candidates", "rulePacks", "policy"]);
  if (input.schemaVersion !== ASSURANCE_SCHEMA_VERSION) throw new DecisionAssuranceValidationError("input.schemaVersion is unsupported");
  assertStableId(input.decisionId, "input.decisionId");
  assertStableId(input.actorId, "input.actorId");
  assertText(input.intent, "input.intent", ASSURANCE_HARD_LIMITS.maxIntentLength);
  assertTimestamp(input.at, "input.at");
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > ASSURANCE_HARD_LIMITS.maxCandidates) {
    throw new DecisionAssuranceValidationError(`input.candidates must hold 1..${ASSURANCE_HARD_LIMITS.maxCandidates} candidates`);
  }
  const candidates = input.candidates.map((entry, index) => normalizeCandidate(entry, index));
  const ids = new Set(candidates.map((candidate) => candidate.candidateId));
  if (ids.size !== candidates.length) throw new DecisionAssuranceValidationError("input.candidates ids must be distinct");
  const packsInput = input.rulePacks ?? [];
  if (!Array.isArray(packsInput) || packsInput.length > ASSURANCE_HARD_LIMITS.maxRulePacks) {
    throw new DecisionAssuranceValidationError(`input.rulePacks must hold at most ${ASSURANCE_HARD_LIMITS.maxRulePacks} packs`);
  }
  const rulePacks = packsInput.map((pack, index) => {
    try {
      return normalizeRulePack(pack as never);
    } catch (error) {
      throw new DecisionAssuranceValidationError(`input.rulePacks[${index}] is invalid: ${(error as Error).message}`);
    }
  });
  if (new Set(rulePacks.map((pack) => pack.id)).size !== rulePacks.length) {
    throw new DecisionAssuranceValidationError("input.rulePacks ids must be distinct");
  }
  return {
    schemaVersion: ASSURANCE_SCHEMA_VERSION,
    decisionId: input.decisionId,
    actorId: input.actorId,
    intent: input.intent,
    at: input.at,
    candidates,
    rulePacks,
    policy: normalizeAssurancePolicy(input.policy),
  };
}
