import { validateImportProposal, type ImportProposal } from "@lilac/import-stack";
import { inferSemantics } from "./semantics.ts";
import type { ImportReview, SemanticRole } from "./types.ts";

const MAX_REVIEW_ITEMS = 200;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * Summarize a proposal for review before commit. Deterministic; reads only the validated
 * proposal. Any error diagnostic blocks the commit, and every blocking reason is listed.
 *
 * The review is advisory: diagnostics and the security summary are fields carried by the
 * proposal, so a tampered proposal can hide them. The integrity guarantee is that
 * `@lilac/import-stack` re-validates every node's content (tags, attributes, URLs, styles)
 * when the proposal is committed.
 */
export function reviewImport(proposalInput: ImportProposal): ImportReview {
  const proposal = validateImportProposal(proposalInput);
  const nodes = Object.values(proposal.nodes);
  const byKind: Record<string, number> = {};
  for (const node of nodes) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  const elements = nodes.filter((node) => node.kind === "element");
  const sortedDiagnostics = [...proposal.diagnostics].sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || Number(left.code > right.code) - Number(left.code < right.code)
    || Number((left.nodeId ?? "") > (right.nodeId ?? "")) - Number((left.nodeId ?? "") < (right.nodeId ?? "")));
  const severityCount = (severity: string): number => proposal.diagnostics.filter((entry) => entry.severity === severity).length;
  const semantics = inferSemantics(proposal);
  const byRole: Partial<Record<SemanticRole, number>> = {};
  for (const record of semantics.records) byRole[record.role] = (byRole[record.role] ?? 0) + 1;
  const errors = severityCount("error");
  const blockingReasons = errors > 0 ? [`${errors} error diagnostic${errors === 1 ? "" : "s"}`] : [];
  if (proposal.rootIds.length === 0) blockingReasons.push("the proposal has no root nodes");
  return {
    proposalId: proposal.proposalId,
    inputSha256: proposal.inputSha256,
    source: { kind: proposal.source.kind, uri: proposal.source.uri ?? null },
    counts: {
      roots: proposal.rootIds.length,
      nodes: nodes.length,
      byKind: Object.fromEntries(Object.entries(byKind).sort(([left], [right]) => Number(left > right) - Number(left < right))),
      assets: proposal.assets.length,
      assetBytes: proposal.assets.reduce((sum, asset) => sum + asset.byteLength, 0),
      resources: proposal.resources.length,
      stylesheets: proposal.stylesheets.length,
    },
    security: { ...proposal.security },
    diagnostics: {
      error: errors,
      warning: severityCount("warning"),
      info: severityCount("info"),
      items: sortedDiagnostics.slice(0, MAX_REVIEW_ITEMS).map((entry) => ({ code: entry.code, severity: entry.severity, message: entry.message, nodeId: entry.nodeId ?? null })),
      truncated: Math.max(0, sortedDiagnostics.length - MAX_REVIEW_ITEMS),
    },
    sourceBindings: { bound: elements.filter((node) => node.sourceBinding !== undefined).length, elements: elements.length },
    semantics: { byRole, unknownRoles: semantics.unknownRoles.length, overrides: semantics.overrides.length },
    commitReady: blockingReasons.length === 0,
    blockingReasons,
  };
}
