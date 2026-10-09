export const CODE_IR_SCHEMA_VERSION = 1;

// The limits follow what bringing in, previewing and writing back a component was measured
// to cost (P08-G4, #250): every step grows linearly with the component, and a 247 KiB page
// of 7,250 elements came in, previewed and wrote back in about a second each.
// - maxTokens equals maxSourceBytes: each token is at least one character, so it only stops
//   a source that the size limit has not already stopped.
// - maxSymbols matches the studio host's export limit of 5,000 layers, counted in elements:
//   runs of text between elements become layers of their own, so a component near the limit
//   can still be too large to export at once (the export refuses it with its reason).
// - maxChildrenPerSymbol was measured at 4,096 children on one element. Runs of text sit
//   between and around them, so an element has one more of those (#256).
// - maxPatchOps matches maxSymbols: one write-back carries up to 5,000 changed fields, measured
//   on a 252 KiB file at 0.86 s to preview and 1.3 s to write (#256).
export const CODE_IR_HARD_LIMITS = {
  maxSourceBytes: 256 * 1024,
  maxTokens: 256 * 1024,
  maxDepth: 32,
  maxSymbols: 5_000,
  maxPropsPerSymbol: 64,
  maxChildrenPerSymbol: 4_096,
  maxTextRunsPerSymbol: 4_097,
  maxUnsupported: 256,
  maxPatchOps: 5_000,
  maxMergeLines: 4096,
  maxCssRules: 512,
  maxDeclarationsPerRule: 128,
} as const;

export interface SourceRange {
  file: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export type PropLiteral =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean };

export interface SymbolProp {
  name: string;
  literal: PropLiteral;
  range: SourceRange;
}

export type SymbolKind = "component" | "element" | "style-rule" | "token";

export interface SymbolText {
  value: string;
  range: SourceRange;
}

export interface SourceSymbol {
  id: string;
  kind: SymbolKind;
  name: string;
  range: SourceRange;
  props: SymbolProp[];
  children: string[];
  texts: SymbolText[];
  classTokens?: string[];
}

export interface UnsupportedRegion {
  reason: string;
  range: SourceRange;
}

export interface SymbolRelation {
  from: string;
  to: string;
  kind: "renders" | "styles" | "references";
}

export interface CodeIr {
  schemaVersion: number;
  symbols: Record<string, SourceSymbol>;
  rootIds: string[];
  relations: SymbolRelation[];
  unsupported: UnsupportedRegion[];
}

export interface PatchAnchor {
  range: SourceRange;
  expectedText: string;
}

export interface PatchOp {
  op: "update-prop" | "update-text" | "insert-prop";
  targetSymbolId: string;
  anchor: PatchAnchor;
  replacement: string;
}

export interface MergeConflict {
  startLine: number;
  endLineBase: number;
  reason: string;
}

export interface MergeResult {
  merged: string | null;
  conflicts: MergeConflict[];
}

export interface DesignDocNode {
  tag: string;
  props: Record<string, string | number | boolean>;
  text?: string;
  children?: DesignDocNode[];
}

export interface DesignDoc {
  componentName: string;
  root: DesignDocNode;
}
