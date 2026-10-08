import type { DesignDoc, SourceRange } from "@ninerr/code-ir";

export const DESIGN_COMPONENTS_SCHEMA_VERSION = 1;

export const DESIGN_COMPONENTS_HARD_LIMITS = {
  maxProps: 64,
  maxSlots: 32,
  maxStates: 32,
  maxVariants: 64,
  maxEnumValues: 64,
  maxSystemComponents: 256,
  maxSystemTokens: 256,
} as const;

export type ContractPropType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: string[] };

export interface ContractProp {
  name: string;
  propType: ContractPropType;
  required: boolean;
  default?: string | number | boolean;
}

export interface SlotDef {
  name: string;
  tag: string;
  required: boolean;
}

export interface ComponentVariant {
  name: string;
  props: Record<string, string | number | boolean>;
  minWidth?: number;
  maxWidth?: number;
}

export interface ComponentContract {
  schemaVersion: number;
  contractId: string;
  componentName: string;
  sourceFile: string;
  props: ContractProp[];
  slots: SlotDef[];
  states: string[];
  variants: ComponentVariant[];
  systemId?: string;
}

export interface BoundComponent {
  contractId: string;
  componentName: string;
  symbolId: string;
  sourceFile: string;
  range: SourceRange;
  boundProps: Record<string, string | number | boolean>;
}

export type DriftKind =
  | "missing-symbol"
  | "renamed-symbol"
  | "missing-prop"
  | "extra-prop"
  | "type-changed"
  | "enum-violated"
  | "missing-slot"
  | "extra-slot";

export interface ContractDrift {
  kind: DriftKind;
  detail: string;
}

export interface ComponentPreview {
  componentName: string;
  symbolId: string;
  sourceRange: SourceRange;
  doc: DesignDoc;
}

export interface DesignSystem {
  schemaVersion: number;
  systemId: string;
  name: string;
  contracts: ComponentContract[];
  tokens: string[];
}
