import { parse } from "@babel/parser";
import { CodeIrValidationError } from "./errors.ts";
import { CODE_IR_HARD_LIMITS, type PropLiteral, type SourceSymbol, type SymbolProp, type SymbolText, type UnsupportedRegion } from "./types.ts";
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

// JSX text and attribute strings carry HTML entities, not JS escapes. The entities Ninerr
// emits, and numeric references, are decoded; any other named entity is refused, because
// JSX would decode it to a character this parser cannot know.
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" });

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
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new CodeIrValidationError(`${label} uses the unsupported entity &${body};`);
    return named;
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
  // A loop, not recursion: a chain such as a.a.a… is as long as the source allows.
  const parts: string[] = [];
  let current = name;
  while (current.type === "JSXMemberExpression") {
    parts.push(current.property.name);
    current = current.object;
  }
  if (current.type !== "JSXIdentifier") return null;
  parts.push(current.name);
  return parts.reverse().join(".");
}

// The longest tag name a symbol keeps (normalizeSymbol's bound for names).
const MAX_TAG_NAME = 256;

function elementSymbol(state: ParserState, node: AstNode, depth: number): SourceSymbol {
  if (depth > CODE_IR_HARD_LIMITS.maxDepth) {
    throw new CodeIrValidationError("JSX nesting exceeds maxDepth");
  }
  if (node.type === "JSXFragment") {
    unsupportedAt(state, "JSX fragments are outside the supported subset", node.start, node.openingFragment.end);
    throw new CodeIrValidationError("JSX fragments are outside the supported subset");
  }
  const { source } = state;
  const opening: AstNode = node.openingElement;
  const name = tagName(opening.name);
  if (name === null) {
    unsupportedAt(state, "non-identifier JSX tag", node.start, opening.name.end);
    throw new CodeIrValidationError("JSX tag name must be an identifier");
  }
  if (name.length > MAX_TAG_NAME) {
    unsupportedAt(state, `JSX tag name longer than ${MAX_TAG_NAME} characters`, node.start, opening.name.end);
    throw new CodeIrValidationError(`JSX tag name is longer than ${MAX_TAG_NAME} characters`);
  }
  const props: SymbolProp[] = [];
  const texts: SymbolText[] = [];
  const children: SourceSymbol[] = [];
  for (const attribute of opening.attributes as AstNode[]) {
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") {
      unsupportedAt(state, `unsupported JSX attribute form in ${name}`, attribute.start, attribute.end);
      throw new CodeIrValidationError(`JSX element ${name} has an unsupported attribute form`);
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
    if (value.type !== "JSXExpressionContainer") {
      unsupportedAt(state, `unsupported JSX attribute value in ${name}`, value.start, value.end);
      throw new CodeIrValidationError(`JSX element ${name} has an unsupported attribute value`);
    }
    const literal = readLiteral(state, value);
    if (literal === null) {
      unsupportedAt(state, `non-literal JSX expression attribute in ${name}`, value.start, value.end);
      throw new CodeIrValidationError(`JSX element ${name} uses a non-literal expression attribute`);
    }
    props.push({ name: attrName, literal, range: makeRange(state.file, source, state.starts, attribute.start, value.end) });
  }

  for (const child of node.children as AstNode[]) {
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
      if (literal !== null) {
        unsupportedAt(state, `non-string literal child in ${name}`, child.start, child.end);
        throw new CodeIrValidationError(`JSX element ${name} contains a non-string literal child`);
      }
      unsupportedAt(state, `expression child in ${name}`, child.start, child.end);
      throw new CodeIrValidationError(`JSX element ${name} contains an expression child outside the supported subset`);
    }
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      children.push(elementSymbol(state, child, depth + 1));
      continue;
    }
    unsupportedAt(state, `unsupported JSX child in ${name}`, child.start, child.end);
    throw new CodeIrValidationError(`JSX element ${name} contains an unsupported child`);
  }

  if (props.length > CODE_IR_HARD_LIMITS.maxPropsPerSymbol) {
    throw new CodeIrValidationError(`JSX element ${name} exceeds maxPropsPerSymbol`);
  }
  if (new Set(props.map((prop) => prop.name)).size !== props.length) {
    throw new CodeIrValidationError(`JSX element ${name} declares duplicate props`);
  }
  if (children.length > CODE_IR_HARD_LIMITS.maxChildrenPerSymbol) {
    throw new CodeIrValidationError(`JSX element ${name} exceeds maxChildrenPerSymbol`);
  }
  if (texts.length > CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol) {
    throw new CodeIrValidationError(`JSX element ${name} has more than ${CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol} runs of text`);
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
/** The function a call names: memo for memo(…) and React.memo(…); null for anything else. */
function calleeName(callee: AstNode): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") return callee.property.name;
  return null;
}
function componentFunction(init: AstNode | null): AstNode | null {
  let current = unwrap(init);
  for (let depth = 0; current !== null && current.type === "CallExpression" && depth < 4; depth += 1) {
    const name = calleeName(current.callee);
    if (name === null || !WRAPPERS.has(name) || current.arguments.length === 0) return null;
    current = unwrap(current.arguments[0]);
  }
  return current !== null && (current.type === "ArrowFunctionExpression" || current.type === "FunctionExpression") ? current : null;
}

/**
 * The element a component function returns: an arrow's body, or its body's last top-level
 * return, when that is an element (not, say, `<div /> || null`, which starts with one).
 */
function returnedJsx(fn: AstNode): AstNode | null {
  let returned: AstNode | null;
  if (fn.body.type !== "BlockStatement") returned = unwrap(fn.body);
  else {
    const returns = (fn.body.body as AstNode[]).filter((statement) => statement.type === "ReturnStatement");
    returned = returns.length === 0 ? null : unwrap(returns.at(-1)!.argument);
  }
  return returned !== null && (returned.type === "JSXElement" || returned.type === "JSXFragment") ? returned : null;
}

/** The program's top-level function components, each with the JSX it returns. */
function componentDefinitions(program: AstNode): Array<{ name: string; jsx: AstNode | null }> {
  const definitions: Array<{ name: string; jsx: AstNode | null }> = [];
  const visit = (statement: AstNode | null) => {
    if (statement === null) return;
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration.type !== "FunctionDeclaration") {
      // export default memo(function Card() {…}): the wrapped function's own name.
      const fn = componentFunction(statement.declaration);
      if (fn?.id && /^[A-Z]/u.test(fn.id.name)) definitions.push({ name: fn.id.name, jsx: returnedJsx(fn) });
      return;
    }
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") return visit(statement.declaration);
    if (statement.type === "FunctionDeclaration" && statement.id && /^[A-Z]/u.test(statement.id.name)) {
      definitions.push({ name: statement.id.name, jsx: returnedJsx(statement) });
      return;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations as AstNode[]) {
        if (declarator.id.type !== "Identifier" || !/^[A-Z]/u.test(declarator.id.name)) continue;
        const fn = componentFunction(declarator.init);
        if (fn !== null) definitions.push({ name: declarator.id.name, jsx: returnedJsx(fn) });
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

export function parseJsxFile(file: string, source: string): JsxParseResult {
  if (typeof source !== "string") throw new CodeIrValidationError("JSX source must be a string");
  if (source.length === 0) throw new CodeIrValidationError("JSX source must not be empty");
  if (source.length > CODE_IR_HARD_LIMITS.maxSourceBytes) {
    throw new CodeIrValidationError("JSX source exceeds maxSourceBytes");
  }
  let program: AstNode;
  try {
    program = parse(source, { sourceType: "module", plugins: grammar(file), errorRecovery: false }).program as unknown as AstNode;
  } catch (error) {
    // Babel recurses: nesting deep enough to exhaust the stack is refused like any other.
    if (error instanceof RangeError) throw new CodeIrValidationError("JSX nesting exceeds maxDepth");
    throw new CodeIrValidationError(`the code could not be parsed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }
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
