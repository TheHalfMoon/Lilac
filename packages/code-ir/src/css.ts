import { CodeIrValidationError } from "./errors.ts";
import { CODE_IR_HARD_LIMITS, type SourceSymbol, type UnsupportedRegion } from "./types.ts";
import { makeRange, symbolId } from "./validation.ts";

export interface CssParseResult {
  symbols: SourceSymbol[];
  rootIds: string[];
  relations: { from: string; to: string; kind: "styles" }[];
  unsupported: UnsupportedRegion[];
}

function stripComments(file: string, source: string): { clean: string; map: number[] } {
  let clean = "";
  const map: number[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new CodeIrValidationError(`CSS file ${file} has an unterminated comment`);
      index = end + 2;
      continue;
    }
    clean += source[index];
    map.push(index);
    index += 1;
  }
  return { clean, map };
}

export function parseCssFile(file: string, source: string): CssParseResult {
  if (typeof source !== "string") throw new CodeIrValidationError("CSS source must be a string");
  if (source.length === 0) throw new CodeIrValidationError("CSS source must not be empty");
  if (source.length > CODE_IR_HARD_LIMITS.maxSourceBytes) {
    throw new CodeIrValidationError("CSS source exceeds maxSourceBytes");
  }
  const { clean, map } = stripComments(file, source);
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  const symbols: SourceSymbol[] = [];
  const unsupported: UnsupportedRegion[] = [];
  const noteUnsupported = (reason: string, cleanStart: number, cleanEnd: number): void => {
    if (unsupported.length >= CODE_IR_HARD_LIMITS.maxUnsupported) {
      throw new CodeIrValidationError("CSS unsupported regions exceed the bounded budget");
    }
    unsupported.push({
      reason,
      range: makeRange(file, source, starts, map[cleanStart] ?? source.length, (map[cleanEnd - 1] ?? source.length - 1) + 1),
    });
  };
  let index = 0;
  const skipBlank = (): void => {
    while (index < clean.length && /\s/u.test(clean[index])) index += 1;
  };
  let ruleCount = 0;
  while (index < clean.length) {
    skipBlank();
    if (index >= clean.length) break;
    if (clean[index] === "@") {
      const start = index;
      let depth = 0;
      while (index < clean.length) {
        if (clean[index] === "{") depth += 1;
        if (clean[index] === "}") {
          depth -= 1;
          if (depth === 0) { index += 1; break; }
        }
        if (clean[index] === ";" && depth === 0) { index += 1; break; }
        index += 1;
      }
      noteUnsupported("CSS at-rule outside the supported subset", start, index);
      continue;
    }
    const selectorStart = index;
    const brace = clean.indexOf("{", index);
    if (brace === -1) {
      if (clean.slice(index).trim() !== "") {
        noteUnsupported("CSS trailing text without a rule body", selectorStart, clean.length);
      }
      break;
    }
    const selector = clean.slice(selectorStart, brace).trim();
    if (selector === "" || selector.includes("}") || selector.includes(";")) {
      noteUnsupported("CSS malformed selector", selectorStart, brace + 1);
      index = brace + 1;
      let depth = 1;
      while (index < clean.length && depth > 0) {
        if (clean[index] === "{") depth += 1;
        if (clean[index] === "}") depth -= 1;
        index += 1;
      }
      continue;
    }
    index = brace + 1;
    const declarations: { name: string; value: string; start: number; end: number }[] = [];
    let closed = false;
    let failed = false;
    while (index < clean.length) {
      skipBlank();
      if (index >= clean.length) break;
      if (clean[index] === "}") { index += 1; closed = true; break; }
      if (clean[index] === "{") {
        noteUnsupported(`CSS nested rule inside ${selector}`, selectorStart, index + 1);
        failed = true;
        let depth = 1;
        index += 1;
        while (index < clean.length && depth > 0) {
          if (clean[index] === "{") depth += 1;
          if (clean[index] === "}") depth -= 1;
          index += 1;
        }
        break;
      }
      const semi = clean.indexOf(";", index);
      const close = clean.indexOf("}", index);
      const end = semi === -1 ? close : close === -1 ? semi : Math.min(semi, close);
      if (end === -1) break;
      const text = clean.slice(index, end).trim();
      const colon = text.indexOf(":");
      if (colon === -1) {
        noteUnsupported(`CSS malformed declaration in ${selector}`, index, end);
        failed = true;
        index = end + (clean[end] === ";" ? 1 : 0);
        continue;
      }
      const name = text.slice(0, colon).trim();
      const value = text.slice(colon + 1).trim();
      if (!/^[A-Za-z-]+$/u.test(name) || value === "") {
        noteUnsupported(`CSS malformed declaration in ${selector}`, index, end);
        failed = true;
        index = end + (clean[end] === ";" ? 1 : 0);
        continue;
      }
      declarations.push({ name, value, start: index, end });
      if (declarations.length > CODE_IR_HARD_LIMITS.maxDeclarationsPerRule) {
        throw new CodeIrValidationError(`CSS rule ${selector} exceeds maxDeclarationsPerRule`);
      }
      index = end + (clean[end] === ";" ? 1 : 0);
    }
    if (!closed || failed) {
      if (!closed) throw new CodeIrValidationError(`CSS rule ${selector} is unclosed`);
      continue;
    }
    ruleCount += 1;
  if (ruleCount > CODE_IR_HARD_LIMITS.maxCssRules) {
      throw new CodeIrValidationError("CSS rules exceed maxCssRules");
    }
    const id = symbolId(file, "style-rule", selector, map[selectorStart] ?? 0);
    symbols.push({
      id,
      kind: "style-rule",
      name: selector,
      range: makeRange(file, source, starts, map[selectorStart] ?? 0, (map[index - 1] ?? source.length - 1) + 1),
      props: declarations.map((declaration) => ({
        name: declaration.name,
        literal: { kind: "string", value: declaration.value },
        range: makeRange(file, source, starts, map[declaration.start] ?? 0, (map[declaration.end - 1] ?? source.length - 1) + 1),
      })),
      children: [],
      texts: [],
    });
  }
  return {
    symbols,
    rootIds: symbols.map((symbol) => symbol.id),
    relations: [],
    unsupported,
  };
}
