export const CODE_IR_SCHEMA_VERSION = 1;

export const CODE_IR_HARD_LIMITS = {
  maxSourceBytes: 256 * 1024,
  maxTokens: 8192,
  maxDepth: 32,
  maxSymbols: 1024,
  maxPropsPerSymbol: 64,
  maxChildrenPerSymbol: 256,
  maxUnsupported: 256,
  maxPatchOps: 128,
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
