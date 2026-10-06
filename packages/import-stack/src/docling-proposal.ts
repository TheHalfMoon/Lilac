import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import {
  IMPORT_SCHEMA_VERSION,
  type DocumentAdapterOutput,
  type ImportNode,
  type ImportProposal,
  type ImportRequest,
  type SourceBinding,
} from "./types.ts";
import { canonicalImportStringify, normalizeImportJson, normalizeImportRequest, sha256Text } from "./validation.ts";

function binding(request: ImportRequest, ref: string): SourceBinding {
  return {
    ...(request.source.uri === undefined ? {} : { sourceUri: request.source.uri }),
    ...(request.source.repositoryId === undefined ? {} : { repositoryId: request.source.repositoryId }),
    ...(request.source.repositoryPath === undefined ? {} : { path: request.source.repositoryPath }),
    domPath: ref,
  };
}

function textFromItem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

export function proposalFromDoclingOutput(
  requestInput: ImportRequest,
  outputInput: DocumentAdapterOutput,
): ImportProposal {
  const request = normalizeImportRequest(requestInput);
  if (request.source.kind !== "document") throw new ImportValidationError("Docling proposal requires document source kind");
  if (outputInput.format !== "docling-json") throw new ImportValidationError("unsupported document adapter output format");
  const normalized = normalizeImportJson(outputInput.document, "Docling proposal input");
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) throw new ImportValidationError("Docling proposal input must be an object");
  const object = normalized as Record<string, unknown>;
  if (object.schema_name !== "DoclingDocument" || !Array.isArray(object.texts)) throw new ImportValidationError("Docling proposal input schema is invalid");
  const inputSha256 = sha256Text(canonicalImportStringify(normalized));
  const proposalId = `import-proposal:${sha256Text(canonicalImportStringify({
    requestId: request.requestId,
    inputSha256,
    source: request.source,
    policy: request.policy,
    adapter: "docling",
  })).slice(0, 32)}`;
  const rootId = `import-node:${sha256Text(`${proposalId}:root`).slice(0, 32)}`;
  const nodes: Record<string, ImportNode> = Object.create(null);
  const root: ImportNode = {
    id: rootId,
    kind: "element",
    parentId: null,
    children: [],
    tag: "article",
    attributes: { "data-import-adapter": "docling" },
    style: {},
    sourceBinding: binding(request, "docling:document"),
  };
  nodes[rootId] = root;
  let totalTextBytes = 0;
  let ordinal = 0;
  for (const item of object.texts) {
    const text = textFromItem(item);
    if (text === null) continue;
    totalTextBytes += Buffer.byteLength(text, "utf8");
    if (totalTextBytes > request.policy.maxTextBytes) throw new ImportSecurityError("Docling proposal text exceeds maxTextBytes");
    ordinal += 1;
    if (ordinal + 1 > request.policy.maxDomNodes) throw new ImportSecurityError("Docling proposal nodes exceed maxDomNodes");
    const id = `import-node:${sha256Text(`${proposalId}:text:${ordinal}`).slice(0, 32)}`;
    nodes[id] = {
      id,
      kind: "text",
      parentId: rootId,
      children: [],
      text,
      attributes: {},
      style: {},
      sourceBinding: binding(request, `docling:text[${ordinal}]`),
    };
    root.children.push(id);
  }
  if (root.children.length === 0) throw new ImportValidationError("Docling output contains no importable text");
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    proposalId,
    requestId: request.requestId,
    actorId: request.actorId,
    intent: request.intent,
    requestedAt: request.at,
    inputSha256,
    source: request.source,
    policy: request.policy,
    rootIds: [rootId],
    nodes,
    stylesheets: [],
    assets: [],
    resources: [],
    diagnostics: [{
      code: "docling-local-conversion",
      severity: "info",
      message: `Converted ${root.children.length} bounded text records from local Docling output`,
      sourceBinding: binding(request, "docling:document"),
    }],
    security: {
      scriptsRemoved: 0,
      dangerousElementsRemoved: 0,
      eventHandlersRemoved: 0,
      dangerousUrlsRemoved: 0,
      unsafeStylesRemoved: 0,
    },
  };
}
