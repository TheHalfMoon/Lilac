import { commitTransaction } from "@ninerr/history";
import { ImportConflictError, ImportValidationError } from "./errors.ts";
import { collectProposalSubtree, validateImportProposal } from "./proposal.ts";
import type { ImportCommitResult, ImportNode, ImportProposal } from "./types.ts";
import { assertBoundedString, assertTimestamp } from "./validation.ts";

function documentType(node: ImportNode): string {
  switch (node.kind) {
    case "text": return "text";
    case "image": return "image";
    case "vector": return "vector";
    case "media": return "media";
    case "element": return "element";
  }
}

function documentNode(node: ImportNode) {
  return {
    id: node.id,
    type: documentType(node),
    parentId: node.parentId,
    children: [...node.children],
    props: {
      ...(node.tag === undefined ? {} : { tag: node.tag }),
      ...(node.text === undefined ? {} : { text: node.text }),
      attributes: structuredClone(node.attributes),
      style: structuredClone(node.style),
    },
    metadata: {
      ...(node.sourceBinding === undefined ? {} : { sourceBinding: structuredClone(node.sourceBinding) }),
    },
  };
}

export function commitImportProposal(
  history: any,
  proposalInput: ImportProposal,
  input: { transactionId: string; baseRevision: number; at: string },
): ImportCommitResult {
  const proposal = validateImportProposal(proposalInput);
  assertBoundedString(input.transactionId, "import.commit.transactionId", 256);
  assertTimestamp(input.at, "import.commit.at");
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new ImportValidationError("import.commit.baseRevision must be a non-negative safe integer");
  }
  if (history?.document?.revision !== input.baseRevision) {
    throw new ImportConflictError(
      `stale import commit: expected document revision ${input.baseRevision}, current revision ${String(history?.document?.revision)}`,
    );
  }

  const operations = proposal.rootIds.map((rootId) => ({
    type: "restore-subtree",
    rootId,
    parentId: null,
    nodes: collectProposalSubtree(proposal, rootId).map(documentNode),
  }));
  const transaction = {
    id: input.transactionId,
    actor: proposal.actorId,
    operations,
    baseRevision: input.baseRevision,
    intent: proposal.intent,
    tool: "@ninerr/import-stack",
    timestamp: input.at,
    metadata: {
      import: {
        requestId: proposal.requestId,
        proposalId: proposal.proposalId,
        inputSha256: proposal.inputSha256,
        sourceKind: proposal.source.kind,
        requestedAt: proposal.requestedAt,
      },
    },
  };

  const nextHistory = commitTransaction(history, transaction);
  const entry = nextHistory.past.at(-1);
  if (!entry || entry.transaction.id !== input.transactionId) {
    throw new ImportConflictError("history did not publish the expected import transaction");
  }
  return {
    history: nextHistory,
    transactionId: entry.transaction.id,
    documentRevision: nextHistory.document.revision,
    affectedNodeIds: [...entry.affectedNodeIds].sort(),
  };
}
