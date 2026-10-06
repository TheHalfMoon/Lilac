import { CodeIrValidationError } from "./errors.ts";

export interface TokenMapping {
  fromClass: string;
  toToken: string;
}

export interface TokenMapResult {
  preserved: string[];
  mapped: { fromClass: string; toToken: string }[];
  unmapped: string[];
}

/**
 * Tailwind class lists are preserved verbatim. Mapping to design tokens
 * happens only on exact caller-supplied matches; nothing is evaluated.
 */
export function tokenizeClassList(className: string): string[] {
  if (typeof className !== "string") throw new CodeIrValidationError("class list must be a string");
  if (className.length > 4096) throw new CodeIrValidationError("class list exceeds 4096 characters");
  return className.split(/\s+/u).filter((entry) => entry !== "");
}

export function mapClassTokens(className: string, mapping: TokenMapping[]): TokenMapResult {
  const preserved = tokenizeClassList(className);
  if (!Array.isArray(mapping) || mapping.length > 512) {
    throw new CodeIrValidationError("token mapping must be a bounded array");
  }
  const table = new Map<string, string>();
  for (const entry of mapping) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CodeIrValidationError("token mapping entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.fromClass !== "string" || record.fromClass === "" || typeof record.toToken !== "string" || record.toToken === "") {
      throw new CodeIrValidationError("token mapping entries need non-empty fromClass and toToken");
    }
    table.set(record.fromClass, record.toToken);
  }
  const mapped: { fromClass: string; toToken: string }[] = [];
  const unmapped: string[] = [];
  for (const token of preserved) {
    const toToken = table.get(token);
    if (toToken === undefined) unmapped.push(token);
    else mapped.push({ fromClass: token, toToken });
  }
  return { preserved, mapped, unmapped };
}
