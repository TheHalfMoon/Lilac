import { randomUUID } from "node:crypto";
import { createHistoryState } from "@lilac/history";
import { IMPORT_SCHEMA_VERSION, commitImportProposal, defaultImportPolicy, importHtmlSnapshot, type ImportProposal } from "@lilac/import-stack";
import { inferSemantics, reviewImport } from "@lilac/intake";
import { StudioError } from "./errors.ts";

// Importing HTML into the open project (PC6, gate 10). The import stack parses and
// sanitizes the markup offline (no network: the policy is "offline", so nothing referenced
// is fetched); intake reviews the proposal; the person sees the review in the editor and
// decides. Committing turns the proposal into one history transaction, made by the
// session like any other edit (attributed, undoable, persisted): the imported layers go
// inside a new page frame, with ids that never collide with the document's, inline styles
// as style properties, and intake's observed semantics in their props.

export const MAX_IMPORT_HTML_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_IMPORTS = 4;
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface ImportReviewSummary {
  proposalId: string;
  name: string;
  commitReady: boolean;
  blockingReasons: string[];
  counts: { roots: number; nodes: number; byKind: Record<string, number>; stylesheets: number; resources: number };
  security: Record<string, number>;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  accessibilityFindings: number;
  notes: string[];
}

interface Pending {
  proposal: ImportProposal;
  name: string;
  review: ReturnType<typeof reviewImport>;
  expires: number;
}

const NAME = /^[^\u0000-\u001f<>]{1,120}$/u;

export class ImportDesk {
  #pending = new Map<string, Pending>();

  /** Parse and review `html`; the proposal waits for the person's decision. */
  prepare(input: { html: unknown; name: unknown }, actorId: string, at: string): ImportReviewSummary {
    if (typeof input?.html !== "string" || input.html.trim() === "") throw new StudioError(400, "invalid-import", "html must be a non-empty string");
    if (Buffer.byteLength(input.html) > MAX_IMPORT_HTML_BYTES) throw new StudioError(413, "import-too-large", "an HTML import is limited to 4 MiB");
    const name = typeof input.name === "string" && NAME.test(input.name.trim()) ? input.name.trim() : "Imported page";
    this.#prune();
    if (this.#pending.size >= MAX_PENDING_IMPORTS) throw new StudioError(409, "too-many-imports", "finish or discard the imports already waiting for review");
    let proposal: ImportProposal;
    try {
      proposal = importHtmlSnapshot({
        schemaVersion: IMPORT_SCHEMA_VERSION,
        requestId: `import-${randomUUID()}`,
        actorId,
        intent: `Import ${name}`,
        at,
        source: { kind: "html-snapshot" },
        policy: defaultImportPolicy("offline"),
      }, input.html);
    } catch (error) {
      // The import stack's refusals (limits, unparseable input) are fixed descriptions.
      const message = error instanceof Error ? error.message.slice(0, 300) : "the HTML could not be imported";
      throw new StudioError(422, "import-refused", message);
    }
    const review = reviewImport(proposal);
    this.#pending.set(proposal.proposalId, { proposal, name, review, expires: Date.now() + PENDING_TTL_MS });
    return summarize(proposal.proposalId, name, proposal, review);
  }

  /** The operations that put the reviewed proposal into `document`, consuming it. */
  take(proposalId: unknown, document: any, at: string): { operations: unknown[]; intent: string; frameId: string } {
    this.#prune();
    const pending = typeof proposalId === "string" ? this.#pending.get(proposalId) : undefined;
    if (pending === undefined) throw new StudioError(404, "import-not-found", "that import is no longer waiting; import the file again");
    if (!pending.review.commitReady) throw new StudioError(409, "import-not-ready", `this import cannot be committed: ${pending.review.blockingReasons.join("; ").slice(0, 300)}`);
    this.#pending.delete(proposalId as string);
    return { ...importOperations(document, pending.proposal, at), intent: `Import ${pending.name}`.slice(0, 500) };
  }

  discard(proposalId: unknown): void {
    if (typeof proposalId !== "string" || !this.#pending.delete(proposalId)) throw new StudioError(404, "import-not-found", "that import is no longer waiting");
  }

  clear(): void {
    this.#pending.clear();
  }

  #prune(): void {
    for (const [id, pending] of this.#pending) if (pending.expires < Date.now()) this.#pending.delete(id);
  }
}

function summarize(proposalId: string, name: string, proposal: ImportProposal, review: ReturnType<typeof reviewImport>): ImportReviewSummary {
  const notes: string[] = [];
  if (proposal.stylesheets.length > 0) notes.push(`${proposal.stylesheets.length} stylesheet${proposal.stylesheets.length === 1 ? " is" : "s are"} not carried into the design; inline styles are.`);
  if (proposal.resources.length > 0) notes.push(`${proposal.resources.length} linked resource${proposal.resources.length === 1 ? " is" : "s are"} not fetched: imports work offline.`);
  return {
    proposalId,
    name,
    commitReady: review.commitReady,
    blockingReasons: [...review.blockingReasons],
    counts: { roots: review.counts.roots, nodes: review.counts.nodes, byKind: { ...review.counts.byKind }, stylesheets: review.counts.stylesheets, resources: review.counts.resources },
    security: { ...(proposal.security as unknown as Record<string, number>) },
    diagnostics: proposal.diagnostics.slice(0, 20).map((diagnostic: any) => ({ severity: String(diagnostic.severity), code: String(diagnostic.code), message: String(diagnostic.message).slice(0, 300) })),
    accessibilityFindings: Array.isArray((review as any).accessibility?.findings) ? (review as any).accessibility.findings.length : 0,
    notes,
  };
}

/** `cssText` (an imported inline style) as style properties; the renderer re-checks every value. */
export function styleProperties(style: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (style === null || typeof style !== "object") return out;
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (key !== "cssText") {
      out[key] = value;
      continue;
    }
    for (const declaration of value.split(";")) {
      const at = declaration.indexOf(":");
      if (at <= 0) continue;
      const property = declaration.slice(0, at).trim().toLowerCase();
      const text = declaration.slice(at + 1).trim();
      if (/^-?[a-z][a-z0-9-]{0,63}$/u.test(property) && text !== "" && text.length <= 2000) out[property] = text;
    }
  }
  return out;
}

function importOperations(document: any, proposal: ImportProposal, at: string): { operations: unknown[]; frameId: string } {
  // import-stack's own transaction (one restore-subtree per root), computed on this document.
  const imported = commitImportProposal(createHistoryState(document), proposal, { transactionId: `tx-import-${randomUUID()}`, baseRevision: document.revision, at });
  const entry = (imported.history as any).past.at(-1);
  const semantics = new Map(inferSemantics(proposal).records.map(({ nodeId, ...props }: any) => [nodeId, props]));
  // Ids already in the document (an earlier import of the same page) get a fresh suffix.
  const taken = new Set(Object.keys(document.nodes));
  const suffix = randomUUID().slice(0, 8);
  const rename = new Map<string, string>();
  const idOf = (id: string) => {
    if (!taken.has(id)) return id;
    if (!rename.has(id)) rename.set(id, `${id}-${suffix}`);
    return rename.get(id)!;
  };
  const frameId = `page-import-${randomUUID().slice(0, 12)}`;
  const operations: unknown[] = [{
    type: "insert-node",
    node: { id: frameId, type: "frame", props: { tag: "main", name: proposal.intent.replace(/^Import /u, "").slice(0, 200), style: { position: "relative", width: "1024px", "min-height": "640px", background: "#ffffff" } } },
    parentId: null,
    index: document.rootIds.length,
  }];
  entry.transaction.operations.forEach((operation: any, index: number) => {
    operations.push({
      type: "restore-subtree",
      rootId: idOf(operation.rootId),
      parentId: frameId,
      index,
      nodes: operation.nodes.map((node: any) => ({
        ...node,
        id: idOf(node.id),
        parentId: node.parentId === null ? frameId : idOf(node.parentId),
        children: node.children.map(idOf),
        props: {
          ...node.props,
          style: styleProperties(node.props.style),
          ...(semantics.has(node.id) ? { semantics: semantics.get(node.id) } : {}),
        },
      })),
    });
  });
  return { operations, frameId };
}
