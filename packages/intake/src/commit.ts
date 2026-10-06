import { createHistoryState } from "@lilac/history";
import { commitImportProposal, validateImportProposal, type ImportProposal } from "@lilac/import-stack";
import type { ProjectStore } from "@lilac/persistence";
import { IntakeNotReadyError, IntakeValidationError } from "./errors.ts";
import { reviewImport } from "./review.ts";
import { inferSemantics } from "./semantics.ts";
import type { IntakeCommitResult } from "./types.ts";

type HistoryEntry = { transaction: { id: string; operations: Array<Record<string, unknown>> } & Record<string, unknown> };

/** Read the caller's proposal exactly once into inert data, so review and commit see the same thing. */
function snapshotProposal(proposal: unknown): ImportProposal {
  let copy: unknown;
  try {
    copy = structuredClone(proposal);
  } catch {
    throw new IntakeValidationError("proposal must be plain data");
  }
  return validateImportProposal(copy as ImportProposal);
}

/**
 * Commit a reviewed proposal into a persisted project. The proposal is copied and validated
 * once; the review, the import transaction, and the semantics all use that single copy. The
 * document change is exactly the `@lilac/import-stack` history transaction (computed against
 * the store's current document and revision), annotated with OBSERVED semantics in node props,
 * then persisted through the store, which re-validates it through `@lilac/history`. Nothing is
 * written when the review is not commit-ready or the revision is stale.
 */
export function commitIntake(store: ProjectStore, proposalInput: ImportProposal, input: { transactionId: string; at: string }): IntakeCommitResult {
  if (store === null || typeof store !== "object" || typeof store.commit !== "function") {
    throw new IntakeValidationError("store must be an open @lilac/persistence project store");
  }
  if (input === null || typeof input !== "object") throw new IntakeValidationError("input must be an object");
  const proposal = snapshotProposal(proposalInput);
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
  const semantics = new Map(inferSemantics(proposal).records.map(({ nodeId, ...props }) => [nodeId, props]));
  let semanticNodes = 0;
  const operations = entry.transaction.operations.map((operation) => {
    if (operation.type !== "restore-subtree" || !Array.isArray(operation.nodes)) return operation;
    return {
      ...operation,
      nodes: (operation.nodes as Array<{ id: string; props: Record<string, unknown> }>).map((node) => {
        const props = semantics.get(node.id);
        if (!props) return node;
        semanticNodes += 1;
        return { ...node, props: { ...node.props, semantics: props } };
      }),
    };
  });
  const persisted = store.commit({ ...entry.transaction, operations });
  return { revision: persisted.revision, transactionId: persisted.transactionId, review, semanticNodes };
}
