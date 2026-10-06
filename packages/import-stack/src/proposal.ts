import { ImportConflictError, ImportValidationError } from "./errors.ts";
import { isForbiddenImportTag, isSafeStoredUrlReference, PRESENTATION_URL_ATTRIBUTES, sanitizeImportedCssText, STORED_URL_ATTRIBUTES } from "./security.ts";
import {
  IMPORT_SCHEMA_VERSION,
  type AssetRecord,
  type ImportDiagnostic,
  type ImportNode,
  type ImportProposal,
  type ImportStylesheet,
  type ResourceReference,
} from "./types.ts";
import {
  assertAllowedKeys,
  assertBoundedString,
  assertPlainObject,
  assertSafeProvenanceUrl,
  normalizeImportPolicy,
  normalizeSourceBinding,
  normalizeSourceIdentity,
} from "./validation.ts";

const NODE_KINDS = new Set(["element", "text", "image", "vector", "media"]);
const RESOURCE_KINDS = new Set(["stylesheet", "image", "media", "link"]);
const SEVERITIES = new Set(["info", "warning", "error"]);

function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }

function normalizeNode(value: unknown, expectedId: string, policy: ImportProposal["policy"]): ImportNode {
  assertPlainObject(value, `import.nodes.${expectedId}`);
  assertAllowedKeys(value, ["id", "kind", "parentId", "children", "tag", "text", "attributes", "style", "sourceBinding"], `import.nodes.${expectedId}`);
  if (value.id !== expectedId) throw new ImportValidationError(`import node key ${expectedId} does not match node.id`);
  assertBoundedString(value.id, "import.node.id", 256);
  if (!NODE_KINDS.has(value.kind as string)) throw new ImportValidationError(`import node ${expectedId} has unsupported kind`);
  if (value.parentId !== null) assertBoundedString(value.parentId, `import.nodes.${expectedId}.parentId`, 256);
  if (!Array.isArray(value.children)) throw new ImportValidationError(`import.nodes.${expectedId}.children must be an array`);
  const children = value.children.map((child, index) => {
    assertBoundedString(child, `import.nodes.${expectedId}.children[${index}]`, 256);
    return child;
  });
  if (new Set(children).size !== children.length) throw new ImportValidationError(`import.nodes.${expectedId}.children contains duplicates`);
  if (value.tag !== undefined) {
    assertBoundedString(value.tag, `import.nodes.${expectedId}.tag`, 128);
    if (isForbiddenImportTag(value.tag as string)) {
      throw new ImportValidationError(`import.nodes.${expectedId}.tag is not allowed`);
    }
  }
  if (value.text !== undefined && typeof value.text !== "string") throw new ImportValidationError(`import.nodes.${expectedId}.text must be a string`);
  if (value.text !== undefined && bytes(value.text as string) > policy.maxTextBytes) throw new ImportValidationError(`import.nodes.${expectedId}.text exceeds policy`);
  assertPlainObject(value.attributes, `import.nodes.${expectedId}.attributes`);
  assertPlainObject(value.style, `import.nodes.${expectedId}.style`);
  if (Object.keys(value.attributes).length > policy.maxAttributesPerNode) throw new ImportValidationError(`import.nodes.${expectedId} exceeds attribute count policy`);
  const attributes: Record<string, string> = Object.create(null);
  let attributeBytes = 0;
  for (const key of Object.keys(value.attributes).sort()) {
    assertBoundedString(key, `import.nodes.${expectedId}.attribute key`, 256);
    const entry = value.attributes[key];
    if (typeof entry !== "string") throw new ImportValidationError(`import.nodes.${expectedId}.attributes.${key} must be a string`);
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("on") || normalizedKey === "srcdoc" || normalizedKey === "srcset" || normalizedKey === "action" || normalizedKey === "formaction") {
      throw new ImportValidationError(`import.nodes.${expectedId}.attributes.${key} carries executable or navigation authority`);
    }
    if (STORED_URL_ATTRIBUTES.has(normalizedKey) && !isSafeStoredUrlReference(entry)) {
      throw new ImportValidationError(`import.nodes.${expectedId}.attributes.${key} must not retain external fetch authority`);
    }
    if (PRESENTATION_URL_ATTRIBUTES.has(normalizedKey)) {
      const sanitized = sanitizeImportedCssText(
        entry,
        Math.min(policy.maxAttributeBytes, policy.maxCssBytes),
      );
      if (sanitized.unsafe) {
        throw new ImportValidationError(`import.nodes.${expectedId}.attributes.${key} must not retain presentation fetch authority`);
      }
    }
    attributeBytes += bytes(key) + bytes(entry);
    attributes[key] = entry;
  }
  if (attributeBytes > policy.maxAttributeBytes) throw new ImportValidationError(`import.nodes.${expectedId} exceeds attribute byte policy`);
  const style: Record<string, string> = Object.create(null);
  for (const key of Object.keys(value.style).sort()) {
    assertBoundedString(key, `import.nodes.${expectedId}.style key`, 256);
    if (key !== "cssText") throw new ImportValidationError(`import.nodes.${expectedId}.style.${key} is unsupported`);
    const entry = value.style[key];
    if (typeof entry !== "string") throw new ImportValidationError(`import.nodes.${expectedId}.style.${key} must be a string`);
    const sanitized = sanitizeImportedCssText(entry, policy.maxCssBytes);
    if (sanitized.unsafe || sanitized.cssText !== entry.trim()) {
      throw new ImportValidationError(`import.nodes.${expectedId}.style.${key} is unsafe or non-canonical`);
    }
    style[key] = sanitized.cssText;
  }
  return {
    id: expectedId,
    kind: value.kind as ImportNode["kind"],
    parentId: value.parentId as string | null,
    children,
    ...(value.tag === undefined ? {} : { tag: value.tag as string }),
    ...(value.text === undefined ? {} : { text: value.text as string }),
    attributes,
    style,
    ...(value.sourceBinding === undefined ? {} : { sourceBinding: normalizeSourceBinding(value.sourceBinding) }),
  };
}

function normalizeAsset(value: unknown): AssetRecord {
  assertPlainObject(value, "import.asset");
  assertAllowedKeys(value, ["assetId", "sha256", "byteLength", "mediaType", "logicalName", "sourceUri"], "import.asset");
  assertBoundedString(value.assetId, "import.asset.assetId", 256);
  assertBoundedString(value.sha256, "import.asset.sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(value.sha256 as string)) throw new ImportValidationError("import asset sha256 is invalid");
  if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) <= 0) throw new ImportValidationError("import asset byteLength is invalid");
  assertBoundedString(value.mediaType, "import.asset.mediaType", 256);
  if (value.logicalName !== undefined) assertBoundedString(value.logicalName, "import.asset.logicalName", 512);
  if (value.sourceUri !== undefined) {
    assertBoundedString(value.sourceUri, "import.asset.sourceUri", 4096);
    assertSafeProvenanceUrl(value.sourceUri as string, "import.asset.sourceUri");
  }
  return structuredClone(value) as AssetRecord;
}

function normalizeResource(value: unknown): ResourceReference {
  assertPlainObject(value, "import.resource");
  assertAllowedKeys(value, ["kind", "uri", "nodeId", "attribute"], "import.resource");
  if (!RESOURCE_KINDS.has(value.kind as string)) throw new ImportValidationError("import resource kind is invalid");
  assertBoundedString(value.uri, "import.resource.uri", 4096);
  assertSafeProvenanceUrl(value.uri as string, "import.resource.uri");
  if (value.nodeId !== undefined) assertBoundedString(value.nodeId, "import.resource.nodeId", 256);
  if (value.attribute !== undefined) {
    if (!["href", "src", "poster", "cite", "background", "xlink:href"].includes(value.attribute as string)) {
      throw new ImportValidationError("import resource attribute is invalid");
    }
    if (value.nodeId === undefined) throw new ImportValidationError("import resource attribute requires nodeId");
  }
  return structuredClone(value) as ResourceReference;
}

function normalizeStylesheet(value: unknown, policy: ImportProposal["policy"]): ImportStylesheet {
  assertPlainObject(value, "import.stylesheet");
  assertAllowedKeys(value, ["id", "cssText", "sourceBinding"], "import.stylesheet");
  assertBoundedString(value.id, "import.stylesheet.id", 256);
  if (typeof value.cssText !== "string") throw new ImportValidationError("import stylesheet cssText must be a string");
  const sanitized = sanitizeImportedCssText(value.cssText, policy.maxCssBytes);
  if (sanitized.unsafe || sanitized.cssText !== value.cssText.trim()) {
    throw new ImportValidationError("import stylesheet is unsafe or non-canonical");
  }
  return {
    id: value.id,
    cssText: sanitized.cssText,
    ...(value.sourceBinding === undefined ? {} : { sourceBinding: normalizeSourceBinding(value.sourceBinding) }),
  };
}

function normalizeDiagnostic(value: unknown): ImportDiagnostic {
  assertPlainObject(value, "import.diagnostic");
  assertAllowedKeys(value, ["code", "severity", "message", "nodeId", "sourceBinding"], "import.diagnostic");
  assertBoundedString(value.code, "import.diagnostic.code", 128);
  if (!SEVERITIES.has(value.severity as string)) throw new ImportValidationError("import diagnostic severity is invalid");
  assertBoundedString(value.message, "import.diagnostic.message", 2048);
  if (value.nodeId !== undefined) assertBoundedString(value.nodeId, "import.diagnostic.nodeId", 256);
  return {
    code: value.code,
    severity: value.severity as ImportDiagnostic["severity"],
    message: value.message,
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId as string }),
    ...(value.sourceBinding === undefined ? {} : { sourceBinding: normalizeSourceBinding(value.sourceBinding) }),
  };
}

export function validateImportProposal(proposal: ImportProposal): ImportProposal {
  assertPlainObject(proposal, "import.proposal");
  assertAllowedKeys(proposal, [
    "schemaVersion", "proposalId", "requestId", "actorId", "intent", "requestedAt",
    "inputSha256", "source", "policy", "rootIds", "nodes", "stylesheets", "assets",
    "resources", "diagnostics", "security",
  ], "import.proposal");
  if (proposal.schemaVersion !== IMPORT_SCHEMA_VERSION) throw new ImportValidationError("unsupported import proposal schema version");
  assertBoundedString(proposal.proposalId, "import.proposalId", 256);
  assertBoundedString(proposal.requestId, "import.requestId", 256);
  assertBoundedString(proposal.actorId, "import.actorId", 256);
  assertBoundedString(proposal.intent, "import.intent", 2048);
  assertBoundedString(proposal.requestedAt, "import.requestedAt", 128);
  assertBoundedString(proposal.inputSha256, "import.inputSha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(proposal.inputSha256)) throw new ImportValidationError("import.inputSha256 must be lowercase SHA-256");
  const source = normalizeSourceIdentity(proposal.source);
  const policy = normalizeImportPolicy(proposal.policy);
  if (!Array.isArray(proposal.rootIds) || proposal.rootIds.length === 0) throw new ImportValidationError("import.rootIds must be a non-empty array");
  const rootIds = proposal.rootIds.map((rootId, index) => {
    assertBoundedString(rootId, `import.rootIds[${index}]`, 256);
    return rootId;
  });
  if (new Set(rootIds).size !== rootIds.length) throw new ImportValidationError("import.rootIds contains duplicates");
  assertPlainObject(proposal.nodes, "import.nodes");
  const entries = Object.entries(proposal.nodes);
  if (entries.length === 0 || entries.length > policy.maxDomNodes) throw new ImportValidationError("import.nodes count is invalid");
  const nodes: Record<string, ImportNode> = Object.create(null);
  let totalTextBytes = 0;
  let totalCssBytes = 0;
  let totalSemanticBytes = 0;
  for (const [id, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const normalized = normalizeNode(value, id, policy);
    if (normalized.text) {
      const length = bytes(normalized.text);
      totalTextBytes += length;
      totalSemanticBytes += length;
    }
    for (const [key, entry] of Object.entries(normalized.attributes)) {
      totalSemanticBytes += bytes(key) + bytes(entry);
    }
    for (const entry of Object.values(normalized.style)) {
      const length = bytes(entry);
      totalCssBytes += length;
      totalSemanticBytes += length;
    }
    if (totalSemanticBytes > policy.maxTotalBytes) throw new ImportValidationError("import proposal semantic bytes exceed maxTotalBytes");
    nodes[id] = normalized;
  }
  if (totalTextBytes > policy.maxTextBytes) throw new ImportValidationError("import proposal text exceeds policy");
  if (totalCssBytes > policy.maxCssBytes) throw new ImportValidationError("import proposal CSS exceeds policy");

  const roots = new Set(rootIds);
  for (const rootId of rootIds) {
    if (!nodes[rootId]) throw new ImportValidationError(`import root ${rootId} is missing`);
    if (nodes[rootId].parentId !== null) throw new ImportValidationError(`import root ${rootId} must have parentId null`);
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === null && !roots.has(id)) throw new ImportValidationError(`unlisted import root ${id}`);
    if (node.parentId !== null) {
      const parent = nodes[node.parentId];
      if (!parent) throw new ImportValidationError(`import node ${id} references missing parent ${node.parentId}`);
      if (parent.children.filter((child) => child === id).length !== 1) throw new ImportValidationError(`import parent ${node.parentId} must reference child ${id} exactly once`);
    }
    for (const childId of node.children) {
      const child = nodes[childId];
      if (!child) throw new ImportValidationError(`import node ${id} references missing child ${childId}`);
      if (child.parentId !== id) throw new ImportValidationError(`import child ${childId} has inconsistent parentId`);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (depth > policy.maxDomDepth) throw new ImportValidationError("import graph exceeds maxDomDepth");
    if (visiting.has(id)) throw new ImportValidationError(`import graph cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of nodes[id].children) visit(child, depth + 1);
    visiting.delete(id);
    visited.add(id);
  };
  for (const rootId of rootIds) visit(rootId, 0);
  if (visited.size !== Object.keys(nodes).length) throw new ImportConflictError("import proposal contains unreachable nodes");

  if (!Array.isArray(proposal.stylesheets) || proposal.stylesheets.length > policy.maxAssets) throw new ImportValidationError("stylesheet collection is invalid");
  const stylesheets = proposal.stylesheets.map((entry) => normalizeStylesheet(entry, policy));
  if (new Set(stylesheets.map((entry) => entry.id)).size !== stylesheets.length) throw new ImportValidationError("stylesheet ids must be unique");
  for (const stylesheet of stylesheets) {
    const length = bytes(stylesheet.cssText);
    totalCssBytes += length;
    totalSemanticBytes += length;
  }
  if (totalCssBytes > policy.maxCssBytes) throw new ImportValidationError("import proposal CSS exceeds policy");
  if (totalSemanticBytes > policy.maxTotalBytes) throw new ImportValidationError("import proposal semantic bytes exceed maxTotalBytes");

  if (!Array.isArray(proposal.assets) || proposal.assets.length > policy.maxAssets) throw new ImportValidationError("asset collection is invalid");
  const assets = proposal.assets.map(normalizeAsset);
  let assetBytes = 0;
  for (const asset of assets) {
    if (asset.byteLength > policy.maxAssetBytes) throw new ImportValidationError("asset exceeds policy maxAssetBytes");
    assetBytes += asset.byteLength;
  }
  if (assetBytes > policy.maxTotalBytes) throw new ImportValidationError("asset bytes exceed policy maxTotalBytes");
  const assetHashes = new Set(assets.map((asset) => asset.sha256));
  for (const node of Object.values(nodes)) {
    for (const value of Object.values(node.attributes)) {
      const match = /^\.\/objects\/([a-f0-9]{64})$/u.exec(value);
      if (match && !assetHashes.has(match[1])) {
        throw new ImportValidationError(`import node ${node.id} references an unproven local asset`);
      }
    }
  }

  if (!Array.isArray(proposal.resources) || proposal.resources.length > policy.maxAssets) throw new ImportValidationError("resource collection is invalid");
  const resources = proposal.resources.map(normalizeResource);
  for (const resource of resources) {
    if (resource.nodeId !== undefined && !nodes[resource.nodeId]) {
      throw new ImportValidationError(`import resource references missing node ${resource.nodeId}`);
    }
    const match = /^\.\/objects\/([a-f0-9]{64})$/u.exec(resource.uri);
    if (match && !assetHashes.has(match[1])) {
      throw new ImportValidationError("import resource references an unproven local asset");
    }
  }
  if (!Array.isArray(proposal.diagnostics) || proposal.diagnostics.length > policy.maxDiagnostics) throw new ImportValidationError("diagnostic collection is invalid");
  const diagnostics = proposal.diagnostics.map(normalizeDiagnostic);

  assertPlainObject(proposal.security, "import.security");
  assertAllowedKeys(proposal.security, ["scriptsRemoved", "dangerousElementsRemoved", "eventHandlersRemoved", "dangerousUrlsRemoved", "unsafeStylesRemoved"], "import.security");
  for (const key of ["scriptsRemoved", "dangerousElementsRemoved", "eventHandlersRemoved", "dangerousUrlsRemoved", "unsafeStylesRemoved"]) {
    const value = proposal.security[key as keyof typeof proposal.security];
    if (!Number.isSafeInteger(value) || value < 0) throw new ImportValidationError(`import.security.${key} must be a non-negative safe integer`);
  }

  return {
    ...structuredClone(proposal),
    source,
    policy,
    rootIds,
    nodes,
    stylesheets,
    assets,
    resources,
    diagnostics,
    security: structuredClone(proposal.security),
  };
}

export function collectProposalSubtree(proposal: ImportProposal, rootId: string): ImportNode[] {
  const validated = validateImportProposal(proposal);
  if (!validated.rootIds.includes(rootId)) throw new ImportValidationError(`unknown import root ${rootId}`);
  const result: ImportNode[] = [];
  const walk = (id: string) => {
    const node = validated.nodes[id];
    result.push(structuredClone(node));
    for (const child of node.children) walk(child);
  };
  walk(rootId);
  return result;
}
