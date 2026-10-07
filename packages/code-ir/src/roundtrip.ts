import { CodeIrValidationError } from "./errors.ts";
import {
  type CodeIr,
  type DesignDoc,
  type DesignDocNode,
} from "./types.ts";
import { canonicalCodeIrStringify, normalizeCodeIr, normalizeDesignDoc, sha256Text } from "./validation.ts";

// Raw JSX text is entity-decoded and whitespace-trimmed by every JSX parser, so only text
// that survives both exactly is written raw (with & < > { } as entities). Anything else
// (edge spaces, tabs, line breaks) is written as a string literal child, which is exact.
function emitText(text: string): string {
  if (text !== "" && !/[\t\n\r]/u.test(text) && !text.startsWith(" ") && !text.endsWith(" ")) {
    return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/\{/gu, "&#123;").replace(/\}/gu, "&#125;");
  }
  return `{${JSON.stringify(text)}}`;
}

// JSX attribute strings have no escapes, so a value with a quote or an ampersand is written
// as a string literal expression instead.
function emitAttrValue(value: string): string {
  return /["&]/u.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

function emitNode(node: DesignDocNode, indent: string): string {
  for (const [key, value] of Object.entries(node.props)) {
    if (typeof value === "string" && /[\r\n]/u.test(value)) {
      throw new CodeIrValidationError(`design prop ${key} must not span lines`);
    }
  }
  const props = Object.entries(node.props)
    .map(([key, value]) => {
      if (typeof value === "boolean") return ` ${key}={${value ? "true" : "false"}}`;
      if (typeof value === "number") return ` ${key}={${String(value)}}`;
      return ` ${key}=${emitAttrValue(value)}`;
    })
    .join("");
  // One child per line: whitespace that touches a line break is not text in JSX.
  const children = (node.children ?? []).map((child) => `${emitNode(child, `${indent}  `)}\n`).join("");
  const text = node.text === undefined ? "" : emitText(node.text);
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
