import { CodeIrValidationError } from "./errors.ts";
import { CODE_IR_HARD_LIMITS, type SourceSymbol, type UnsupportedRegion } from "./types.ts";
import { makeRange, symbolId } from "./validation.ts";

interface JsxToken {
  type: "lt" | "gt" | "slashGt" | "slash" | "equals" | "string" | "ident" | "lbrace" | "rbrace" | "text";
  value: string;
  start: number;
  end: number;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_]/u.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_.]/u.test(char);
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

function scanStringLiteral(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") throw new CodeIrValidationError("JSX attribute value must be a string or literal expression");
  let out = "";
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === "\\" && index + 1 < source.length) {
      const escaped = source[index + 1];
      out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      index += 2;
      continue;
    }
    if (source[index] === "\n") throw new CodeIrValidationError("JSX string literal must not span lines");
    out += source[index];
    index += 1;
  }
  if (index >= source.length) throw new CodeIrValidationError("JSX string literal is unterminated");
  return { value: out, end: index + 1 };
}

function parseExpressionLiteral(state: ParserState): { literal: SymbolProp["literal"]; end: number } | null {
  const token = peek(state);
  if (!token) return null;
  if (token.type === "string") {
    next(state);
    return { literal: { kind: "string", value: parseStringLiteral(token) }, end: token.end };
  }
  if (token.type === "ident" && (token.value === "true" || token.value === "false")) {
    next(state);
    return { literal: { kind: "boolean", value: token.value === "true" }, end: token.end };
  }
  if (token.type === "text" && /^-?\d+(\.\d+)?$/u.test(token.value.trim()) && token.value.trim() !== "") {
    next(state);
    return { literal: { kind: "number", value: Number(token.value.trim()) }, end: token.end };
  }
  return null;
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
    const parsed = parseExpressionLiteral(state);
    if (!parsed) {
      const end = skipBalancedBraces(state, valueToken);
      unsupportedAt(state, `non-literal JSX expression attribute in ${name}`, valueToken.start, end);
      throw new CodeIrValidationError(`JSX element ${name} uses a non-literal expression attribute`);
    }
    const close = next(state);
    if (close.type !== "rbrace") throw new CodeIrValidationError(`JSX attribute in ${name} is unbalanced`);
    props.push({
      name: attrName.value,
      literal: parsed.literal,
      range: makeRange(state.file, state.source, state.starts, attrName.start, close.end),
    });
    continue;
  }

  if (!selfClosing) {
    const textParts: { value: string; start: number; end: number }[] = [];
    const flushText = (): void => {
      if (textParts.length === 0) return;
      const value = textParts.map((part) => part.value).join("");
      const first = textParts[0];
      const last = textParts[textParts.length - 1];
      textParts.length = 0;
      if (value.trim() === "") return;
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
        const end = skipBalancedBraces(state, openBrace);
        unsupportedAt(state, `expression child in ${name}`, openBrace.start, end);
        throw new CodeIrValidationError(`JSX element ${name} contains an expression child outside the supported subset`);
      }
      if (token.type === "text" || token.type === "gt" || token.type === "slash" || token.type === "equals" || token.type === "ident" || token.type === "string" || token.type === "rbrace") {
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
          state.position = attempt + 1;
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
  return {
    symbols: state.symbols,
    rootIds: roots.map((root) => root.id),
    relations: state.relations,
    unsupported: state.unsupported,
  };
}
