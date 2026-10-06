export const VISUAL_GIT_SCHEMA_VERSION = 1;

export const VISUAL_GIT_HARD_LIMITS = {
  maxNodes: 20000,
  maxDepth: 256,
  maxNameLength: 512,
  maxComments: 4096,
  maxCommentLength: 8192,
  maxLinks: 20000,
  maxChecks: 128,
  maxCheckDetailLength: 2048,
  maxPathLength: 1024,
  maxSymbolLength: 512,
} as const;

export const NODE_KINDS = ["page", "frame", "node"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface DesignNode {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  name: string;
  contentHash: string;
}

export interface DesignSnapshot {
  schemaVersion: typeof VISUAL_GIT_SCHEMA_VERSION;
  snapshotId: string;
  branch: string;
  sourceCommit: string;
  parentSnapshotId: string | null;
  createdAt: string;
  nodes: DesignNode[];
}

export const CHANGED_FIELDS = ["kind", "name", "contentHash"] as const;
export type ChangedField = (typeof CHANGED_FIELDS)[number];

export interface NodeChange {
  id: string;
  fields: ChangedField[];
  before: DesignNode;
  after: DesignNode;
}

export interface NodeMove {
  id: string;
  fromParentId: string | null;
  toParentId: string | null;
}

export interface SnapshotDiff {
  baseSnapshotId: string;
  headSnapshotId: string;
  added: DesignNode[];
  removed: DesignNode[];
  changed: NodeChange[];
  moved: NodeMove[];
  summary: { added: number; removed: number; changed: number; moved: number; unchanged: number };
}

export interface ReviewComment {
  commentId: string;
  snapshotId: string;
  anchorId: string;
  authorId: string;
  body: string;
  createdAt: string;
  resolved: boolean;
}

export interface SourceRange {
  startLine: number;
  endLine: number;
}

export interface DesignCodeLink {
  linkId: string;
  snapshotId: string;
  nodeId: string;
  file: string;
  symbol: string;
  sourceCommit: string;
  range: SourceRange | null;
}

export const CONFLICT_KINDS = [
  "content",
  "parent",
  "delete-modify",
  "add-add",
  "orphaned-child",
  "cycle",
  "invalid-nesting",
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface MergeConflict {
  nodeId: string;
  kinds: ConflictKind[];
  base: DesignNode | null;
  ours: DesignNode | null;
  theirs: DesignNode | null;
}

export interface ConflictReport {
  baseSnapshotId: string;
  oursSnapshotId: string;
  theirsSnapshotId: string;
  conflicts: MergeConflict[];
  mergeable: boolean;
}

export const CHECK_VERDICTS = ["pass", "fail", "pending", "skipped"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export interface AcceptanceCheck {
  name: string;
  verdict: CheckVerdict;
  detail: string;
}

export const GATE_BLOCK_REASONS = [
  "no-checks",
  "failing-check",
  "pending-check",
  "missing-required-check",
  "skipped-required-check",
  "stale-snapshot",
] as const;
export type GateBlockReason = (typeof GATE_BLOCK_REASONS)[number];

export interface GateBlock {
  reason: GateBlockReason;
  check: string | null;
}

export interface AcceptanceResult {
  snapshotId: string;
  baseCommit: string;
  headCommit: string;
  verdict: "accepted" | "blocked";
  blocks: GateBlock[];
}

export interface DesignProvenanceRecord {
  recordId: string;
  snapshotId: string;
  snapshotDigest: string;
  branch: string;
  sourceCommit: string;
  recordedBy: string;
  recordedAt: string;
}
