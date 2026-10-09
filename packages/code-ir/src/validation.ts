import { createHash } from "node:crypto";
import { CodeIrValidationError } from "./errors.ts";
import {
  CODE_IR_HARD_LIMITS,
  CODE_IR_SCHEMA_VERSION,
  type CodeIr,
  type DesignDoc,
  type DesignDocNode,
  type MergeConflict,
  type PatchAnchor,
  type PatchOp,
  type SourceRange,
  type SourceSymbol,
  type SymbolRelation,
  type UnsupportedRegion,
} from "./types.ts";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalCodeIrStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new CodeIrValidationError("code value is not serializable");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCodeIrStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalCodeIrStringify(record[key])}`).join(",")}}`;
}

export function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodeIrValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CodeIrValidationError(`${label} must not be a class instance`);
  }
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) throw new CodeIrValidationError(`${label} contains unsupported field ${key}`);
  }
}

export function assertBoundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CodeIrValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > max) throw new CodeIrValidationError(`${label} exceeds ${max} characters`);
}

export function assertSourceFile(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 512);
  if ((value as string).includes("\0") || /^\s|\s$/u.test(value as string)) {
    throw new CodeIrValidationError(`${label} must be a clean relative path`);
  }
}

export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function offsetToLineCol(starts: number[], offset: number): { line: number; col: number } {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
  return { line: line + 1, col: offset - starts[line] + 1 };
}

export function makeRange(file: string, source: string, starts: number[], startOffset: number, endOffset: number): SourceRange {
  if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset > source.length || endOffset < startOffset) {
    throw new CodeIrValidationError("source range offsets are invalid");
  }
  const start = offsetToLineCol(starts, startOffset);
  const end = offsetToLineCol(starts, endOffset);
  return {
    file,
    startOffset,
    endOffset,
    startLine: start.line,
    startCol: start.col,
    endLine: end.line,
    endCol: end.col,
  };
}

export function symbolId(file: string, kind: string, name: string, startOffset: number): string {
  return `code-symbol:${sha256Text(`${file}:${kind}:${name}:${startOffset}`).slice(0, 32)}`;
}

const RANGE_KEYS = ["file", "startOffset", "endOffset", "startLine", "startCol", "endLine", "endCol"];

export function normalizeRange(value: unknown, label: string): SourceRange {
  assertPlainObject(value, label);
  assertAllowedKeys(value, RANGE_KEYS, label);
  assertSourceFile(value.file, `${label}.file`);
  for (const field of ["startOffset", "endOffset", "startLine", "startCol", "endLine", "endCol"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new CodeIrValidationError(`${label}.${field} must be a non-negative safe integer`);
    }
  }
  const range = value as unknown as SourceRange;
  if (range.endOffset < range.startOffset || range.endLine < range.startLine) {
    throw new CodeIrValidationError(`${label} ends before it starts`);
  }
  return { ...range };
}

function normalizeLiteral(value: unknown, label: string): SourceSymbol["props"][number]["literal"] {
  assertPlainObject(value, label);
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    const record = value as Record<string, unknown>;
    if (typeof record.value !== kind) throw new CodeIrValidationError(`${label} value type mismatch`);
    return { kind, value: record.value } as SourceSymbol["props"][number]["literal"];
  }
  throw new CodeIrValidationError(`${label}.kind is unsupported`);
}

export function normalizeSymbol(value: unknown, label: string): SourceSymbol {
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["id", "kind", "name", "range", "props", "children", "texts", "classTokens"], label);
  assertBoundedString(value.id, `${label}.id`, 256);
  if (!["component", "element", "style-rule", "token"].includes(value.kind as string)) {
    throw new CodeIrValidationError(`${label}.kind is unsupported`);
  }
  assertBoundedString(value.name, `${label}.name`, 256);
  const range = normalizeRange(value.range, `${label}.range`);
  if (!Array.isArray(value.props) || value.props.length > CODE_IR_HARD_LIMITS.maxPropsPerSymbol) {
    throw new CodeIrValidationError(`${label}.props exceeds its bounded budget`);
  }
  const props = (value.props as unknown[]).map((prop, index) => {
    assertPlainObject(prop, `${label}.props[${index}]`);
    assertAllowedKeys(prop, ["name", "literal", "range"], `${label}.props[${index}]`);
    assertBoundedString(prop.name, `${label}.props[${index}].name`, 256);
    return { name: prop.name as string, literal: normalizeLiteral(prop.literal, `${label}.props[${index}].literal`), range: normalizeRange(prop.range, `${label}.props[${index}].range`) };
  });
  if (!Array.isArray(value.children) || value.children.length > CODE_IR_HARD_LIMITS.maxChildrenPerSymbol) {
    throw new CodeIrValidationError(`${label}.children exceeds its bounded budget`);
  }
  for (const child of value.children) assertBoundedString(child, `${label}.child`, 256);
  if (!Array.isArray(value.texts)) throw new CodeIrValidationError(`${label}.texts must be an array`);
  if (value.texts.length > CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol) {
    throw new CodeIrValidationError(`${label}.texts exceeds its bounded budget`);
  }
  const texts = (value.texts as unknown[]).map((entry, index) => {
    assertPlainObject(entry, `${label}.texts[${index}]`);
    assertAllowedKeys(entry, ["value", "range"], `${label}.texts[${index}]`);
    if (typeof entry.value !== "string" || (entry.value as string).length > 4096) {
      throw new CodeIrValidationError(`${label}.texts[${index}].value must be a bounded string`);
    }
    return { value: entry.value as string, range: normalizeRange(entry.range, `${label}.texts[${index}].range`) };
  });
  let classTokens: string[] | undefined;
  if (value.classTokens !== undefined) {
    if (!Array.isArray(value.classTokens)) throw new CodeIrValidationError(`${label}.classTokens must be an array`);
    for (const token of value.classTokens) assertBoundedString(token, `${label}.classToken`, 256);
    classTokens = [...value.classTokens as string[]];
  }
  return {
    id: value.id as string,
    kind: value.kind as SourceSymbol["kind"],
    name: value.name as string,
    range,
    props,
    children: [...value.children as string[]],
    texts,
    ...(classTokens === undefined ? {} : { classTokens }),
  };
}

export function normalizeCodeIr(value: unknown): CodeIr {
  assertPlainObject(value, "code.ir");
  assertAllowedKeys(value, ["schemaVersion", "symbols", "rootIds", "relations", "unsupported"], "code.ir");
  if (value.schemaVersion !== CODE_IR_SCHEMA_VERSION) {
    throw new CodeIrValidationError("unsupported code IR schema version");
  }
  assertPlainObject(value.symbols, "code.ir.symbols");
  const entries = Object.entries(value.symbols);
  if (entries.length > CODE_IR_HARD_LIMITS.maxSymbols) {
    throw new CodeIrValidationError("code.ir.symbols exceeds its bounded budget");
  }
  const symbols: Record<string, SourceSymbol> = Object.create(null);
  for (const [id, symbol] of entries) {
    const normalized = normalizeSymbol(symbol, `code.ir.symbols.${id}`);
    if (normalized.id !== id) throw new CodeIrValidationError(`code symbol key ${id} does not match symbol.id`);
    symbols[id] = normalized;
  }
  if (!Array.isArray(value.rootIds)) throw new CodeIrValidationError("code.ir.rootIds must be an array");
  for (const rootId of value.rootIds) {
    assertBoundedString(rootId, "code.ir.rootId", 256);
    if (!symbols[rootId as string]) throw new CodeIrValidationError(`code.ir root ${rootId} is missing`);
  }
  if (!Array.isArray(value.relations)) throw new CodeIrValidationError("code.ir.relations must be an array");
  const relations = (value.relations as unknown[]).map((relation, index): SymbolRelation => {
    assertPlainObject(relation, `code.ir.relations[${index}]`);
    assertAllowedKeys(relation, ["from", "to", "kind"], `code.ir.relations[${index}]`);
    assertBoundedString(relation.from, "relation.from", 256);
    assertBoundedString(relation.to, "relation.to", 256);
    if (!symbols[relation.from as string] || !symbols[relation.to as string]) {
      throw new CodeIrValidationError(`code relation ${index} references missing symbols`);
    }
    if (!["renders", "styles", "references"].includes(relation.kind as string)) {
      throw new CodeIrValidationError(`code relation ${index} kind is unsupported`);
    }
    return { from: relation.from as string, to: relation.to as string, kind: relation.kind as SymbolRelation["kind"] };
  });
  if (!Array.isArray(value.unsupported) || value.unsupported.length > CODE_IR_HARD_LIMITS.maxUnsupported) {
    throw new CodeIrValidationError("code.ir.unsupported exceeds its bounded budget");
  }
  const unsupported = (value.unsupported as unknown[]).map((entry, index): UnsupportedRegion => {
    assertPlainObject(entry, `code.ir.unsupported[${index}]`);
    assertAllowedKeys(entry, ["reason", "range"], `code.ir.unsupported[${index}]`);
    assertBoundedString(entry.reason, "unsupported.reason", 1024);
    return { reason: entry.reason as string, range: normalizeRange(entry.range, "unsupported.range") };
  });
  return {
    schemaVersion: CODE_IR_SCHEMA_VERSION,
    symbols,
    rootIds: [...value.rootIds as string[]],
    relations,
    unsupported,
  };
}

export function normalizePatchOp(value: unknown, index: number): PatchOp {
  const label = `code.patch[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["op", "targetSymbolId", "anchor", "replacement"], label);
  if (!["update-prop", "update-text", "insert-prop"].includes(value.op as string)) {
    throw new CodeIrValidationError(`${label}.op is unsupported`);
  }
  assertBoundedString(value.targetSymbolId, `${label}.targetSymbolId`, 256);
  assertPlainObject(value.anchor, `${label}.anchor`);
  assertAllowedKeys(value.anchor as Record<string, unknown>, ["range", "expectedText"], `${label}.anchor`);
  const anchor = value.anchor as Record<string, unknown>;
  if (typeof anchor.expectedText !== "string" || anchor.expectedText.length > 8192) {
    throw new CodeIrValidationError(`${label}.anchor.expectedText must be a bounded string`);
  }
  if (typeof value.replacement !== "string" || value.replacement.length > 8192) {
    throw new CodeIrValidationError(`${label}.replacement must be a bounded string`);
  }
  return {
    op: value.op as PatchOp["op"],
    targetSymbolId: value.targetSymbolId as string,
    anchor: { range: normalizeRange(anchor.range, `${label}.anchor.range`), expectedText: anchor.expectedText as string },
    replacement: value.replacement as string,
  };
}

export function normalizeMergeConflict(value: unknown, index: number): MergeConflict {
  const label = `code.merge.conflicts[${index}]`;
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["startLine", "endLineBase", "reason"], label);
  for (const field of ["startLine", "endLineBase"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) {
      throw new CodeIrValidationError(`${label}.${field} must be a positive safe integer`);
    }
  }
  assertBoundedString(value.reason, `${label}.reason`, 1024);
  return { startLine: value.startLine as number, endLineBase: value.endLineBase as number, reason: value.reason as string };
}

function normalizeDesignNode(value: unknown, label: string, depth: number): DesignDocNode {
  if (depth > CODE_IR_HARD_LIMITS.maxDepth) throw new CodeIrValidationError("design document exceeds maxDepth");
  assertPlainObject(value, label);
  assertAllowedKeys(value, ["tag", "props", "text", "children"], label);
  assertBoundedString(value.tag, `${label}.tag`, 128);
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(value.tag as string)) {
    throw new CodeIrValidationError(`${label}.tag must be a plain element name`);
  }
  assertPlainObject(value.props, `${label}.props`);
  const props: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value.props)) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(key)) throw new CodeIrValidationError(`${label}.props has an unsupported key`);
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new CodeIrValidationError(`${label}.props values must be literals`);
    }
    if (typeof entry === "string" && !entry.isWellFormed()) throw new CodeIrValidationError(`${label}.props.${key} contains a lone surrogate`);
    // -0 and 0 are the same design; JSX writes both as 0.
    props[key] = typeof entry === "number" && Object.is(entry, -0) ? 0 : entry;
  }
  const node: DesignDocNode = { tag: value.tag as string, props };
  if (value.text !== undefined) {
    if (typeof value.text !== "string" || value.text.length > 4096) {
      throw new CodeIrValidationError(`${label}.text must be a bounded string`);
    }
    if (!value.text.isWellFormed()) throw new CodeIrValidationError(`${label}.text contains a lone surrogate`);
    // Empty text and an empty child list are the same design as none; the normal form
    // omits them, so they fingerprint and round-trip identically.
    if (value.text !== "") node.text = value.text as string;
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || value.children.length > CODE_IR_HARD_LIMITS.maxChildrenPerSymbol) {
      throw new CodeIrValidationError(`${label}.children exceeds its bounded budget`);
    }
    const children = (value.children as unknown[]).map((child, index) => normalizeDesignNode(child, `${label}.children[${index}]`, depth + 1));
    if (children.length > 0) node.children = children;
  }
  return node;
}

export function normalizeDesignDoc(value: unknown): DesignDoc {
  assertPlainObject(value, "design.doc");
  assertAllowedKeys(value, ["componentName", "root"], "design.doc");
  assertBoundedString(value.componentName, "design.doc.componentName", 128);
  if (!/^[A-Z][A-Za-z0-9]*$/u.test(value.componentName as string)) {
    throw new CodeIrValidationError("design.doc.componentName must be a capitalized identifier");
  }
  return { componentName: value.componentName as string, root: normalizeDesignNode(value.root, "design.doc.root", 0) };
}

export type { PatchAnchor };
