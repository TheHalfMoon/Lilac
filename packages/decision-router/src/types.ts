export const DECISION_SCHEMA_VERSION = 1;

export const DECISION_HARD_LIMITS = {
  maxDimensions: 20,
  maxLabels: 100,
  maxDimensionNameLength: 64,
  maxLabelLength: 200,
  maxDimensionDefinitionChars: 16000,
  maxInstructionsLength: 4000,
  maxItems: 256,
  maxInputChars: 8000,
  maxCellsPerBatch: 64,
  maxReviewItems: 256,
  maxLedgerEntries: 1024,
} as const;

export type DecisionJsonValue =
  | string
  | number
  | boolean
  | null
  | DecisionJsonValue[]
  | { [key: string]: DecisionJsonValue };

export interface DecisionDimension {
  name: string;
  labels: string[];
  instructions?: string;
}

export interface DecisionPolicy {
  unsureBelow: number;
  maxItems: number;
  maxInputChars: number;
  maxCellsPerBatch: number;
  maxReviewItems: number;
}

export interface DecisionRequest {
  schemaVersion: number;
  requestId: string;
  actorId: string;
  intent: string;
  at: string;
  inputs: string[];
  dimensions: DecisionDimension[];
  policy: DecisionPolicy;
}

export interface DecisionCell {
  itemIndex: number;
  dimensionIndex: number;
  cellId: string;
  input: string;
  dimension: DecisionDimension;
}

export interface AdapterCellResult {
  label: string;
  confidence: number;
  scores: Record<string, number>;
}

export interface DecisionPrecheck {
  itemIndex: number;
  dimensionIndex?: number;
  verdict:
    | { kind: "label"; label: string }
    | { kind: "abstain"; reason: string };
}

export interface CellDecision {
  cellId: string;
  itemIndex: number;
  dimensionIndex: number;
  label: string | null;
  confidence: number | null;
  scores: Record<string, number>;
  abstained: boolean;
  abstainReason: string | null;
  adapter: string;
  precheckApplied: boolean;
}

export interface ReviewItem {
  itemIndex: number;
  dimensionIndex: number;
  cellId: string;
  reason: string;
  threshold: number;
  confidence: number | null;
  requestId: string;
  at: string;
}

export interface DecisionRecord {
  schemaVersion: number;
  recordId: string;
  requestId: string;
  actorId: string;
  intent: string;
  at: string;
  dimensionsSha256: string;
  threshold: number;
  adapter: string;
  decisions: CellDecision[];
  reviewQueue: ReviewItem[];
  prechecksApplied: number;
}

export interface DecisionRequestLedger {
  schemaVersion: number;
  entries: Record<string, {
    requestId: string;
    intentSha256: string;
    inputSha256: string;
    recordId: string;
  }>;
}

export type DecisionAdapterStatus =
  | { status: "ok"; value: AdapterCellResult[] }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export interface DecisionAdapter {
  name: string;
  classifyCells(cells: DecisionCell[], policy: DecisionPolicy): Promise<DecisionAdapterStatus>;
}
