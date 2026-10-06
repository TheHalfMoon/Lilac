import { createHistoryState } from "@lilac/history";
import { commitImportProposal, type ImportProposal } from "@lilac/import-stack";
import { IntakeNotReadyError, IntakeValidationError } from "./errors.ts";
import { reviewImport } from "./review.ts";
import { inferSemantics } from "./semantics.ts";
import type { IntakeCommitResult, SemanticRecord } from "./types.ts";

/** The part of a `@lilac/persistence` ProjectStore that intake uses. */
export interface IntakeTargetStore {
  readonly document: { revision: number } & Record<string, unknown>;
  readonly revision: number;
  commit(transaction: unknown): { revision: number; seq: number; transactionId: string };
}

type HistoryEntry = { transaction: { id: string; operations: Array<Record<string, unknown>> } & Record<string, unknown> };

function semanticProps(record: SemanticRecord): Record<string, unknown> {
  return {
    role: record.role,
    evidence: record.evidence,
    source: record.source,
    ...(record.level === undefined ? {} : { level: record.level }),
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.hasAlt === undefined ? {} : { hasAlt: record.hasAlt }),
  };
}

/**
 * Commit a reviewed proposal into a persisted project. The document change is exactly the
 * `@lilac/import-stack` history transaction (computed against the store's current document
 * and revision), annotated with OBSERVED semantics in node props, then persisted through the
 * store, which re-validates it through `@lilac/history`. Nothing is written when the review
 * is not commit-ready or the revision is stale.
 */
export function commitIntake(store: IntakeTargetStore, proposal: ImportProposal, input: { transactionId: string; at: string }): IntakeCommitResult {
  if (store === null || typeof store !== "object" || typeof store.commit !== "function") {
    throw new IntakeValidationError("store must be an open @lilac/persistence project store");
  }
  if (input === null || typeof input !== "object") throw new IntakeValidationError("input must be an object");
  const review = reviewImport(proposal);
  if (!review.commitReady) throw new IntakeNotReadyError(`import is not ready to commit: ${review.blockingReasons.join("; ")}`);
  const document = store.document;
  const imported = commitImportProposal(createHistoryState(document), proposal, {
    transactionId: input.transactionId,
    baseRevision: document.revision,
    at: input.at,
  });
  const entry = (imported.history as { past: HistoryEntry[] }).past.at(-1);
  if (!entry || entry.transaction.id !== imported.transactionId) {
    throw new IntakeValidationError("import-stack did not produce the expected transaction");
  }
  const semantics = new Map(inferSemantics(proposal).records.map((record) => [record.nodeId, record]));
  let semanticNodes = 0;
  const operations = entry.transaction.operations.map((operation) => {
    if (operation.type !== "restore-subtree" || !Array.isArray(operation.nodes)) return operation;
    return {
      ...operation,
      nodes: (operation.nodes as Array<{ id: string; props: Record<string, unknown> }>).map((node) => {
        const record = semantics.get(node.id);
        if (!record) return node;
        semanticNodes += 1;
        return { ...node, props: { ...node.props, semantics: semanticProps(record) } };
      }),
    };
  });
  const persisted = store.commit({ ...entry.transaction, operations });
  return { revision: persisted.revision, transactionId: persisted.transactionId, review, semanticNodes };
}
