import { CodeIrValidationError } from "./errors.ts";
import {
  type CodeIr,
  type DesignDoc,
  type DesignDocNode,
} from "./types.ts";
import { canonicalCodeIrStringify, normalizeCodeIr, normalizeDesignDoc, sha256Text } from "./validation.ts";

function escapeText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeAttr(value: string | number | boolean): string {
  return String(value).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}

function emitNode(node: DesignDocNode, indent: string): string {
  const props = Object.entries(node.props)
    .map(([key, value]) => {
      if (typeof value === "boolean") return ` ${key}={${value ? "true" : "false"}}`;
      if (typeof value === "number") return ` ${key}={${String(value)}}`;
      return ` ${key}="${escapeAttr(value)}"`;
    })
    .join("");
  const children = (node.children ?? []).map((child) => emitNode(child, `${indent}  `)).join("");
  const text = node.text === undefined ? "" : escapeText(node.text);
  if (children === "" && text === "") return `${indent}<${node.tag}${props} />`;
  return `${indent}<${node.tag}${props}>${text}${children === "" ? "" : `\n${children}${indent}`}</${node.tag}>`;
}

/**
 * Emit a subset function component from a design document. Output is
 * deterministic for identical input; only the documented subset is emitted.
 */
export function designToCode(docInput: DesignDoc): string {
  const doc = normalizeDesignDoc(docInput);
  const body = emitNode(doc.root, "    ");
  return `export function ${doc.componentName}() {\n  return (\n${body}\n  );\n}\n`;
}

function symbolToDesignNode(ir: CodeIr, symbolId: string, depth: number): DesignDocNode {
  if (depth > 32) throw new CodeIrValidationError("round-trip design exceeds maxDepth");
  const symbol = ir.symbols[symbolId];
  if (!symbol) throw new CodeIrValidationError(`round-trip symbol ${symbolId} is missing`);
  if (symbol.kind !== "element" && symbol.kind !== "component") {
    throw new CodeIrValidationError(`round-trip symbol ${symbolId} is not renderable`);
  }
  const props: Record<string, string | number | boolean> = {};
  for (const prop of symbol.props) {
    props[prop.name] = prop.literal.value;
  }
  const node: DesignDocNode = { tag: symbol.name, props };
  const texts = symbol.texts.map((entry) => entry.value).join("");
  if (texts !== "") node.text = texts;
  const children = symbol.children.map((child) => symbolToDesignNode(ir, child, depth + 1));
  if (children.length > 0) node.children = children;
  return node;
}

/**
 * Convert parsed code back to a design document. Symbols outside the
 * renderable subset raise unsupported errors instead of guessing.
 */
export function codeToDesign(irInput: CodeIr, rootSymbolId: string, componentName: string): DesignDoc {
  if (typeof rootSymbolId !== "string" || rootSymbolId === "") {
    throw new CodeIrValidationError("round-trip root symbol is required");
  }
  if (typeof componentName !== "string" || !/^[A-Z][A-Za-z0-9]*$/u.test(componentName)) {
    throw new CodeIrValidationError("round-trip component name must be a capitalized identifier");
  }
  const ir = normalizeCodeIr(irInput);
  const root = symbolToDesignNode(ir, rootSymbolId, 0);
  return normalizeDesignDoc({ componentName, root });
}

export function roundTripFingerprint(doc: DesignDoc): string {
  return sha256Text(canonicalCodeIrStringify(normalizeDesignDoc(doc)));
}
