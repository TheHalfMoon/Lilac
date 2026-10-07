import { assertAdapterCellResult } from "./adapters.ts";
import { DecisionAdapterError, DecisionValidationError } from "./errors.ts";
import { createDecisionRequestLedger, recordDecisionRequest } from "./ledger.ts";
import {
  DECISION_SCHEMA_VERSION,
  type CellDecision,
  type DecisionAdapter,
  type DecisionCell,
  type DecisionPrecheck,
  type DecisionRecord,
  type DecisionRequest,
  type DecisionRequestLedger,
  type ReviewItem,
} from "./types.ts";
import {
  canonicalDecisionStringify,
  compareCodeUnits,
  dimensionsSha256,
  normalizeDecisionPrecheck,
  normalizeDecisionRequest,
  packDecisionCells,
  sha256Text,
} from "./validation.ts";

export interface RouteDecisionOptions {
  adapter: DecisionAdapter;
  prechecks?: unknown[];
  ledger?: DecisionRequestLedger;
}

export interface RouteDecisionResult {
  record: DecisionRecord;
  ledger: DecisionRequestLedger;
  reused: boolean;
}

function oneHotScores(labels: string[], label: string): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const entry of labels) scores[entry] = entry === label ? 1 : 0;
  return scores;
}

const MAX_ADAPTER_NAME = 128;
const MAX_ADAPTER_REASON = 1000;

// Only string reasons (or an Error's string message) are kept; anything else becomes a fixed
// placeholder, so records never depend on host-specific stringification and reading the
// reason can never throw.
function adapterReason(value: unknown): string {
  let text = "non-string adapter reason";
  try {
    const candidate = value instanceof Error ? value.message : value;
    if (typeof candidate === "string") text = candidate;
  } catch {
    text = "unprintable adapter reason";
  }
  return text.slice(0, MAX_ADAPTER_REASON).toWellFormed();
}

function uniformScores(labels: string[]): Record<string, number> {
  const scores: Record<string, number> = {};
  const uniform = 1 / labels.length;
  for (const entry of labels) scores[entry] = uniform;
  return scores;
}

export async function routeDecision(
  requestInput: DecisionRequest,
  options: RouteDecisionOptions,
): Promise<RouteDecisionResult> {
  const request = normalizeDecisionRequest(requestInput);
  if (!options || typeof options.adapter !== "object" || options.adapter === null) {
    throw new DecisionValidationError("routeDecision requires a decision adapter");
  }
  // Adapters are untrusted. Read their identity once, hand them clones of router state, and
  // read their outcome once as plain data, so nothing they do can change cells, indexes, or
  // the values that validation approved.
  const rawAdapter = options.adapter;
  let adapterName: unknown;
  let classify: unknown;
  try {
    adapterName = rawAdapter.name;
    classify = rawAdapter.classifyCells;
  } catch {
    throw new DecisionValidationError("decision adapter identity could not be read");
  }
  if (typeof adapterName !== "string" || adapterName.trim() === "" || adapterName.length > MAX_ADAPTER_NAME) {
    throw new DecisionValidationError(`decision adapter name must be a non-empty string of at most ${MAX_ADAPTER_NAME} characters`);
  }
  if (typeof classify !== "function") throw new DecisionValidationError("routeDecision requires a decision adapter");
  const adapter: DecisionAdapter = {
    name: adapterName,
    classifyCells: async (cells, policy) => {
      let outcome: unknown;
      try {
        outcome = await classify.call(rawAdapter, structuredClone(cells), structuredClone(policy));
      } catch (error) {
        // Every adapter throw, including adapter-made DecisionAdapterErrors, is re-issued by
        // the router with a bounded reason.
        throw new DecisionAdapterError(`${adapterName} threw: ${adapterReason(error)}`);
      }
      try {
        return structuredClone(outcome);
      } catch {
        throw new DecisionAdapterError(`${adapterName} returned a result that is not plain data`);
      }
    },
  };
  const prechecks = (options.prechecks ?? []).map((entry) => normalizeDecisionPrecheck(entry, request));
  const ledger = options.ledger ?? createDecisionRequestLedger();

  const batches = packDecisionCells(request);
  const forced = new Map<string, { decision: CellDecision; review: ReviewItem | null }>();
  let prechecksApplied = 0;

  const precheckFor = (cell: DecisionCell): DecisionPrecheck | undefined =>
    prechecks.find((entry) =>
      entry.itemIndex === cell.itemIndex
      && (entry.dimensionIndex === undefined || entry.dimensionIndex === cell.dimensionIndex));

  for (const batch of batches) {
    for (const cell of batch) {
      const precheck = precheckFor(cell);
      if (!precheck) continue;
      prechecksApplied += 1;
      if (precheck.verdict.kind === "label") {
        forced.set(cell.cellId, {
          decision: {
            cellId: cell.cellId,
            itemIndex: cell.itemIndex,
            dimensionIndex: cell.dimensionIndex,
            label: precheck.verdict.label,
            confidence: 1,
            scores: oneHotScores(cell.dimension.labels, precheck.verdict.label),
            abstained: false,
            abstainReason: null,
            adapter: "deterministic-precheck",
            precheckApplied: true,
          },
          review: null,
        });
      } else {
        forced.set(cell.cellId, {
          decision: {
            cellId: cell.cellId,
            itemIndex: cell.itemIndex,
            dimensionIndex: cell.dimensionIndex,
            label: null,
            confidence: null,
            scores: uniformScores(cell.dimension.labels),
            abstained: true,
            abstainReason: precheck.verdict.reason,
            adapter: "deterministic-precheck",
            precheckApplied: true,
          },
          review: {
            itemIndex: cell.itemIndex,
            dimensionIndex: cell.dimensionIndex,
            cellId: cell.cellId,
            reason: precheck.verdict.reason,
            threshold: request.policy.unsureBelow,
            confidence: null,
            requestId: request.requestId,
            at: request.at,
          },
        });
      }
    }
  }

  const openCells = batches.map((batch) => batch.filter((cell) => !forced.has(cell.cellId)));
  const decisions: CellDecision[] = [];
  const reviewQueue: ReviewItem[] = [];
  for (const entry of forced.values()) {
    decisions.push(entry.decision);
    if (entry.review) reviewQueue.push(entry.review);
  }

  for (const batch of openCells) {
    if (batch.length === 0) continue;
    let results;
    try {
      const outcome = await adapter.classifyCells(batch, request.policy);
      if (outcome === null || typeof outcome !== "object") {
        throw new DecisionAdapterError(`${adapter.name} returned a malformed outcome`);
      }
      if (outcome.status === "unavailable") {
        const reason = adapterReason(outcome.reason);
        for (const cell of batch) {
          decisions.push({
            cellId: cell.cellId,
            itemIndex: cell.itemIndex,
            dimensionIndex: cell.dimensionIndex,
            label: null,
            confidence: null,
            scores: uniformScores(cell.dimension.labels),
            abstained: true,
            abstainReason: `adapter-unavailable: ${reason}`,
            adapter: adapter.name,
            precheckApplied: false,
          });
          reviewQueue.push({
            itemIndex: cell.itemIndex,
            dimensionIndex: cell.dimensionIndex,
            cellId: cell.cellId,
            reason: `adapter-unavailable: ${reason}`,
            threshold: request.policy.unsureBelow,
            confidence: null,
            requestId: request.requestId,
            at: request.at,
          });
        }
        continue;
      }
      if (outcome.status === "failed") {
        throw new DecisionAdapterError(`${adapter.name} failed: ${adapterReason(outcome.reason)}`);
      }
      results = outcome.value;
    } catch (error) {
      if (error instanceof DecisionAdapterError) throw error;
      throw new DecisionAdapterError(`${adapter.name} threw: ${adapterReason(error)}`);
    }
    if (!Array.isArray(results) || results.length !== batch.length) {
      throw new DecisionAdapterError(`${adapter.name} must return one result per cell`);
    }
    batch.forEach((cell, index) => {
      const validated = assertAdapterCellResult(results[index], cell, adapter.name);
      if (validated.confidence < request.policy.unsureBelow) {
        decisions.push({
          cellId: cell.cellId,
          itemIndex: cell.itemIndex,
          dimensionIndex: cell.dimensionIndex,
          label: null,
          confidence: validated.confidence,
          scores: validated.scores,
          abstained: true,
          abstainReason: `below-threshold: confidence ${validated.confidence} is under ${request.policy.unsureBelow}`,
          adapter: adapter.name,
          precheckApplied: false,
        });
        reviewQueue.push({
          itemIndex: cell.itemIndex,
          dimensionIndex: cell.dimensionIndex,
          cellId: cell.cellId,
          reason: `below-threshold: confidence ${validated.confidence} is under ${request.policy.unsureBelow}`,
          threshold: request.policy.unsureBelow,
          confidence: validated.confidence,
          requestId: request.requestId,
          at: request.at,
        });
        return;
      }
      decisions.push({
        cellId: cell.cellId,
        itemIndex: cell.itemIndex,
        dimensionIndex: cell.dimensionIndex,
        label: validated.label,
        confidence: validated.confidence,
        scores: validated.scores,
        abstained: false,
        abstainReason: null,
        adapter: adapter.name,
        precheckApplied: false,
      });
    });
  }

  if (reviewQueue.length > request.policy.maxReviewItems) {
    throw new DecisionValidationError("decision review queue exceeds policy maxReviewItems");
  }
  decisions.sort((a, b) => compareCodeUnits(a.cellId, b.cellId));
  reviewQueue.sort((a, b) => compareCodeUnits(a.cellId, b.cellId));

  const record: DecisionRecord = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    recordId: `decision-record:${sha256Text(canonicalDecisionStringify({
      requestId: request.requestId,
      inputs: request.inputs,
      dimensions: request.dimensions,
      policy: request.policy,
      adapter: adapter.name,
      prechecks: prechecks.map((entry) => canonicalDecisionStringify(entry)),
    })).slice(0, 32)}`,
    requestId: request.requestId,
    actorId: request.actorId,
    intent: request.intent,
    at: request.at,
    dimensionsSha256: dimensionsSha256(request.dimensions),
    threshold: request.policy.unsureBelow,
    adapter: adapter.name,
    decisions,
    reviewQueue,
    prechecksApplied,
  };
  const { ledger: nextLedger, reused } = recordDecisionRequest(ledger, request, record.recordId);
  return { record, ledger: nextLedger, reused };
}
