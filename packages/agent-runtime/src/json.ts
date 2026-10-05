import { AgentRuntimeError } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const MAX_JSON_DEPTH = 128;

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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentRuntimeError(`${label} must not be a class instance`);
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
  depth = 0,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new AgentRuntimeError(`${label} exceeds the maximum JSON nesting depth`);
  }
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
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new AgentRuntimeError(`${label}[${index}] must be an own data value`);
        }
        result.push(normalizeJson(descriptor.value, `${label}[${index}]`, seen, depth + 1));
      }
      return result;
    }

    assertPlainObject(value, label);
    const object = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(object).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new AgentRuntimeError(`${label}.${key} must be an own data value`);
      }
      if (descriptor.value === undefined) {
        throw new AgentRuntimeError(`${label}.${key} is undefined`);
      }
      result[key] = normalizeJson(descriptor.value, `${label}.${key}`, seen, depth + 1);
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
