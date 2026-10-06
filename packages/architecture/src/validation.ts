import { createHash } from "node:crypto";
import { ArchitectureValidationError } from "./errors.ts";
import {
  ARCHITECTURE_HARD_LIMITS,
  ARCHITECTURE_SCHEMA_VERSION,
  SUBSYSTEM_STATUSES,
  type ArchitectureMap,
  type SubsystemRecord,
} from "./types.ts";

export const IMPLEMENTED_PACKAGES = [
  "@lilac/design-assurance",
  "@lilac/document-model",
  "@lilac/history",
  "@lilac/mcp-protocol",
  "@lilac/agent-runtime",
  "@lilac/agent-events",
  "@lilac/agent-supervisor",
  "@lilac/collaboration",
  "@lilac/import-stack",
  "@lilac/decision-router",
  "@lilac/delivery-governance",
  "@lilac/design-method",
  "@lilac/architecture",
] as const;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalArchitectureStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new ArchitectureValidationError("architecture value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalArchitectureStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalArchitectureStringify(record[key])}`).join(",")}}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArchitectureValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArchitectureValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new ArchitectureValidationError(`${label} contains unsupported field ${key}`);
  }
}

function assertSubsystemId(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new ArchitectureValidationError(`${label} must be a bounded non-empty string`);
  }
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new ArchitectureValidationError(`${label} must be lowercase kebab-case`);
  }
}

export function normalizeSubsystem(value: unknown, index: number): SubsystemRecord {
  const label = `architecture.subsystems[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["id", "title", "owner", "status", "boundary", "dependsOn"], label);
  assertSubsystemId(value.id, `${label}.id`);
  if (typeof value.title !== "string" || value.title.trim() === "" || value.title.length > 256) {
    throw new ArchitectureValidationError(`${label}.title must be a bounded non-empty string`);
  }
  if (typeof value.owner !== "string" || !/^@lilac\/[a-z][a-z0-9-]*$/u.test(value.owner)) {
    throw new ArchitectureValidationError(`${label}.owner must be a Lilac package name`);
  }
  if (!SUBSYSTEM_STATUSES.includes(value.status as (typeof SUBSYSTEM_STATUSES)[number])) {
    throw new ArchitectureValidationError(`${label}.status is unsupported`);
  }
  if (typeof value.boundary !== "string" || value.boundary.trim() === "" || value.boundary.length > ARCHITECTURE_HARD_LIMITS.maxBoundaryLength) {
    throw new ArchitectureValidationError(`${label}.boundary must be a bounded non-empty string`);
  }
  if (!Array.isArray(value.dependsOn) || value.dependsOn.length > ARCHITECTURE_HARD_LIMITS.maxDependencies) {
    throw new ArchitectureValidationError(`${label}.dependsOn exceeds its bounded budget`);
  }
  for (const dependency of value.dependsOn) assertSubsystemId(dependency, `${label}.dependency`);
  const record: SubsystemRecord = {
    id: value.id as string,
    title: value.title as string,
    owner: value.owner as string,
    status: value.status as SubsystemRecord["status"],
    boundary: value.boundary as string,
    dependsOn: [...value.dependsOn as string[]],
  };
  if (record.status === "implemented" && !(IMPLEMENTED_PACKAGES as readonly string[]).includes(record.owner)) {
    throw new ArchitectureValidationError(`${label} claims implemented status for unknown package ${record.owner}`);
  }
  return record;
}

/**
 * Validate a full ownership map: distinct ids, exactly one owner each (by
 * construction), known dependencies, no self-dependencies, and an acyclic
 * dependency graph. Implemented subsystems must name an existing package.
 */
export function normalizeArchitectureMap(value: unknown): ArchitectureMap {
  assertPlainObject(value, "architecture.map");
  assertAllowedKeys(value, ["schemaVersion", "subsystems"], "architecture.map");
  if (value.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) {
    throw new ArchitectureValidationError("unsupported architecture map schema version");
  }
  if (!Array.isArray(value.subsystems) || value.subsystems.length === 0 || value.subsystems.length > ARCHITECTURE_HARD_LIMITS.maxSubsystems) {
    throw new ArchitectureValidationError("architecture.subsystems must be a bounded non-empty array");
  }
  const subsystems = (value.subsystems as unknown[]).map((entry, index) => normalizeSubsystem(entry, index));
  const ids = subsystems.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new ArchitectureValidationError("architecture subsystem ids must be distinct");
  }
  const known = new Set(ids);
  for (const entry of subsystems) {
    for (const dependency of entry.dependsOn) {
      if (!known.has(dependency)) {
        throw new ArchitectureValidationError(`subsystem ${entry.id} depends on unknown subsystem ${dependency}`);
      }
      if (dependency === entry.id) {
        throw new ArchitectureValidationError(`subsystem ${entry.id} must not depend on itself`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(subsystems.map((entry) => [entry.id, entry]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new ArchitectureValidationError(`architecture dependency cycle detected at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...ids].sort()) visit(id);
  return { schemaVersion: ARCHITECTURE_SCHEMA_VERSION, subsystems };
}

export function architectureDigest(map: ArchitectureMap): string {
  return sha256Text(canonicalArchitectureStringify(normalizeArchitectureMap(map)));
}
