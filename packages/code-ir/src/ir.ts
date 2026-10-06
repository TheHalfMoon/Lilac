import { CodeIrUnsupportedError } from "./errors.ts";
import { parseCssFile } from "./css.ts";
import { parseJsxFile } from "./jsx.ts";
import {
  CODE_IR_SCHEMA_VERSION,
  type CodeIr,
  type SourceSymbol,
  type SymbolRelation,
  type UnsupportedRegion,
} from "./types.ts";
import { assertSourceFile, normalizeCodeIr } from "./validation.ts";

export interface SourceFileInput {
  path: string;
  content: string;
}

function isJsxPath(path: string): boolean {
  return path.endsWith(".jsx") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".ts");
}

function isCssPath(path: string): boolean {
  return path.endsWith(".css");
}

/**
 * Build a stable code/design IR from bounded sources. JSX/TSX elements and
 * CSS rules become symbols with source ranges; everything outside the
 * supported subsets becomes explicit unsupported regions, never guesses.
 */
export function buildCodeIr(files: SourceFileInput[]): CodeIr {
  if (!Array.isArray(files) || files.length === 0 || files.length > 64) {
    throw new CodeIrUnsupportedError("code IR requires a bounded non-empty file list");
  }
  const symbols: Record<string, SourceSymbol> = Object.create(null);
  const rootIds: string[] = [];
  const relations: SymbolRelation[] = [];
  const unsupported: UnsupportedRegion[] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      throw new CodeIrUnsupportedError("code IR file entries must be objects");
    }
    assertSourceFile((file as Record<string, unknown>).path, "code.file.path");
    const path = (file as SourceFileInput).path;
    const content = (file as SourceFileInput).content;
    if (typeof content !== "string") throw new CodeIrUnsupportedError(`code file ${path} content must be a string`);
    if (isJsxPath(path)) {
      const parsed = parseJsxFile(path, content);
      for (const symbol of parsed.symbols) symbols[symbol.id] = symbol;
      rootIds.push(...parsed.rootIds);
      relations.push(...parsed.relations.map((relation) => ({ ...relation, kind: "renders" as const })));
      unsupported.push(...parsed.unsupported);
    } else if (isCssPath(path)) {
      const parsed = parseCssFile(path, content);
      for (const symbol of parsed.symbols) symbols[symbol.id] = symbol;
      rootIds.push(...parsed.rootIds);
      relations.push(...parsed.relations.map((relation) => ({ ...relation, kind: "styles" as const })));
      unsupported.push(...parsed.unsupported);
    } else {
      throw new CodeIrUnsupportedError(`code file ${path} has an unsupported extension`);
    }
  }
  return normalizeCodeIr({
    schemaVersion: CODE_IR_SCHEMA_VERSION,
    symbols,
    rootIds,
    relations,
    unsupported,
  });
}
