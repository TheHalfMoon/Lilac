export const DESIGN_METHOD_SCHEMA_VERSION = 1;

export const DESIGN_METHOD_HARD_LIMITS = {
  maxPacks: 16,
  maxRulesPerPack: 64,
  maxRuleIdLength: 128,
  maxStatementLength: 1024,
  maxChecklistItems: 128,
  maxChecklists: 16,
  maxSnapshotNodes: 2048,
  maxRegistryEntries: 2048,
  maxTaxonomyCategories: 64,
  maxLicenseLength: 256,
  maxUrlLength: 2048,
} as const;

export const RULE_SEVERITIES = ["info", "minor", "major"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const RULE_PACK_PLATFORMS = ["ios", "android", "universal"] as const;
export type RulePackPlatform = (typeof RULE_PACK_PLATFORMS)[number];

export const SNAPSHOT_NODE_KINDS = [
  "screen",
  "container",
  "text",
  "image",
  "button",
  "input",
  "list",
  "icon",
  "other",
] as const;
export type SnapshotNodeKind = (typeof SNAPSHOT_NODE_KINDS)[number];

export interface MethodRule {
  id: string;
  statement: string;
  rationale: string;
  severity: RuleSeverity;
}

export interface RulePack {
  id: string;
  title: string;
  platform: RulePackPlatform;
  category: string;
  version: string;
  rules: MethodRule[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  ruleIds: string[];
}

export interface ReviewChecklist {
  id: string;
  role: string;
  items: ChecklistItem[];
}

export interface SnapshotNode {
  id: string;
  kind: SnapshotNodeKind;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  textSize?: number;
  interactive?: boolean;
  virtualized?: boolean;
  itemCount?: number;
}

export interface DesignSnapshot {
  schemaVersion: number;
  snapshotId: string;
  nodes: SnapshotNode[];
  themes?: string[];
  tokensThemed?: boolean;
}

export interface ReviewCandidate {
  ruleId: string;
  packId: string;
  nodeId: string | null;
  severity: RuleSeverity;
  message: string;
}

export interface ResourceEntry {
  id: string;
  name: string;
  category: string;
  source: string;
  license: string;
  url?: string;
  notes?: string;
}

export interface ResourceRegistry {
  schemaVersion: number;
  taxonomyVersion: string;
  entries: ResourceEntry[];
}
