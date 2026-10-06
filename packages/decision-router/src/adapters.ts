import { DecisionAdapterError, DecisionUnavailableError, DecisionValidationError } from "./errors.ts";
import {
  type AdapterCellResult,
  type DecisionAdapter,
  type DecisionAdapterStatus,
  type DecisionCell,
  type DecisionPolicy,
} from "./types.ts";

export function assertAdapterCellResult(
  value: unknown,
  cell: DecisionCell,
  adapterName: string,
): AdapterCellResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DecisionAdapterError(`${adapterName} returned a malformed result for ${cell.cellId}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || !cell.dimension.labels.includes(record.label)) {
    throw new DecisionAdapterError(`${adapterName} returned a label outside dimension ${cell.dimension.name}`);
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new DecisionAdapterError(`${adapterName} returned an invalid confidence for ${cell.cellId}`);
  }
  if (record.scores === null || typeof record.scores !== "object" || Array.isArray(record.scores)) {
    throw new DecisionAdapterError(`${adapterName} returned malformed scores for ${cell.cellId}`);
  }
  const scores = record.scores as Record<string, number>;
  for (const label of cell.dimension.labels) {
    const score = scores[label];
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new DecisionAdapterError(`${adapterName} scores must cover every label with finite [0, 1] values for ${cell.cellId}`);
    }
  }
  for (const label of Object.keys(scores)) {
    if (!cell.dimension.labels.includes(label)) {
      throw new DecisionAdapterError(`${adapterName} scores contain an unknown label for ${cell.cellId}`);
    }
  }
  return { label: record.label, confidence: record.confidence, scores: { ...scores } };
}

export interface RuleAdapterRule {
  label: string;
  anyOf: string[];
  confidence?: number;
}

export interface RuleAdapterDimensions {
  [dimensionName: string]: RuleAdapterRule[];
}

/**
 * Deterministic offline adapter. Keyword rules decide or abstain without any
 * network, download, model, or provider. The first matching rule wins; when
 * nothing matches the cell abstains with reason no-rule-matched.
 */
export function createRuleAdapter(rules: RuleAdapterDimensions): DecisionAdapter {
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
    throw new DecisionValidationError("rule adapter rules must be a plain object");
  }
  return {
    name: "local-rule-adapter",
    async classifyCells(cells: DecisionCell[], _policy: DecisionPolicy): Promise<DecisionAdapterStatus> {
      const results: AdapterCellResult[] = cells.map((cell) => {
        const dimensionRules = rules[cell.dimension.name] ?? [];
        const haystack = cell.input.toLowerCase();
        for (const rule of dimensionRules) {
          if (!cell.dimension.labels.includes(rule.label)) {
            throw new DecisionAdapterError(`rule adapter label ${rule.label} is outside dimension ${cell.dimension.name}`);
          }
          const confidence = rule.confidence ?? 1;
          if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence <= 0 || confidence > 1) {
            throw new DecisionAdapterError(`rule adapter confidence for ${rule.label} must be in (0, 1]`);
          }
          const matched = rule.anyOf.some((keyword) => typeof keyword === "string" && keyword !== "" && haystack.includes(keyword.toLowerCase()));
          if (matched) {
            const rest = cell.dimension.labels.length > 1 ? (1 - confidence) / (cell.dimension.labels.length - 1) : 0;
            const scores: Record<string, number> = {};
            for (const label of cell.dimension.labels) scores[label] = label === rule.label ? confidence : rest;
            return { label: rule.label, confidence, scores };
          }
        }
        const uniform = 1 / cell.dimension.labels.length;
        const scores: Record<string, number> = {};
        for (const label of cell.dimension.labels) scores[label] = uniform;
        return { label: cell.dimension.labels[0], confidence: 0, scores };
      });
      return { status: "ok", value: results };
    },
  };
}

export interface JevAdapterOptions {
  classify?: (cells: DecisionCell[], policy: DecisionPolicy) => Promise<DecisionAdapterStatus>;
}

/**
 * Optional Jev-backed adapter seam. Without an explicitly configured
 * classify function it reports adapter-unavailable and never touches the
 * network. Configuring it never grants filesystem, document, or ambient
 * network authority beyond the explicit call the host supplies.
 */
export function createJevAdapter(options: JevAdapterOptions = {}): DecisionAdapter {
  return {
    name: "jev-adapter",
    async classifyCells(cells: DecisionCell[], policy: DecisionPolicy): Promise<DecisionAdapterStatus> {
      if (!options.classify) {
        return { status: "unavailable", reason: "Jev adapter is not configured" };
      }
      try {
        return await options.classify(cells, policy);
      } catch (error) {
        if (error instanceof DecisionUnavailableError) return { status: "unavailable", reason: error.message };
        throw error;
      }
    },
  };
}
