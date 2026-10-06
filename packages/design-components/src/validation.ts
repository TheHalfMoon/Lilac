import { createHash } from "node:crypto";
import { DesignComponentsValidationError } from "./errors.ts";
import {
  DESIGN_COMPONENTS_HARD_LIMITS,
  DESIGN_COMPONENTS_SCHEMA_VERSION,
  type ComponentContract,
  type ComponentVariant,
  type ContractProp,
  type ContractPropType,
  type DesignSystem,
  type SlotDef,
} from "./types.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalComponentsStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new DesignComponentsValidationError("components value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalComponentsStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalComponentsStringify(record[key])}`).join(",")}}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesignComponentsValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DesignComponentsValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new DesignComponentsValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DesignComponentsValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new DesignComponentsValidationError(`${label} exceeds ${max} characters`);
}

function assertIdentifier(value: unknown, label: string, max = 128): void {
  assertBoundedString(value, label, max);
  if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(value as string)) {
    throw new DesignComponentsValidationError(`${label} must be an identifier`);
  }
}

function normalizePropType(value: unknown, label: string): ContractPropType {
  assertPlainObject(value, label);
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    assertAllowedKeys(value as Record<string, unknown>, ["kind"], label);
    return { kind };
  }
  if (kind === "enum") {
    assertAllowedKeys(value as Record<string, unknown>, ["kind", "values"], label);
    const values = (value as Record<string, unknown>).values;
    if (!Array.isArray(values) || values.length < 2 || values.length > DESIGN_COMPONENTS_HARD_LIMITS.maxEnumValues) {
      throw new DesignComponentsValidationError(`${label}.values must be a bounded non-empty enum set`);
    }
    for (const entry of values) assertBoundedString(entry, `${label}.value`, 256);
    if (new Set(values as string[]).size !== (values as string[]).length) {
      throw new DesignComponentsValidationError(`${label}.values must be distinct`);
    }
    return { kind: "enum", values: [...values as string[]] };
  }
  throw new DesignComponentsValidationError(`${label}.kind is unsupported`);
}

function normalizeContractProp(value: unknown, index: number): ContractProp {
  const label = `components.contract.props[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["name", "propType", "required", "default"], label);
  assertIdentifier(value.name, `${label}.name`);
  const propType = normalizePropType(value.propType, `${label}.propType`);
  if (typeof value.required !== "boolean") throw new DesignComponentsValidationError(`${label}.required must be a boolean`);
  const prop: ContractProp = { name: value.name as string, propType, required: value.required as boolean };
  if (value.default !== undefined) {
    const fallback = value.default as unknown;
    const ok =
      (propType.kind === "string" && typeof fallback === "string")
      || (propType.kind === "number" && typeof fallback === "number")
      || (propType.kind === "boolean" && typeof fallback === "boolean")
      || (propType.kind === "enum" && typeof fallback === "string" && propType.values.includes(fallback));
    if (!ok) throw new DesignComponentsValidationError(`${label}.default does not match the declared type`);
    prop.default = fallback as string | number | boolean;
  }
  return prop;
}

function normalizeSlot(value: unknown, index: number): SlotDef {
  const label = `components.contract.slots[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["name", "tag", "required"], label);
  assertIdentifier(value.name, `${label}.name`);
  assertIdentifier(value.tag, `${label}.tag`);
  if (typeof value.required !== "boolean") throw new DesignComponentsValidationError(`${label}.required must be a boolean`);
  return { name: value.name as string, tag: value.tag as string, required: value.required as boolean };
}

function normalizeVariant(value: unknown, index: number): ComponentVariant {
  const label = `components.contract.variants[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["name", "props", "minWidth", "maxWidth"], label);
  assertIdentifier(value.name, `${label}.name`);
  assertPlainObject(value.props, `${label}.props`);
  const props: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value.props)) {
    assertIdentifier(key, `${label}.prop key`);
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new DesignComponentsValidationError(`${label}.props values must be literals`);
    }
    props[key] = entry;
  }
  const variant: ComponentVariant = { name: value.name as string, props };
  for (const field of ["minWidth", "maxWidth"] as const) {
    if (value[field] !== undefined) {
      if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
        throw new DesignComponentsValidationError(`${label}.${field} must be a non-negative safe integer`);
      }
      variant[field] = value[field] as number;
    }
  }
  if (variant.minWidth !== undefined && variant.maxWidth !== undefined && variant.minWidth > variant.maxWidth) {
    throw new DesignComponentsValidationError(`${label} viewport range is inverted`);
  }
  return variant;
}

export function normalizeContract(value: unknown): ComponentContract {
  assertPlainObject(value, "components.contract");
  assertAllowedKeys(value, ["schemaVersion", "contractId", "componentName", "sourceFile", "props", "slots", "states", "variants", "systemId"], "components.contract");
  if (value.schemaVersion !== DESIGN_COMPONENTS_SCHEMA_VERSION) {
    throw new DesignComponentsValidationError("unsupported component contract schema version");
  }
  assertBoundedString(value.contractId, "components.contract.contractId", 256);
  assertBoundedString(value.componentName, "components.contract.componentName", 128);
  if (!/^[A-Z][A-Za-z0-9]*$/u.test(value.componentName as string)) {
    throw new DesignComponentsValidationError("components.contract.componentName must be a capitalized identifier");
  }
  assertBoundedString(value.sourceFile, "components.contract.sourceFile", 512);
  if (!Array.isArray(value.props) || value.props.length > DESIGN_COMPONENTS_HARD_LIMITS.maxProps) {
    throw new DesignComponentsValidationError("components.contract.props exceeds its bounded budget");
  }
  const props = (value.props as unknown[]).map((prop, index) => normalizeContractProp(prop, index));
  if (new Set(props.map((prop) => prop.name)).size !== props.length) {
    throw new DesignComponentsValidationError("components.contract prop names must be distinct");
  }
  if (!Array.isArray(value.slots) || value.slots.length > DESIGN_COMPONENTS_HARD_LIMITS.maxSlots) {
    throw new DesignComponentsValidationError("components.contract.slots exceeds its bounded budget");
  }
  const slots = (value.slots as unknown[]).map((slot, index) => normalizeSlot(slot, index));
  if (new Set(slots.map((slot) => slot.name)).size !== slots.length) {
    throw new DesignComponentsValidationError("components.contract slot names must be distinct");
  }
  if (!Array.isArray(value.states) || value.states.length > DESIGN_COMPONENTS_HARD_LIMITS.maxStates) {
    throw new DesignComponentsValidationError("components.contract.states exceeds its bounded budget");
  }
  for (const state of value.states) assertIdentifier(state, "components.contract.state");
  if (new Set(value.states as string[]).size !== (value.states as string[]).length) {
    throw new DesignComponentsValidationError("components.contract states must be distinct");
  }
  if (!Array.isArray(value.variants) || value.variants.length > DESIGN_COMPONENTS_HARD_LIMITS.maxVariants) {
    throw new DesignComponentsValidationError("components.contract.variants exceeds its bounded budget");
  }
  const variants = (value.variants as unknown[]).map((variant, index) => normalizeVariant(variant, index));
  if (new Set(variants.map((variant) => variant.name)).size !== variants.length) {
    throw new DesignComponentsValidationError("components.contract variant names must be distinct");
  }
  for (const variant of variants) {
    for (const key of Object.keys(variant.props)) {
      if (!props.some((prop) => prop.name === key)) {
        throw new DesignComponentsValidationError(`variant ${variant.name} sets unknown prop ${key}`);
      }
    }
  }
  const contract: ComponentContract = {
    schemaVersion: DESIGN_COMPONENTS_SCHEMA_VERSION,
    contractId: value.contractId as string,
    componentName: value.componentName as string,
    sourceFile: value.sourceFile as string,
    props,
    slots,
    states: [...value.states as string[]],
    variants,
  };
  if (value.systemId !== undefined) {
    assertBoundedString(value.systemId, "components.contract.systemId", 256);
    contract.systemId = value.systemId as string;
  }
  return contract;
}

export function normalizeSystem(value: unknown): DesignSystem {
  assertPlainObject(value, "components.system");
  assertAllowedKeys(value, ["schemaVersion", "systemId", "name", "contracts", "tokens"], "components.system");
  if (value.schemaVersion !== DESIGN_COMPONENTS_SCHEMA_VERSION) {
    throw new DesignComponentsValidationError("unsupported design system schema version");
  }
  assertBoundedString(value.systemId, "components.system.systemId", 256);
  assertBoundedString(value.name, "components.system.name", 256);
  if (!Array.isArray(value.contracts) || value.contracts.length > DESIGN_COMPONENTS_HARD_LIMITS.maxSystemComponents) {
    throw new DesignComponentsValidationError("components.system.contracts exceeds its bounded budget");
  }
  const contracts = (value.contracts as unknown[]).map(normalizeContract);
  if (new Set(contracts.map((contract) => contract.contractId)).size !== contracts.length) {
    throw new DesignComponentsValidationError("components.system contract ids must be distinct");
  }
  if (new Set(contracts.map((contract) => contract.componentName)).size !== contracts.length) {
    throw new DesignComponentsValidationError("components.system component names must be distinct");
  }
  if (!Array.isArray(value.tokens) || value.tokens.length > DESIGN_COMPONENTS_HARD_LIMITS.maxSystemTokens) {
    throw new DesignComponentsValidationError("components.system.tokens exceeds its bounded budget");
  }
  for (const token of value.tokens) assertBoundedString(token, "components.system.token", 256);
  return {
    schemaVersion: DESIGN_COMPONENTS_SCHEMA_VERSION,
    systemId: value.systemId as string,
    name: value.name as string,
    contracts,
    tokens: [...value.tokens as string[]],
  };
}
