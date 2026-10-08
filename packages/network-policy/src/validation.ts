import { types } from "node:util";
import { NetworkPolicyValidationError } from "./errors.ts";
import { NETWORK_LIMITS } from "./types.ts";

// Shared hidden-text rule (same as @ninerr/decision-assurance; a cross-package policy is
// tracked in #64): controls, format characters, separators, and blank fillers are refused.
const HIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{34f}\u{115f}\u{1160}\u{2800}\u{3164}\u{ffa0}]/u;

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function shown(path: string): string {
  return path.length > 120 ? `${path.slice(0, 120)}...` : path;
}

/**
 * One read of untrusted configuration into inert plain data: proxies, accessors, foreign
 * prototypes, symbol keys, sparse or decorated arrays, non-finite numbers, hidden text, and
 * oversized or over-deep values are refused before any field is interpreted.
 */
export function inertCopy(value: unknown, label: string): unknown {
  let budget: number = NETWORK_LIMITS.maxInputValues;
  const walk = (entry: unknown, path: string, depth: number): unknown => {
    budget -= 1;
    if (budget < 0) throw new NetworkPolicyValidationError(`${label} exceeds ${NETWORK_LIMITS.maxInputValues} values`);
    if (depth > NETWORK_LIMITS.maxInputDepth) throw new NetworkPolicyValidationError(`${shown(path)} is nested too deeply`);
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "string") {
      if (entry.length > NETWORK_LIMITS.maxStringLength) throw new NetworkPolicyValidationError(`${shown(path)} is too long`);
      if (!entry.isWellFormed() || HIDDEN_TEXT.test(entry)) throw new NetworkPolicyValidationError(`${shown(path)} contains control or hidden characters`);
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new NetworkPolicyValidationError(`${shown(path)} must be a finite number`);
      return entry;
    }
    if (typeof entry !== "object") throw new NetworkPolicyValidationError(`${shown(path)} has an unsupported value type`);
    if (types.isProxy(entry)) throw new NetworkPolicyValidationError(`${shown(path)} must not be a proxy`);
    const isArray = Array.isArray(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new NetworkPolicyValidationError(`${shown(path)} must be a plain ${isArray ? "array" : "object"}`);
    }
    if (isArray && (entry as unknown[]).length > budget) throw new NetworkPolicyValidationError(`${label} exceeds ${NETWORK_LIMITS.maxInputValues} values`);
    const keys = Reflect.ownKeys(entry);
    if (keys.length > budget + 1) throw new NetworkPolicyValidationError(`${label} exceeds ${NETWORK_LIMITS.maxInputValues} values`);
    if (keys.some((key) => typeof key === "symbol")) throw new NetworkPolicyValidationError(`${shown(path)} must not have symbol keys`);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    for (const key of keys as string[]) {
      if (key.length > 128) throw new NetworkPolicyValidationError(`${shown(path)} has an over-long key`);
      if (!("value" in descriptors[key])) throw new NetworkPolicyValidationError(`${shown(`${path}.${key}`)} must not be an accessor`);
    }
    if (isArray) {
      const length = descriptors.length.value as number;
      if (keys.length !== length + 1) throw new NetworkPolicyValidationError(`${shown(path)} must be a dense array without extra properties`);
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = descriptors[String(index)];
        if (!item) throw new NetworkPolicyValidationError(`${shown(path)} must be a dense array`);
        copy.push(walk(item.value, `${path}[${index}]`, depth + 1));
      }
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      if (key === "__proto__") throw new NetworkPolicyValidationError(`${shown(path)} must not define __proto__`);
      copy[key] = walk(descriptors[key].value, `${path}.${key}`, depth + 1);
    }
    return copy;
  };
  return walk(value, label, 0);
}

export function assertRecord(value: unknown, label: string, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NetworkPolicyValidationError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new NetworkPolicyValidationError(`${label} contains unsupported field ${JSON.stringify(key).slice(0, 60)}`);
  }
}

export function assertStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) throw new NetworkPolicyValidationError(`${label} must be a stable identifier`);
}

export function assertOneOf<T extends string>(value: unknown, options: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    throw new NetworkPolicyValidationError(`${label} must be one of ${options.join(", ")}`);
  }
}
