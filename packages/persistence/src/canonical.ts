import { createHash } from "node:crypto";
import { PersistenceValidationError } from "./errors.ts";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const MAX_DEPTH = 256;

/**
 * Key-sorted JSON that refuses anything JSON cannot represent faithfully (undefined,
 * non-finite numbers, class instances such as Date or Map, functions, symbols, sparse
 * arrays), so what is persisted is exactly what is replayed.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new PersistenceValidationError(`cannot persist values nested deeper than ${MAX_DEPTH}`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PersistenceValidationError("cannot persist a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new PersistenceValidationError("cannot persist a sparse array");
      parts.push(canonicalJson(value[index], depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PersistenceValidationError("cannot persist a non-plain object");
    }
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw new PersistenceValidationError(`cannot persist undefined at key ${JSON.stringify(key).slice(0, 80)}`);
        return `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`;
      })
      .join(",");
    return `{${body}}`;
  }
  throw new PersistenceValidationError(`cannot persist a ${typeof value} value`);
}
