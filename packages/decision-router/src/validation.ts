import { createHash } from "node:crypto";
import { DecisionValidationError } from "./errors.ts";
import {
  DECISION_HARD_LIMITS,
  DECISION_SCHEMA_VERSION,
  type DecisionCell,
  type DecisionDimension,
  type DecisionPolicy,
  type DecisionPrecheck,
  type DecisionRequest,
} from "./types.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalDecisionStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new DecisionValidationError("decision value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalDecisionStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalDecisionStringify(record[key])}`).join(",")}}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DecisionValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DecisionValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new DecisionValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DecisionValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new DecisionValidationError(`${label} exceeds ${max} characters`);
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 128);
  if (Number.isNaN(Date.parse(value))) throw new DecisionValidationError(`${label} must be an ISO-compatible timestamp`);
}

function boundedInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new DecisionValidationError(`${label} must be a positive safe integer <= ${max}`);
  }
  return value as number;
}

export function readDimensions(value: unknown): DecisionDimension[] {
  if (!Array.isArray(value)) {
    throw new DecisionValidationError("dimensions must be a non-empty array");
  }
  if (value.length === 0 || value.length > DECISION_HARD_LIMITS.maxDimensions) {
    throw new DecisionValidationError(`provide 1-${DECISION_HARD_LIMITS.maxDimensions} dimensions`);
  }
  let definitionChars = 0;
  const countChars = (entry: unknown, depth: number): void => {
    if (depth > 8) throw new DecisionValidationError("dimension definitions are nested too deeply");
    if (typeof entry === "string") {
      definitionChars += entry.length;
      if (definitionChars > DECISION_HARD_LIMITS.maxDimensionDefinitionChars) {
        throw new DecisionValidationError("dimension definitions exceed the combined character budget");
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) countChars(item, depth + 1);
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const key of Object.keys(entry)) {
        definitionChars += key.length;
        if (definitionChars > DECISION_HARD_LIMITS.maxDimensionDefinitionChars) {
          throw new DecisionValidationError("dimension definitions exceed the combined character budget");
        }
        countChars((entry as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  countChars(value, 0);
  return value.map((entry, index) => {
    assertPlainObject(entry, `dimensions[${index}]`);
    assertAllowedKeys(entry, ["name", "labels", "instructions"], `dimensions[${index}]`);
    assertBoundedString(entry.name, `dimensions[${index}].name`, DECISION_HARD_LIMITS.maxDimensionNameLength);
    if (!Array.isArray(entry.labels)) {
      throw new DecisionValidationError(`dimensions[${index}].labels must be an array`);
    }
    if (entry.labels.length < 2 || entry.labels.length > DECISION_HARD_LIMITS.maxLabels) {
      throw new DecisionValidationError(`dimensions[${index}] needs 2-${DECISION_HARD_LIMITS.maxLabels} labels`);
    }
    for (const label of entry.labels) {
      assertBoundedString(label, `dimensions[${index}].label`, DECISION_HARD_LIMITS.maxLabelLength);
    }
    if (new Set(entry.labels).size !== entry.labels.length) {
      throw new DecisionValidationError(`dimensions[${index}].labels must be distinct`);
    }
    const dimension: DecisionDimension = { name: entry.name as string, labels: [...entry.labels as string[]] };
    if (entry.instructions !== undefined) {
      assertBoundedString(entry.instructions, `dimensions[${index}].instructions`, DECISION_HARD_LIMITS.maxInstructionsLength);
      dimension.instructions = entry.instructions as string;
    }
    return dimension;
  });
}

export function defaultDecisionPolicy(overrides: Partial<DecisionPolicy> = {}): DecisionPolicy {
  const unsureBelow = overrides.unsureBelow ?? 0.7;
  if (typeof unsureBelow !== "number" || !Number.isFinite(unsureBelow) || unsureBelow <= 0 || unsureBelow >= 1) {
    throw new DecisionValidationError("unsureBelow must be a finite number in (0, 1)");
  }
  return {
    unsureBelow,
    maxItems: overrides.maxItems ?? DECISION_HARD_LIMITS.maxItems,
    maxInputChars: overrides.maxInputChars ?? DECISION_HARD_LIMITS.maxInputChars,
    maxCellsPerBatch: overrides.maxCellsPerBatch ?? DECISION_HARD_LIMITS.maxCellsPerBatch,
    maxReviewItems: overrides.maxReviewItems ?? DECISION_HARD_LIMITS.maxReviewItems,
  };
}

export function normalizeDecisionPolicy(value: unknown): DecisionPolicy {
  assertPlainObject(value, "decision.policy");
  assertAllowedKeys(value, ["unsureBelow", "maxItems", "maxInputChars", "maxCellsPerBatch", "maxReviewItems"], "decision.policy");
  const policy = defaultDecisionPolicy({
    ...(value.unsureBelow === undefined ? {} : { unsureBelow: value.unsureBelow as number }),
  });
  if (value.maxItems !== undefined) policy.maxItems = boundedInteger(value.maxItems, "decision.policy.maxItems", DECISION_HARD_LIMITS.maxItems);
  if (value.maxInputChars !== undefined) policy.maxInputChars = boundedInteger(value.maxInputChars, "decision.policy.maxInputChars", DECISION_HARD_LIMITS.maxInputChars);
  if (value.maxCellsPerBatch !== undefined) policy.maxCellsPerBatch = boundedInteger(value.maxCellsPerBatch, "decision.policy.maxCellsPerBatch", DECISION_HARD_LIMITS.maxCellsPerBatch);
  if (value.maxReviewItems !== undefined) policy.maxReviewItems = boundedInteger(value.maxReviewItems, "decision.policy.maxReviewItems", DECISION_HARD_LIMITS.maxReviewItems);
  return policy;
}

export function normalizeDecisionRequest(value: unknown): DecisionRequest {
  assertPlainObject(value, "decision.request");
  assertAllowedKeys(value, ["schemaVersion", "requestId", "actorId", "intent", "at", "inputs", "dimensions", "policy"], "decision.request");
  if (value.schemaVersion !== DECISION_SCHEMA_VERSION) {
    throw new DecisionValidationError("unsupported decision request schema version");
  }
  assertBoundedString(value.requestId, "decision.requestId", 256);
  assertBoundedString(value.actorId, "decision.actorId", 256);
  assertBoundedString(value.intent, "decision.intent", 2048);
  assertTimestamp(value.at, "decision.at");
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    throw new DecisionValidationError("decision.inputs must be a non-empty array");
  }
  const policy = normalizeDecisionPolicy(value.policy);
  if (value.inputs.length > policy.maxItems) {
    throw new DecisionValidationError("decision.inputs exceeds policy maxItems");
  }
  const inputs = value.inputs.map((input, index) => {
    assertBoundedString(input, `decision.inputs[${index}]`, policy.maxInputChars);
    return input as string;
  });
  const dimensions = readDimensions(value.dimensions);
  if (inputs.length * dimensions.length > policy.maxCellsPerBatch * 64) {
    throw new DecisionValidationError("decision cells exceed the bounded batch budget");
  }
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    requestId: value.requestId as string,
    actorId: value.actorId as string,
    intent: value.intent as string,
    at: value.at as string,
    inputs,
    dimensions,
    policy,
  };
}

export function normalizeDecisionPrecheck(value: unknown, request: DecisionRequest): DecisionPrecheck {
  assertPlainObject(value, "decision.precheck");
  assertAllowedKeys(value, ["itemIndex", "dimensionIndex", "verdict"], "decision.precheck");
  if (!Number.isSafeInteger(value.itemIndex) || (value.itemIndex as number) < 0 || (value.itemIndex as number) >= request.inputs.length) {
    throw new DecisionValidationError("decision.precheck.itemIndex is out of range");
  }
  let dimensionIndex: number | undefined;
  if (value.dimensionIndex !== undefined) {
    if (!Number.isSafeInteger(value.dimensionIndex) || (value.dimensionIndex as number) < 0 || (value.dimensionIndex as number) >= request.dimensions.length) {
      throw new DecisionValidationError("decision.precheck.dimensionIndex is out of range");
    }
    dimensionIndex = value.dimensionIndex as number;
  }
  assertPlainObject(value.verdict, "decision.precheck.verdict");
  const kind = (value.verdict as Record<string, unknown>).kind;
  if (kind === "label") {
    assertAllowedKeys(value.verdict as Record<string, unknown>, ["kind", "label"], "decision.precheck.verdict");
    const label = (value.verdict as Record<string, unknown>).label;
    assertBoundedString(label, "decision.precheck.verdict.label", DECISION_HARD_LIMITS.maxLabelLength);
    const targets = dimensionIndex === undefined ? request.dimensions : [request.dimensions[dimensionIndex]];
    for (const dimension of targets) {
      if (!dimension.labels.includes(label as string)) {
        throw new DecisionValidationError(`decision.precheck label is not in dimension ${dimension.name}`);
      }
    }
    return { itemIndex: value.itemIndex as number, ...(dimensionIndex === undefined ? {} : { dimensionIndex }), verdict: { kind: "label", label: label as string } };
  }
  if (kind === "abstain") {
    assertAllowedKeys(value.verdict as Record<string, unknown>, ["kind", "reason"], "decision.precheck.verdict");
    assertBoundedString((value.verdict as Record<string, unknown>).reason, "decision.precheck.verdict.reason", 512);
    return { itemIndex: value.itemIndex as number, ...(dimensionIndex === undefined ? {} : { dimensionIndex }), verdict: { kind: "abstain", reason: (value.verdict as Record<string, unknown>).reason as string } };
  }
  throw new DecisionValidationError("decision.precheck.verdict.kind must be label or abstain");
}

export function packDecisionCells(request: DecisionRequest): DecisionCell[][] {
  const cells: DecisionCell[] = [];
  request.inputs.forEach((input, itemIndex) => {
    request.dimensions.forEach((dimension, dimensionIndex) => {
      cells.push({
        itemIndex,
        dimensionIndex,
        cellId: `decision-cell:${sha256Text(`${request.requestId}:${itemIndex}:${dimensionIndex}`).slice(0, 32)}`,
        input,
        dimension,
      });
    });
  });
  const batches: DecisionCell[][] = [];
  for (let index = 0; index < cells.length; index += request.policy.maxCellsPerBatch) {
    batches.push(cells.slice(index, index + request.policy.maxCellsPerBatch));
  }
  return batches;
}

export function dimensionsSha256(dimensions: DecisionDimension[]): string {
  return sha256Text(canonicalDecisionStringify(dimensions));
}
