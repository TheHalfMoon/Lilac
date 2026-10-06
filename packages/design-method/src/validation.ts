import { createHash } from "node:crypto";
import { DesignMethodValidationError } from "./errors.ts";
import {
  DESIGN_METHOD_HARD_LIMITS,
  DESIGN_METHOD_SCHEMA_VERSION,
  RULE_PACK_PLATFORMS,
  RULE_SEVERITIES,
  SNAPSHOT_NODE_KINDS,
  type DesignSnapshot,
  type MethodRule,
  type ResourceEntry,
  type ResourceRegistry,
  type ReviewChecklist,
  type RulePack,
  type SnapshotNode,
} from "./types.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalMethodStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new DesignMethodValidationError("design value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalMethodStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalMethodStringify(record[key])}`).join(",")}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesignMethodValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DesignMethodValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new DesignMethodValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DesignMethodValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new DesignMethodValidationError(`${label} exceeds ${max} characters`);
}

function assertPackId(value: unknown, label: string): void {
  assertBoundedString(value, label, DESIGN_METHOD_HARD_LIMITS.maxRuleIdLength);
  if (!/^[a-z][a-z0-9-]*$/u.test(value as string)) {
    throw new DesignMethodValidationError(`${label} must be lowercase kebab-case`);
  }
}

export function normalizeRule(value: unknown, label: string): MethodRule {
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["id", "statement", "rationale", "severity"], label);
  assertPackId(value.id, `${label}.id`);
  assertBoundedString(value.statement, `${label}.statement`, DESIGN_METHOD_HARD_LIMITS.maxStatementLength);
  assertBoundedString(value.rationale, `${label}.rationale`, DESIGN_METHOD_HARD_LIMITS.maxStatementLength);
  if (!RULE_SEVERITIES.includes(value.severity as (typeof RULE_SEVERITIES)[number])) {
    throw new DesignMethodValidationError(`${label}.severity is unsupported`);
  }
  return {
    id: value.id as string,
    statement: value.statement as string,
    rationale: value.rationale as string,
    severity: value.severity as MethodRule["severity"],
  };
}

export function normalizeRulePack(value: unknown): RulePack {
  assertPlainObject(value, "design.rulePack");
  assertAllowedKeys(value, ["id", "title", "platform", "category", "version", "rules"], "design.rulePack");
  assertPackId(value.id, "design.rulePack.id");
  assertBoundedString(value.title, "design.rulePack.title", 256);
  if (!RULE_PACK_PLATFORMS.includes(value.platform as (typeof RULE_PACK_PLATFORMS)[number])) {
    throw new DesignMethodValidationError("design.rulePack.platform is unsupported");
  }
  assertBoundedString(value.category, "design.rulePack.category", 128);
  assertBoundedString(value.version, "design.rulePack.version", 64);
  if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > DESIGN_METHOD_HARD_LIMITS.maxRulesPerPack) {
    throw new DesignMethodValidationError("design.rulePack.rules must be a bounded non-empty array");
  }
  const rules = (value.rules as unknown[]).map((rule, index) => normalizeRule(rule, `design.rulePack.rules[${index}]`));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new DesignMethodValidationError("design.rulePack rule ids must be distinct");
  }
  return {
    id: value.id as string,
    title: value.title as string,
    platform: value.platform as RulePack["platform"],
    category: value.category as string,
    version: value.version as string,
    rules,
  };
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DesignMethodValidationError(`${label} must be a finite number`);
  }
}

export function normalizeSnapshotNode(value: unknown, index: number): SnapshotNode {
  const label = `design.snapshot.nodes[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["id", "kind", "label", "x", "y", "width", "height", "text", "textSize", "interactive", "virtualized", "itemCount"], label);
  assertBoundedString(value.id, `${label}.id`, 256);
  if (!SNAPSHOT_NODE_KINDS.includes(value.kind as (typeof SNAPSHOT_NODE_KINDS)[number])) {
    throw new DesignMethodValidationError(`${label}.kind is unsupported`);
  }
  const node: SnapshotNode = { id: value.id as string, kind: value.kind as SnapshotNode["kind"] };
  if (value.label !== undefined) {
    if (typeof value.label !== "string") throw new DesignMethodValidationError(`${label}.label must be a string`);
    if (value.label.length > 512) throw new DesignMethodValidationError(`${label}.label exceeds 512 characters`);
    node.label = value.label as string;
  }
  for (const field of ["x", "y", "width", "height", "textSize"] as const) {
    if (value[field] !== undefined) {
      assertFiniteNumber(value[field], `${label}.${field}`);
      node[field] = value[field] as number;
    }
  }
  if (value.text !== undefined) {
    if (typeof value.text !== "string") throw new DesignMethodValidationError(`${label}.text must be a string`);
    if (value.text.length > 4096) throw new DesignMethodValidationError(`${label}.text exceeds 4096 characters`);
    node.text = value.text as string;
  }
  for (const field of ["interactive", "virtualized"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "boolean") throw new DesignMethodValidationError(`${label}.${field} must be a boolean`);
      node[field] = value[field] as boolean;
    }
  }
  if (value.itemCount !== undefined) {
    if (!Number.isSafeInteger(value.itemCount) || (value.itemCount as number) < 0) {
      throw new DesignMethodValidationError(`${label}.itemCount must be a non-negative safe integer`);
    }
    node.itemCount = value.itemCount as number;
  }
  return node;
}

export function normalizeSnapshot(value: unknown): DesignSnapshot {
  assertPlainObject(value, "design.snapshot");
  assertAllowedKeys(value, ["schemaVersion", "snapshotId", "nodes", "themes", "tokensThemed"], "design.snapshot");
  if (value.schemaVersion !== DESIGN_METHOD_SCHEMA_VERSION) {
    throw new DesignMethodValidationError("unsupported design snapshot schema version");
  }
  assertBoundedString(value.snapshotId, "design.snapshot.snapshotId", 256);
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > DESIGN_METHOD_HARD_LIMITS.maxSnapshotNodes) {
    throw new DesignMethodValidationError("design.snapshot.nodes must be a bounded non-empty array");
  }
  const nodes = (value.nodes as unknown[]).map((node, index) => normalizeSnapshotNode(node, index));
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new DesignMethodValidationError("design.snapshot node ids must be distinct");
  }
  const snapshot: DesignSnapshot = { schemaVersion: DESIGN_METHOD_SCHEMA_VERSION, snapshotId: value.snapshotId as string, nodes };
  if (value.themes !== undefined) {
    if (!Array.isArray(value.themes) || value.themes.length === 0) {
      throw new DesignMethodValidationError("design.snapshot.themes must be a non-empty array");
    }
    for (const theme of value.themes) assertBoundedString(theme, "design.snapshot.theme", 64);
    snapshot.themes = [...value.themes as string[]];
  }
  if (value.tokensThemed !== undefined) {
    if (typeof value.tokensThemed !== "boolean") throw new DesignMethodValidationError("design.snapshot.tokensThemed must be a boolean");
    snapshot.tokensThemed = value.tokensThemed as boolean;
  }
  return snapshot;
}

export function normalizeChecklist(value: unknown, ruleIds: Set<string>): ReviewChecklist {
  assertPlainObject(value, "design.checklist");
  assertAllowedKeys(value, ["id", "role", "items"], "design.checklist");
  assertPackId(value.id, "design.checklist.id");
  assertBoundedString(value.role, "design.checklist.role", 256);
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > DESIGN_METHOD_HARD_LIMITS.maxChecklistItems) {
    throw new DesignMethodValidationError("design.checklist.items must be a bounded non-empty array");
  }
  const items = (value.items as unknown[]).map((item, index) => {
    const label = `design.checklist.items[${index}]`;
    assertPlainObject(item, label);
    assertAllowedKeys(item, ["id", "text", "ruleIds"], label);
    assertPackId(item.id, `${label}.id`);
    assertBoundedString(item.text, `${label}.text`, DESIGN_METHOD_HARD_LIMITS.maxStatementLength);
    if (!Array.isArray(item.ruleIds)) throw new DesignMethodValidationError(`${label}.ruleIds must be an array`);
    for (const ruleId of item.ruleIds) {
      assertBoundedString(ruleId, `${label}.ruleId`, DESIGN_METHOD_HARD_LIMITS.maxRuleIdLength);
      if (!ruleIds.has(ruleId as string)) {
        throw new DesignMethodValidationError(`${label} references unknown rule ${ruleId}`);
      }
    }
    return { id: item.id as string, text: item.text as string, ruleIds: [...item.ruleIds as string[]] };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new DesignMethodValidationError("design.checklist item ids must be distinct");
  }
  return { id: value.id as string, role: value.role as string, items };
}

export const RESOURCE_TAXONOMY_VERSION = "1";
export const RESOURCE_TAXONOMY_CATEGORIES = [
  "fonts",
  "icons",
  "colors",
  "illustrations",
  "vectors",
  "photos",
  "videos",
  "ui-kits",
  "design-systems",
  "mockups",
  "prototyping-tools",
  "inspiration",
  "learning",
] as const;

export function normalizeResourceEntry(value: unknown, index: number): ResourceEntry {
  const label = `design.registry.entries[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["id", "name", "category", "source", "license", "url", "notes"], label);
  assertPackId(value.id, `${label}.id`);
  assertBoundedString(value.name, `${label}.name`, 256);
  if (!(RESOURCE_TAXONOMY_CATEGORIES as readonly string[]).includes(value.category as string)) {
    throw new DesignMethodValidationError(`${label}.category is outside the fixed taxonomy`);
  }
  assertBoundedString(value.source, `${label}.source`, 512);
  assertBoundedString(value.license, `${label}.license`, DESIGN_METHOD_HARD_LIMITS.maxLicenseLength);
  const entry: ResourceEntry = {
    id: value.id as string,
    name: value.name as string,
    category: value.category as string,
    source: value.source as string,
    license: value.license as string,
  };
  if (value.url !== undefined) {
    assertBoundedString(value.url, `${label}.url`, DESIGN_METHOD_HARD_LIMITS.maxUrlLength);
    entry.url = value.url as string;
  }
  if (value.notes !== undefined) {
    assertBoundedString(value.notes, `${label}.notes`, 1024);
    entry.notes = value.notes as string;
  }
  return entry;
}

export function normalizeRegistry(value: unknown): ResourceRegistry {
  assertPlainObject(value, "design.registry");
  assertAllowedKeys(value, ["schemaVersion", "taxonomyVersion", "entries"], "design.registry");
  if (value.schemaVersion !== DESIGN_METHOD_SCHEMA_VERSION) {
    throw new DesignMethodValidationError("unsupported design registry schema version");
  }
  if (value.taxonomyVersion !== RESOURCE_TAXONOMY_VERSION) {
    throw new DesignMethodValidationError("design.registry taxonomy version is unsupported");
  }
  if (!Array.isArray(value.entries) || value.entries.length > DESIGN_METHOD_HARD_LIMITS.maxRegistryEntries) {
    throw new DesignMethodValidationError("design.registry.entries exceeds its bounded budget");
  }
  const entries = (value.entries as unknown[]).map((entry, index) => normalizeResourceEntry(entry, index));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new DesignMethodValidationError("design.registry entry ids must be distinct");
  }
  return { schemaVersion: DESIGN_METHOD_SCHEMA_VERSION, taxonomyVersion: RESOURCE_TAXONOMY_VERSION, entries };
}
