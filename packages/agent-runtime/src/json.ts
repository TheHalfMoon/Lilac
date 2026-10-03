import { AgentRuntimeError } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentRuntimeError(`${label} must be a non-empty string`);
  }
}

export function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(value))) {
    throw new AgentRuntimeError(`${label} must be an ISO-compatible timestamp`);
  }
}

export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRuntimeError(`${label} must be a plain object`);
  }
}

export function normalizeStringSet(values: unknown, label: string): string[] {
  if (!Array.isArray(values)) throw new AgentRuntimeError(`${label} must be an array`);
  const result = new Set<string>();
  for (const value of values) {
    assertNonEmptyString(value, `${label} entry`);
    result.add(value);
  }
  return [...result].sort();
}

export function normalizeJson(
  value: unknown,
  label = "value",
  seen = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AgentRuntimeError(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new AgentRuntimeError(`${label} must be JSON-serializable`);
  if (seen.has(value)) throw new AgentRuntimeError(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeJson(entry, `${label}[${index}]`, seen));
    }
    const object = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) throw new AgentRuntimeError(`${label}.${key} is undefined`);
      result[key] = normalizeJson(object[key], `${label}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

export function isThenable(value: unknown): boolean {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}
