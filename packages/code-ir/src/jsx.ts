import { CodeIrValidationError } from "./errors.ts";
import { CODE_IR_HARD_LIMITS, type SourceSymbol, type UnsupportedRegion } from "./types.ts";
import { makeRange, symbolId } from "./validation.ts";

interface JsxToken {
  type: "lt" | "gt" | "slashGt" | "slash" | "equals" | "ident" | "lbrace" | "rbrace" | "text";
  value: string;
  start: number;
  end: number;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_]/u.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_.-]/u.test(char);
}

function tokenizeJsx(source: string): JsxToken[] {
  const tokens: JsxToken[] = [];
  let index = 0;
  const push = (type: JsxToken["type"], value: string, start: number, end: number): void => {
    tokens.push({ type, value, start, end });
    if (tokens.length > CODE_IR_HARD_LIMITS.maxTokens) {
      throw new CodeIrValidationError("JSX input exceeds the bounded token budget");
    }
  };
  while (index < source.length) {
    const char = source[index];
    if (char === "<") { push("lt", char, index, index + 1); index += 1; continue; }
    if (char === ">") { push("gt", char, index, index + 1); index += 1; continue; }
    if (char === "/" && source[index + 1] === ">") { push("slashGt", "/>", index, index + 2); index += 2; continue; }
    if (char === "/") { push("slash", char, index, index + 1); index += 1; continue; }
    if (char === "=") { push("equals", char, index, index + 1); index += 1; continue; }
    if (char === "{" || char === "}") {
      push(char === "{" ? "lbrace" : "rbrace", char, index, index + 1); index += 1; continue;
    }
    if (isIdentStart(char)) {
      let end = index + 1;
      while (end < source.length && isIdentPart(source[end])) end += 1;
      push("ident", source.slice(index, end), index, end);
      index = end;
      continue;
    }
    let end = index;
    while (end < source.length && !"<>=/\"'{}\n".includes(source[end]) && !isIdentStart(source[end])) end += 1;
    if (end === index) end = index + 1;
    push("text", source.slice(index, end), index, end);
    index = end;
  }
  return tokens;
}

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
  tokens: JsxToken[];
  position: number;
  symbols: SourceSymbol[];
  relations: { from: string; to: string; kind: "renders" }[];
  unsupported: UnsupportedRegion[];
}

function peek(state: ParserState): JsxToken | undefined {
  return state.tokens[state.position];
}

function next(state: ParserState): JsxToken {
  const token = state.tokens[state.position];
  if (!token) throw new CodeIrValidationError("JSX ended unexpectedly");
  state.position += 1;
  return token;
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

function skipWhitespace(state: ParserState): void {
  while (state.position < state.tokens.length) {
    const token = state.tokens[state.position];
    if (token.type === "text" && token.value.trim() === "") state.position += 1;
    else break;
  }
}

// JSX text and attribute strings carry HTML entities, not JS escapes. The entities Lilac
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

// The literal inside an expression container opened at `open`: true, false, a number or
// a quoted string. Returns null for anything else. On success, the parser is moved past
// the closing brace.
function readLiteralExpression(state: ParserState, open: JsxToken): { literal: SymbolProp["literal"]; end: number } | null {
  const { source } = state;
  let index = open.end;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  let literal: SymbolProp["literal"];
  if (source[index] === '"' || source[index] === "'") {
    const scanned = scanJsStringLiteral(source, index);
    literal = { kind: "string", value: scanned.value };
    index = scanned.end;
  } else {
    const close = source.indexOf("}", index);
    if (close < 0) return null;
    const body = source.slice(index, close).trim();
    if (body === "true" || body === "false") literal = { kind: "boolean", value: body === "true" };
    else if (NUMERIC_LITERAL.test(body)) {
      const numeric = Number(body);
      if (!Number.isFinite(numeric)) throw new CodeIrValidationError("JSX numeric literal must be finite");
      literal = { kind: "number", value: numeric };
    } else return null;
    index = close;
  }
  while (/\s/u.test(source[index] ?? "")) index += 1;
  if (source[index] !== "}") return null;
  const end = index + 1;
  while (state.position < state.tokens.length && state.tokens[state.position].start < end) state.position += 1;
  return { literal, end };
}

function skipBalancedBraces(state: ParserState, open: JsxToken): number {
  let depth = 1;
  while (state.position < state.tokens.length) {
    const token = next(state);
    if (token.type === "lbrace") depth += 1;
    if (token.type === "rbrace") {
      depth -= 1;
      if (depth === 0) return token.end;
    }
  }
  throw new CodeIrValidationError(`JSX expression opened at offset ${open.start} is unbalanced`);
}

function parseElement(state: ParserState, depth: number): SourceSymbol {
  if (depth > CODE_IR_HARD_LIMITS.maxDepth) {
    throw new CodeIrValidationError("JSX nesting exceeds maxDepth");
  }
  const open = next(state);
  if (open.type !== "lt") throw new CodeIrValidationError("JSX element must open with <");
  skipWhitespace(state);
  const nameToken = next(state);
  if (nameToken.type !== "ident") {
    unsupportedAt(state, "non-identifier JSX tag", open.start, nameToken.end);
    throw new CodeIrValidationError("JSX tag name must be an identifier");
  }
  const name = nameToken.value;
  const props: SymbolProp[] = [];
  const texts: SymbolText[] = [];
  const children: SourceSymbol[] = [];
  let selfClosing = false;
  for (;;) {
    skipWhitespace(state);
    const token = peek(state);
    if (!token) throw new CodeIrValidationError(`JSX element ${name} is unterminated`);
    if (token.type === "gt") { next(state); break; }
    if (token.type === "slashGt") { next(state); selfClosing = true; break; }
    if (token.type !== "ident") {
      unsupportedAt(state, `unsupported JSX attribute form in ${name}`, token.start, token.end);
      throw new CodeIrValidationError(`JSX element ${name} has an unsupported attribute form`);
    }
    const attrName = next(state);
    skipWhitespace(state);
    const maybeEquals = peek(state);
    if (!maybeEquals || maybeEquals.type !== "equals") {
      props.push({
        name: attrName.value,
        literal: { kind: "boolean", value: true },
        range: makeRange(state.file, state.source, state.starts, attrName.start, attrName.end),
      });
      continue;
    }
    next(state);
    skipWhitespace(state);
    const valuePeek = peek(state);
    if (!valuePeek) throw new CodeIrValidationError(`JSX attribute in ${name} is missing a value`);
    if (valuePeek.value === '"' || valuePeek.value === "'") {
      const scanned = scanStringLiteral(state.source, valuePeek.start);
      state.position += 1;
      while (state.position < state.tokens.length && state.tokens[state.position].start < scanned.end) {
        state.position += 1;
      }
      props.push({
        name: attrName.value,
        literal: { kind: "string", value: scanned.value },
        range: makeRange(state.file, state.source, state.starts, attrName.start, scanned.end),
      });
      continue;
    }
    if (valuePeek.type !== "lbrace") {
      unsupportedAt(state, `unsupported JSX attribute value in ${name}`, valuePeek.start, valuePeek.end);
      throw new CodeIrValidationError(`JSX element ${name} has an unsupported attribute value`);
    }
    const valueToken = next(state);
    const parsed = readLiteralExpression(state, valueToken);
    if (!parsed) {
      const end = skipBalancedBraces(state, valueToken);
      unsupportedAt(state, `non-literal JSX expression attribute in ${name}`, valueToken.start, end);
      throw new CodeIrValidationError(`JSX element ${name} uses a non-literal expression attribute`);
    }
    props.push({
      name: attrName.value,
      literal: parsed.literal,
      range: makeRange(state.file, state.source, state.starts, attrName.start, parsed.end),
    });
    continue;
  }

  if (!selfClosing) {
    const textParts: { value: string; start: number; end: number }[] = [];
    const flushText = (): void => {
      if (textParts.length === 0) return;
      const first = textParts[0];
      const last = textParts[textParts.length - 1];
      textParts.length = 0;
      if (last.end - first.start > MAX_RAW_TEXT) throw new CodeIrValidationError(`JSX text in ${name} exceeds ${MAX_RAW_TEXT} source characters`);
      const value = cleanJsxText(decodeJsxEntities(state.source.slice(first.start, last.end), `JSX text in ${name}`));
      if (value === "") return;
      if (value.length > 4096) throw new CodeIrValidationError(`JSX text in ${name} exceeds 4096 characters`);
      texts.push({
        value,
        range: makeRange(state.file, state.source, state.starts, first.start, last.end),
      });
    };
    for (;;) {
      const token = peek(state);
      if (!token) throw new CodeIrValidationError(`JSX element ${name} is missing its closing tag`);
      if (token.type === "lt") {
        flushText();
        const lookahead = state.tokens[state.position + 1];
        if (lookahead && lookahead.type === "slash") {
          next(state);
          next(state);
          skipWhitespace(state);
          const closeName = next(state);
          if (closeName.type !== "ident" || closeName.value !== name) {
            throw new CodeIrValidationError(`JSX mismatched closing tag for ${name}`);
          }
          skipWhitespace(state);
          const end = next(state);
          if (end.type !== "gt") throw new CodeIrValidationError(`JSX closing tag for ${name} is malformed`);
          break;
        }
        children.push(parseElement(state, depth + 1));
        continue;
      }
      if (token.type === "lbrace") {
        flushText();
        const openBrace = next(state);
        // A string literal child is exact text: {"  spaced  "} keeps its whitespace.
        const literal = readLiteralExpression(state, openBrace);
        if (literal !== null && literal.literal.kind === "string") {
          if (literal.literal.value.length > 4096) throw new CodeIrValidationError(`JSX text in ${name} exceeds 4096 characters`);
          if (literal.literal.value !== "") {
            texts.push({ value: literal.literal.value, range: makeRange(state.file, state.source, state.starts, openBrace.start, literal.end) });
          }
          continue;
        }
        if (literal !== null) {
          unsupportedAt(state, `non-string literal child in ${name}`, openBrace.start, literal.end);
          throw new CodeIrValidationError(`JSX element ${name} contains a non-string literal child`);
        }
        const end = skipBalancedBraces(state, openBrace);
        unsupportedAt(state, `expression child in ${name}`, openBrace.start, end);
        throw new CodeIrValidationError(`JSX element ${name} contains an expression child outside the supported subset`);
      }
      if (token.type === "text" || token.type === "gt" || token.type === "slash" || token.type === "slashGt" || token.type === "equals" || token.type === "ident" || token.type === "rbrace") {
        const part = next(state);
        textParts.push({ value: part.value, start: part.start, end: part.end });
        continue;
      }
      flushText();
      unsupportedAt(state, `unsupported JSX child in ${name}`, token.start, token.end);
      throw new CodeIrValidationError(`JSX element ${name} contains an unsupported child`);
    }
    flushText();
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
  const endOffset = state.tokens[state.position - 1].end;
  const kind = /^[A-Z]/u.test(name) ? "component" : "element";
  const id = symbolId(state.file, kind, name, open.start);
  const symbol: SourceSymbol = {
    id,
    kind,
    name,
    range: makeRange(state.file, state.source, state.starts, open.start, endOffset),
    props,
    children: children.map((child) => child.id),
    texts,
  };
  const classProp = props.find((prop) => prop.name === "className" && prop.literal.kind === "string");
  if (classProp && classProp.literal.kind === "string") {
    symbol.classTokens = classProp.literal.value.split(/\s+/u).filter((entry) => entry !== "");
  }
  state.symbols.push(symbol);
  for (const child of children) {
    state.symbols.push(child);
    state.relations.push({ from: id, to: child.id, kind: "renders" });
  }
  return symbol;
}

/**
 * Repository component binding: match exported function and arrow components
 * to the root element they render. Each definition claims the nearest
 * following unclaimed root; the component symbol anchors at its rendered
 * output range with copied literal props. Anonymous defaults cannot bind.
 */
function bindComponentDefinitions(state: ParserState, roots: SourceSymbol[]): void {
  const pattern = /(?:export\s+default\s+)?(?:export\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(|const\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]{0,2048}\)|[A-Za-z_$][\w$]*)\s*=>/gu;
  const definitions: { name: string; offset: number }[] = [];
  for (const match of state.source.matchAll(pattern)) {
    if (definitions.length >= 64) break;
    definitions.push({ name: (match[1] ?? match[2]) as string, offset: match.index ?? 0 });
  }
  const claimed = new Set<number>();
  const orderedRoots = [...roots].sort((a, b) => a.range.startOffset - b.range.startOffset);
  for (const root of orderedRoots) {
    let chosen = -1;
    for (let index = 0; index < definitions.length; index += 1) {
      if (claimed.has(index)) continue;
      if (definitions[index].offset < root.range.startOffset) chosen = index;
      else break;
    }
    if (chosen === -1) continue;
    claimed.add(chosen);
    const id = symbolId(state.file, "component", definitions[chosen].name, root.range.startOffset);
    state.symbols.push({
      id,
      kind: "component",
      name: definitions[chosen].name,
      range: { ...root.range },
      props: root.props.map((prop) => ({ name: prop.name, literal: { ...prop.literal } as SourceSymbol["props"][number]["literal"], range: { ...prop.range } })),
      children: [root.id],
      texts: [],
      ...(root.classTokens === undefined ? {} : { classTokens: [...root.classTokens] }),
    });
    state.relations.push({ from: id, to: root.id, kind: "renders" });
  }
}

// End offset of a braced expression starting at `start`, skipping quoted strings, template
// literals and nested braces; -1 when it never closes. JSX, a comment or a regex literal
// inside the braces makes quotes and braces ambiguous (an apostrophe in JSX text is not a
// string, a "}" in a regex closes nothing, a template literal can nest more templates
// inside ${}), so any "<", "/" or backtick also gives -1: recovery then stops instead of
// guessing where the element ends.
function bracedEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "<" || char === "/" || char === "`") return -1;
    if (char === '"' || char === "'") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) if (source[index] === "\\") index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

// Where an element that failed to parse ends, by balancing its tags (quoted attribute
// values and braces skipped). Returns -1 when the element never closes. Recovery resumes
// after this offset, so no descendant of a failed element becomes a root.
function failedElementEnd(state: ParserState, startIndex: number): number {
  const { source, tokens } = state;
  const open: string[] = [];
  let offset = tokens[startIndex].start;
  while (offset < source.length) {
    const char = source[offset];
    if (char === "{") {
      const end = bracedEnd(source, offset);
      if (end < 0) return -1;
      offset = end;
      continue;
    }
    if (char !== "<") { offset += 1; continue; }
    if (source[offset + 1] === "/") {
      const close = source.indexOf(">", offset);
      if (close < 0) return -1;
      // A closing tag must name the innermost open element; a mismatch or a fragment
      // close means the structure is not what it seems, so recovery stops.
      if (source.slice(offset + 2, close).trim() !== open.pop()) return -1;
      offset = close + 1;
      if (open.length === 0) return offset;
      continue;
    }
    if (/^<\s*>/u.test(source.slice(offset, offset + 64))) return -1;
    if (!isIdentStart(source[offset + 1] ?? "")) { offset += 1; continue; }
    let nameEnd = offset + 1;
    while (nameEnd < source.length && isIdentPart(source[nameEnd])) nameEnd += 1;
    const tagName = source.slice(offset + 1, nameEnd);
    // An opening tag: scan its header to > or />.
    let index = offset + 1;
    let selfClosing = false;
    for (;;) {
      const headerChar = source[index];
      if (headerChar === undefined) return -1;
      if (headerChar === '"' || headerChar === "'") {
        const end = source.indexOf(headerChar, index + 1);
        if (end < 0) return -1;
        index = end + 1;
        continue;
      }
      if (headerChar === "{") {
        const end = bracedEnd(source, index);
        if (end < 0) return -1;
        index = end;
        continue;
      }
      if (headerChar === "/" && source[index + 1] === ">") { selfClosing = true; index += 2; break; }
      if (headerChar === ">") { index += 1; break; }
      index += 1;
    }
    offset = index;
    if (!selfClosing) open.push(tagName);
    else if (open.length === 0) return offset;
  }
  return -1;
}

export function parseJsxFile(file: string, source: string): JsxParseResult {
  if (typeof source !== "string") throw new CodeIrValidationError("JSX source must be a string");
  if (source.length === 0) throw new CodeIrValidationError("JSX source must not be empty");
  if (source.length > CODE_IR_HARD_LIMITS.maxSourceBytes) {
    throw new CodeIrValidationError("JSX source exceeds maxSourceBytes");
  }
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  const state: ParserState = {
    file,
    source,
    starts,
    tokens: tokenizeJsx(source),
    position: 0,
    symbols: [],
    relations: [],
    unsupported: [],
  };
  const roots: SourceSymbol[] = [];
  while (state.position < state.tokens.length) {
    const token = peek(state);
    if (!token) break;
    if (token.type === "lt") {
      const lookahead = state.tokens[state.position + 1];
      if (lookahead && lookahead.type === "ident") {
        const attempt = state.position;
        const symbolCount = state.symbols.length;
        const relationCount = state.relations.length;
        try {
          roots.push(parseElement(state, 0));
        } catch (error) {
          state.symbols.length = symbolCount;
          state.relations.length = relationCount;
          if (state.unsupported.length >= CODE_IR_HARD_LIMITS.maxUnsupported) throw error;
          const contextEnd = Math.min(state.tokens.length - 1, attempt + 8);
          unsupportedAt(state, `unparseable top-level JSX: ${error instanceof Error ? error.message : String(error)}`, token.start, state.tokens[contextEnd].end);
          const resume = failedElementEnd(state, attempt);
          state.position = attempt + 1;
          if (resume < 0) state.position = state.tokens.length;
          else while (state.position < state.tokens.length && state.tokens[state.position].start < resume) state.position += 1;
        }
        continue;
      }
      if (lookahead && lookahead.type === "gt") {
        unsupportedAt(state, "JSX fragment outside the supported subset", token.start, lookahead.end);
        throw new CodeIrValidationError("JSX fragments are outside the supported subset");
      }
      unsupportedAt(state, "stray angle bracket outside JSX", token.start, lookahead ? lookahead.end : token.end);
      state.position += 1;
      continue;
    }
    state.position += 1;
  }
  if (roots.length === 0) {
    const reason = state.unsupported.length > 0 ? `: ${state.unsupported[0].reason}` : "";
    throw new CodeIrValidationError(`JSX source contains no supported elements${reason}`);
  }
  if (state.symbols.length > CODE_IR_HARD_LIMITS.maxSymbols) {
    throw new CodeIrValidationError("JSX symbols exceed maxSymbols");
  }
  bindComponentDefinitions(state, roots);
  if (state.symbols.length > CODE_IR_HARD_LIMITS.maxSymbols) {
    throw new CodeIrValidationError("JSX symbols exceed maxSymbols");
  }
  return {
    symbols: state.symbols,
    rootIds: roots.map((root) => root.id),
    relations: state.relations,
    unsupported: state.unsupported,
  };
}
