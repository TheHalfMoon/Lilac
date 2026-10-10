import { parse } from "@babel/parser";
import { CodeIrValidationError } from "./errors.ts";
import { CODE_DISPLAY_LENGTH, CODE_IR_HARD_LIMITS, type CodeProp, type PropLiteral, type SourceSymbol, type SymbolProp, type SymbolText, type UnsupportedRegion } from "./types.ts";
import { makeRange, symbolId } from "./validation.ts";

// JSX and TSX are read with @babel/parser (P08-G11, #230): the syntax comes from a real
// parser, so a type argument (useState<string>), a comparison (a < b) or a "<" in a string
// or comment is never taken for an element. What Ninerr makes of the syntax is its own: the
// supported subset, every value (decoded from the source text exactly as before), the ranges
// a write-back patches, and the refusals, which become unsupported regions with reasons.

export interface JsxParseResult {
  symbols: SourceSymbol[];
  rootIds: string[];
  relations: { from: string; to: string; kind: "renders" }[];
  unsupported: UnsupportedRegion[];
}

interface ParserState {
  file: string;
  source: string;
  starts: number[];
  symbols: SourceSymbol[];
  relations: { from: string; to: string; kind: "renders" }[];
  unsupported: UnsupportedRegion[];
}

// A Babel syntax node, as far as this module reads it.
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

function unsupportedAt(state: ParserState, reason: string, start: number, end: number): void {
  if (state.unsupported.length >= CODE_IR_HARD_LIMITS.maxUnsupported) {
    throw new CodeIrValidationError("JSX unsupported regions exceed the bounded budget");
  }
  state.unsupported.push({
    reason,
    range: makeRange(state.file, state.source, state.starts, start, end),
  });
}

// JSX text and attribute strings carry HTML entities, not JS escapes. A named entity is
// decoded as JSX decodes it: the entities Ninerr emits from this table, any other from the
// parser (the XHTML entities, &larr; is "←"), and a name JSX does not know stays as written
// (&foo; is the text "&foo;"). Names are looked up as own keys: &constructor; was once
// Object's constructor function (P08-G11).
const NAMED_ENTITIES = new Map(Object.entries({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" }));
const PARSED_ENTITIES = new Map<string, string>();
function namedEntity(name: string): string {
  const known = NAMED_ENTITIES.get(name) ?? PARSED_ENTITIES.get(name);
  if (known !== undefined) return known;
  // The name is [A-Za-z][A-Za-z0-9]{0,31}, so this is one element with one text child.
  const element = (parse(`<x>&${name};</x>`, { plugins: ["jsx"] }).program.body[0] as unknown as AstNode).expression;
  const text: string = element.children[0].value;
  if (PARSED_ENTITIES.size < 512) PARSED_ENTITIES.set(name, text);
  return text;
}

// Numeric references take any number of digits and a lowercase x, as in Babel and
// TypeScript; any other "&#" is refused rather than guessed.
function decodeJsxEntities(raw: string, label: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{0,31});|&#/gu, (match, body: string | undefined) => {
    if (body === undefined) throw new CodeIrValidationError(`${label} has a malformed character reference`);
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) throw new CodeIrValidationError(`${label} has an invalid character reference &${body};`);
      return String.fromCodePoint(code);
    }
    return namedEntity(body);
  });
}

// Raw text (indentation included) is bounded before it is decoded or trimmed.
const MAX_RAW_TEXT = 65_536;

// JSX whitespace (Babel's cleanJSXElementLiteralChild): tabs become spaces, lines after the
// first lose leading spaces, lines before the last lose trailing spaces, empty lines drop,
// and the remaining lines join with one space.
function cleanJsxText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/u);
  let lastNonEmpty = 0;
  lines.forEach((line, index) => { if (/[^ \t]/u.test(line)) lastNonEmpty = index; });
  let out = "";
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/gu, " ");
    // Index scans, not regexes: /[ ]+$/ backtracks quadratically on long space runs.
    if (index !== 0) {
      let start = 0;
      while (trimmed[start] === " ") start += 1;
      trimmed = trimmed.slice(start);
    }
    if (index !== lines.length - 1) {
      let end = trimmed.length;
      while (end > 0 && trimmed[end - 1] === " ") end -= 1;
      trimmed = trimmed.slice(0, end);
    }
    if (trimmed === "") return;
    out += index === lastNonEmpty ? trimmed : `${trimmed} `;
  });
  return out;
}

// A JSX attribute string: no escapes, ends at the matching quote, entities decoded.
function scanStringLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") throw new CodeIrValidationError("JSX attribute value must be a string or literal expression");
  const end = source.indexOf(quote, start + 1);
  if (end < 0) throw new CodeIrValidationError("JSX string literal is unterminated");
  const raw = source.slice(start + 1, end);
  if (/[\r\n]/u.test(raw)) throw new CodeIrValidationError("JSX string literal must not span lines");
  return { value: decodeJsxEntities(raw, "JSX attribute string"), end: end + 1 };
}

// A single- or double-quoted JS string literal inside an expression container.
function scanJsStringLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let out = "";
  let index = start + 1;
  const hex = (text: string, label: string): number => {
    if (!/^[0-9a-fA-F]+$/u.test(text)) throw new CodeIrValidationError(`JSX string literal has a malformed ${label} escape`);
    return Number.parseInt(text, 16);
  };
  while (index < source.length && source[index] !== quote) {
    const char = source[index];
    if (char === "\n" || char === "\r") throw new CodeIrValidationError("JSX string literal must not span lines");
    if (char !== "\\") { out += char; index += 1; continue; }
    const escaped = source[index + 1];
    index += 2;
    if (escaped === undefined || escaped === "\n" || escaped === "\r" || escaped === "\u2028" || escaped === "\u2029") {
      throw new CodeIrValidationError("JSX string literal line continuations are outside the supported subset");
    }
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
    if (escaped in simple) { out += simple[escaped]; continue; }
    if (escaped === "0" && !/[0-9]/u.test(source[index] ?? "")) { out += "\0"; continue; }
    if (/[0-9]/u.test(escaped)) throw new CodeIrValidationError("JSX string literal octal escapes are outside the supported subset");
    if (escaped === "x") { out += String.fromCharCode(hex(source.slice(index, index + 2), "\\x")); index += 2; continue; }
    if (escaped === "u" && source[index] === "{") {
      const close = source.indexOf("}", index);
      const code = close < 0 ? Number.NaN : hex(source.slice(index + 1, close), "\\u{}");
      if (!(code <= 0x10ffff)) throw new CodeIrValidationError("JSX string literal has a malformed \\u{} escape");
      out += String.fromCodePoint(code);
      index = close + 1;
      continue;
    }
    if (escaped === "u") { out += String.fromCharCode(hex(source.slice(index, index + 4), "\\u")); index += 4; continue; }
    out += escaped;
  }
  if (index >= source.length) throw new CodeIrValidationError("JSX string literal is unterminated");
  // A lone surrogate cannot be saved as UTF-8 and would come back as U+FFFD.
  if (!out.isWellFormed()) throw new CodeIrValidationError("JSX string literal contains a lone surrogate");
  return { value: out, end: index + 1 };
}

// No leading zeros: JS reads 010 as octal or refuses it.
const NUMERIC_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/u;

// TypeScript-only wrappers around an expression: (x), x as T, x satisfies T, x!.
function unwrap(node: AstNode | null | undefined): AstNode | null {
  let current = node ?? null;
  while (current !== null && (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "TSNonNullExpression" || current.type === "ParenthesizedExpression")) current = current.expression;
  return current;
}

// The literal in an expression container: true, false, a number or a quoted string, and
// nothing else inside the braces (no comment, no other code). Null for anything else.
function readLiteral(state: ParserState, container: AstNode): PropLiteral | null {
  const { source } = state;
  const expression: AstNode = container.expression;
  if (expression.type === "JSXEmptyExpression") return null;
  const raw = source.slice(expression.start, expression.end);
  // Only the literal between the braces: a comment beside it would be lost by a write-back.
  if (source.slice(container.start + 1, container.end - 1).trim() !== raw) return null;
  if (expression.type === "StringLiteral") {
    const scanned = scanJsStringLiteral(source, expression.start);
    if (scanned.end !== expression.end) return null;
    return { kind: "string", value: scanned.value };
  }
  if (expression.type === "BooleanLiteral") return { kind: "boolean", value: raw === "true" };
  if (expression.type === "NumericLiteral" || (expression.type === "UnaryExpression" && expression.operator === "-" && expression.argument?.type === "NumericLiteral")) {
    if (!NUMERIC_LITERAL.test(raw)) return null;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) throw new CodeIrValidationError("JSX numeric literal must be finite");
    return { kind: "number", value: numeric };
  }
  return null;
}

/** A JSX tag's name: an identifier, or a member expression such as Item.Skeleton. */
function tagName(name: AstNode): string | null {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    const object = tagName(name.object);
    return object === null ? null : `${object}.${name.property.name}`;
  }
  return null;
}

/** Source text shortened for display: whitespace collapsed, at most CODE_DISPLAY_LENGTH characters. */
function display(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= CODE_DISPLAY_LENGTH) return flat;
  let cut = flat.slice(0, CODE_DISPLAY_LENGTH - 1);
  // Never end on half of a surrogate pair.
  if (/[\ud800-\udbff]$/u.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A {…} child that is code: kept whole, with its range, never read into or patched. */
function expressionSymbol(state: ParserState, child: AstNode): SourceSymbol {
  const inner = child.type === "JSXSpreadChild" ? `...${state.source.slice(child.expression.start, child.expression.end)}` : state.source.slice(child.expression.start, child.expression.end);
  const symbol: SourceSymbol = {
    id: symbolId(state.file, "expression", "#expression", child.start),
    kind: "expression",
    name: "#expression",
    range: makeRange(state.file, state.source, state.starts, child.start, child.end),
    props: [],
    children: [],
    texts: [],
    code: display(inner),
  };
  state.symbols.push(symbol);
  return symbol;
}

/** The text runs and child symbols of an element's or a fragment's children, in order. */
function readChildren(state: ParserState, nodes: AstNode[], name: string, depth: number): { texts: SymbolText[]; children: SourceSymbol[] } {
  const { source } = state;
  const texts: SymbolText[] = [];
  const children: SourceSymbol[] = [];
  for (const child of nodes) {
    if (child.type === "JSXText") {
      if (child.end - child.start > MAX_RAW_TEXT) throw new CodeIrValidationError(`JSX text in ${name} exceeds ${MAX_RAW_TEXT} source characters`);
      const value = cleanJsxText(decodeJsxEntities(source.slice(child.start, child.end), `JSX text in ${name}`));
      if (value === "") continue;
      if (value.length > 4096) throw new CodeIrValidationError(`JSX text in ${name} exceeds 4096 characters`);
      texts.push({ value, range: makeRange(state.file, source, state.starts, child.start, child.end) });
      continue;
    }
    if (child.type === "JSXExpressionContainer") {
      // A comment, {/* … */}, is no content.
      if (child.expression.type === "JSXEmptyExpression") continue;
      // A string literal child is exact text: {"  spaced  "} keeps its whitespace.
      const literal = readLiteral(state, child);
      if (literal !== null && literal.kind === "string") {
        if (literal.value.length > 4096) throw new CodeIrValidationError(`JSX text in ${name} exceeds 4096 characters`);
        if (literal.value !== "") texts.push({ value: literal.value, range: makeRange(state.file, source, state.starts, child.start, child.end) });
        continue;
      }
      children.push(expressionSymbol(state, child));
      continue;
    }
    if (child.type === "JSXSpreadChild") {
      children.push(expressionSymbol(state, child));
      continue;
    }
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      children.push(elementSymbol(state, child, depth + 1));
      continue;
    }
    unsupportedAt(state, `unsupported JSX child in ${name}`, child.start, child.end);
    throw new CodeIrValidationError(`JSX element ${name} contains an unsupported child`);
  }
  if (children.length > CODE_IR_HARD_LIMITS.maxChildrenPerSymbol) {
    throw new CodeIrValidationError(`JSX element ${name} exceeds maxChildrenPerSymbol`);
  }
  if (texts.length > CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol) {
    throw new CodeIrValidationError(`JSX element ${name} has more than ${CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol} runs of text`);
  }
  return { texts, children };
}

function elementSymbol(state: ParserState, node: AstNode, depth: number): SourceSymbol {
  if (depth > CODE_IR_HARD_LIMITS.maxDepth) {
    throw new CodeIrValidationError("JSX nesting exceeds maxDepth");
  }
  const { source } = state;
  if (node.type === "JSXFragment") {
    // <>…</>: no tag and no attributes, only its children.
    const { texts, children } = readChildren(state, node.children, "fragment", depth);
    const fragment: SourceSymbol = {
      id: symbolId(state.file, "fragment", "#fragment", node.start),
      kind: "fragment",
      name: "#fragment",
      range: makeRange(state.file, source, state.starts, node.start, node.end),
      props: [],
      children: children.map((child) => child.id),
      texts,
    };
    state.symbols.push(fragment);
    for (const child of children) state.relations.push({ from: fragment.id, to: child.id, kind: "renders" });
    return fragment;
  }
  const opening: AstNode = node.openingElement;
  const name = tagName(opening.name);
  if (name === null) {
    unsupportedAt(state, "non-identifier JSX tag", node.start, opening.name.end);
    throw new CodeIrValidationError("JSX tag name must be an identifier");
  }
  const props: SymbolProp[] = [];
  const codeProps: CodeProp[] = [];
  const asCode = (attribute: AstNode, attrName: string) => {
    codeProps.push({ name: attrName, code: display(source.slice(attribute.start, attribute.end)), range: makeRange(state.file, source, state.starts, attribute.start, attribute.end) });
  };
  for (const attribute of opening.attributes as AstNode[]) {
    if (attribute.type === "JSXSpreadAttribute") {
      asCode(attribute, "...");
      continue;
    }
    // A namespaced name (xlink:href) is kept as code, by its full name.
    if (attribute.name.type !== "JSXIdentifier") {
      asCode(attribute, `${attribute.name.namespace.name}:${attribute.name.name.name}`);
      continue;
    }
    const attrName: string = attribute.name.name;
    const value: AstNode | null = attribute.value;
    if (value === null) {
      props.push({ name: attrName, literal: { kind: "boolean", value: true }, range: makeRange(state.file, source, state.starts, attribute.name.start, attribute.name.end) });
      continue;
    }
    if (value.type === "StringLiteral") {
      const scanned = scanStringLiteral(source, value.start);
      props.push({ name: attrName, literal: { kind: "string", value: scanned.value }, range: makeRange(state.file, source, state.starts, attribute.start, scanned.end) });
      continue;
    }
    const literal = value.type === "JSXExpressionContainer" ? readLiteral(state, value) : null;
    if (literal === null) {
      asCode(attribute, attrName);
      continue;
    }
    props.push({ name: attrName, literal, range: makeRange(state.file, source, state.starts, attribute.start, value.end) });
  }
  const { texts, children } = node.closingElement === null ? { texts: [], children: [] } : readChildren(state, node.children, name, depth);

  if (props.length + codeProps.length > CODE_IR_HARD_LIMITS.maxPropsPerSymbol) {
    throw new CodeIrValidationError(`JSX element ${name} exceeds maxPropsPerSymbol`);
  }
  const names = [...props.map((prop) => prop.name), ...codeProps.filter((prop) => prop.name !== "...").map((prop) => prop.name)];
  if (new Set(names).size !== names.length) {
    throw new CodeIrValidationError(`JSX element ${name} declares duplicate props`);
  }
  const kind = /^[A-Z]/u.test(name) ? "component" : "element";
  const id = symbolId(state.file, kind, name, node.start);
  const symbol: SourceSymbol = {
    id,
    kind,
    name,
    range: makeRange(state.file, source, state.starts, node.start, node.end),
    props,
    children: children.map((child) => child.id),
    texts,
    ...(codeProps.length === 0 ? {} : { codeProps }),
  };
  const classProp = props.find((prop) => prop.name === "className" && prop.literal.kind === "string");
  if (classProp && classProp.literal.kind === "string") {
    symbol.classTokens = classProp.literal.value.split(/\s+/u).filter((entry) => entry !== "");
  }
  // Each child pushed itself when it was converted (#250: never twice).
  state.symbols.push(symbol);
  for (const child of children) state.relations.push({ from: id, to: child.id, kind: "renders" });
  return symbol;
}

// Keys of a Babel node that are not syntax.
const NOT_SYNTAX = new Set(["type", "start", "end", "loc", "range", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "errors"]);

/** Every outermost JSX element or fragment of the program, in source order. */
function outermostJsx(program: AstNode): AstNode[] {
  const found: AstNode[] = [];
  // Iterative, so a deeply nested expression cannot overflow the stack.
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    if (value === null || typeof value !== "object" || typeof (value as AstNode).type !== "string") continue;
    const node = value as AstNode;
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      found.push(node);
      continue;
    }
    for (const key of Object.keys(node)) if (!NOT_SYNTAX.has(key)) stack.push(node[key]);
  }
  return found.sort((a, b) => a.start - b.start);
}

// React's wrappers that take a component function: forwardRef(fn), memo(fn), React.memo(fn).
const WRAPPERS = new Set(["forwardRef", "memo"]);
function componentFunction(init: AstNode | null): AstNode | null {
  let current = unwrap(init);
  for (let depth = 0; current !== null && current.type === "CallExpression" && depth < 4; depth += 1) {
    const callee = current.callee;
    const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : null;
    if (name === null || !WRAPPERS.has(name) || current.arguments.length === 0) return null;
    current = unwrap(current.arguments[0]);
  }
  return current !== null && (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") ? current : null;
}

/** The JSX a component function returns: an arrow's body, or its body's last top-level return. */
function returnedJsx(fn: AstNode): AstNode | null {
  if (fn.body.type !== "BlockStatement") return unwrap(fn.body);
  const returns = (fn.body.body as AstNode[]).filter((statement) => statement.type === "ReturnStatement");
  return returns.length === 0 ? null : unwrap(returns.at(-1)!.argument);
}

/** The program's top-level function components, each with the JSX it returns. */
function componentDefinitions(program: AstNode): Array<{ name: string; jsx: AstNode | null; fn: AstNode }> {
  const definitions: Array<{ name: string; jsx: AstNode | null; fn: AstNode }> = [];
  const visit = (statement: AstNode | null) => {
    if (statement === null) return;
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") return visit(statement.declaration);
    if (statement.type === "FunctionDeclaration" && statement.id && /^[A-Z]/u.test(statement.id.name)) {
      definitions.push({ name: statement.id.name, jsx: returnedJsx(statement), fn: statement });
      return;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations as AstNode[]) {
        if (declarator.id.type !== "Identifier" || !/^[A-Z]/u.test(declarator.id.name)) continue;
        const fn = componentFunction(declarator.init);
        if (fn !== null) definitions.push({ name: declarator.id.name, jsx: returnedJsx(fn), fn });
      }
    }
  };
  for (const statement of program.body as AstNode[]) visit(statement);
  return definitions;
}

/** Babel's grammar for the file: TSX, TypeScript (no JSX) or JSX. */
function grammar(file: string): Array<"jsx" | "typescript"> {
  if (file.endsWith(".tsx")) return ["jsx", "typescript"];
  if (file.endsWith(".ts")) return ["typescript"];
  return ["jsx"];
}

/** The file's program, or a refusal: not a string, empty, too large, or not JavaScript. */
function parseProgram(file: string, source: string): AstNode {
  if (typeof source !== "string") throw new CodeIrValidationError("JSX source must be a string");
  if (source.length === 0) throw new CodeIrValidationError("JSX source must not be empty");
  if (source.length > CODE_IR_HARD_LIMITS.maxSourceBytes) {
    throw new CodeIrValidationError("JSX source exceeds maxSourceBytes");
  }
  try {
    return parse(source, { sourceType: "module", plugins: grammar(file), errorRecovery: false }).program as unknown as AstNode;
  } catch (error) {
    // Babel recurses: nesting deep enough to exhaust the stack is refused like any other.
    if (error instanceof RangeError) throw new CodeIrValidationError("JSX nesting exceeds maxDepth");
    throw new CodeIrValidationError(`the code could not be parsed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }
}

/**
 * The function components a file exports, by the names they are defined with, in source
 * order (P08-G11, #282): export function X, export default function X, export const X =
 * (…) =>, forwardRef(…) and memo(…), and a component exported by export { X },
 * export { X as Y } or export default X, each with JSX in it. A re-export from another file
 * is that file's.
 * Refuses, as parseJsxFile does, a file that cannot be parsed.
 */
export function exportedComponents(file: string, source: string): string[] {
  const program = parseProgram(file, source);
  const exported = new Set<string>();
  for (const statement of program.body as AstNode[]) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      if (declaration?.type === "FunctionDeclaration" && declaration.id) exported.add(declaration.id.name);
      if (declaration?.type === "VariableDeclaration") for (const declarator of declaration.declarations as AstNode[]) if (declarator.id.type === "Identifier") exported.add(declarator.id.name);
      if (declaration === null && statement.source === null) for (const specifier of statement.specifiers as AstNode[]) if (specifier.local?.type === "Identifier") exported.add(specifier.local.name);
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (declaration.type === "FunctionDeclaration" && declaration.id) exported.add(declaration.id.name);
      if (declaration.type === "Identifier") exported.add(declaration.name);
    }
  }
  // A component has JSX: export function Card() {} in a .js helper is not one.
  const names = componentDefinitions(program).filter((definition) => exported.has(definition.name) && outermostJsx(definition.fn).length > 0).map((definition) => definition.name);
  return [...new Set(names)];
}

export function parseJsxFile(file: string, source: string): JsxParseResult {
  const program = parseProgram(file, source);
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  const state: ParserState = { file, source, starts, symbols: [], relations: [], unsupported: [] };
  const roots: SourceSymbol[] = [];
  const rootAt = new Map<number, SourceSymbol>();
  for (const node of outermostJsx(program)) {
    const symbolCount = state.symbols.length;
    const relationCount = state.relations.length;
    try {
      const root = elementSymbol(state, node, 0);
      roots.push(root);
      rootAt.set(node.start, root);
    } catch (error) {
      if (!(error instanceof CodeIrValidationError)) throw error;
      // A refused element is left out whole: none of its descendants becomes a root.
      state.symbols.length = symbolCount;
      state.relations.length = relationCount;
      if (state.unsupported.length >= CODE_IR_HARD_LIMITS.maxUnsupported) throw error;
      const header = node.type === "JSXElement" ? node.openingElement.end : node.openingFragment.end;
      unsupportedAt(state, `unparseable top-level JSX: ${error.message}`, node.start, header);
    }
    if (state.symbols.length > CODE_IR_HARD_LIMITS.maxSymbols) {
      throw new CodeIrValidationError("JSX symbols exceed maxSymbols");
    }
  }
  if (roots.length === 0) {
    const reason = state.unsupported.length > 0 ? `: ${state.unsupported[0].reason}` : "";
    throw new CodeIrValidationError(`JSX source contains no supported elements${reason}`);
  }
  // Each function component, bound to the element it returns: the component symbol anchors at
  // that element's range with its literal props copied.
  for (const { name, jsx } of componentDefinitions(program)) {
    const root = jsx === null ? undefined : rootAt.get(jsx.start);
    if (root === undefined) continue;
    const id = symbolId(file, "component", name, root.range.startOffset);
    state.symbols.push({
      id,
      kind: "component",
      name,
      range: { ...root.range },
      props: root.props.map((prop) => ({ name: prop.name, literal: { ...prop.literal } as PropLiteral, range: { ...prop.range } })),
      children: [root.id],
      texts: [],
      ...(root.classTokens === undefined ? {} : { classTokens: [...root.classTokens] }),
      ...(root.codeProps === undefined ? {} : { codeProps: root.codeProps.map((prop) => ({ ...prop, range: { ...prop.range } })) }),
    });
    state.relations.push({ from: id, to: root.id, kind: "renders" });
    if (state.symbols.length > CODE_IR_HARD_LIMITS.maxSymbols) {
      throw new CodeIrValidationError("JSX symbols exceed maxSymbols");
    }
  }
  return {
    symbols: state.symbols,
    rootIds: roots.map((root) => root.id),
    relations: state.relations,
    unsupported: state.unsupported,
  };
}
