import { parseFragment } from "parse5";
import { ImportSecurityError, ImportValidationError } from "./errors.ts";
import { FORM_AUTHORITY_ATTRIBUTES, isForbiddenImportTag, isSafeStoredUrlReference, PRESENTATION_URL_ATTRIBUTES, sanitizeImportedCssText } from "./security.ts";
import {
  IMPORT_SCHEMA_VERSION,
  type ImportDiagnostic,
  type ImportNode,
  type ImportProposal,
  type ImportRequest,
  type ImportSecuritySummary,
  type ImportStylesheet,
  type ResourceReference,
  type SourceBinding,
} from "./types.ts";
import {
  assertSafeProvenanceUrl,
  canonicalImportStringify,
  compareCodeUnits,
  normalizeImportRequest,
  sha256Text,
} from "./validation.ts";

const DROP_SUBTREE = new Set([
  "script", "iframe", "object", "embed", "applet", "frame", "frameset",
  "base", "template", "foreignobject", "animate", "animatemotion",
  "animatetransform", "set", "discard",
]);
const URL_ATTRIBUTES = new Set(["href", "src", "poster", "cite", "background", "xlink:href"]);
// SVG <use> and <feImage> fetch the referenced document as a subresource; they are
// images, not navigation links (a "link" resource would give the node a link role).
const RESOURCE_TAGS = new Map<string, "image" | "media" | "link">([
  ["img", "image"], ["image", "image"], ["use", "image"], ["feimage", "image"],
  ["video", "media"], ["audio", "media"], ["source", "media"], ["a", "link"],
]);

function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

function binding(request: ImportRequest, domPath: string, location?: { startOffset?: number; endOffset?: number }): SourceBinding {
  return {
    ...(request.source.uri === undefined ? {} : { sourceUri: request.source.uri }),
    ...(request.source.repositoryId === undefined ? {} : { repositoryId: request.source.repositoryId }),
    ...(request.source.repositoryPath === undefined ? {} : { path: request.source.repositoryPath }),
    domPath,
    ...(Number.isSafeInteger(location?.startOffset) ? { start: location!.startOffset } : {}),
    ...(Number.isSafeInteger(location?.endOffset) ? { end: location!.endOffset } : {}),
  };
}

function nodeId(proposalId: string, domPath: string): string {
  return `import-node:${sha256Text(`${proposalId}:${domPath}`).slice(0, 32)}`;
}

function styleId(proposalId: string, domPath: string): string {
  return `import-style:${sha256Text(`${proposalId}:${domPath}`).slice(0, 32)}`;
}

function baseUrlFor(request: ImportRequest): string | undefined {
  const candidate = request.source.baseUrl ?? request.source.uri;
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {}
  return undefined;
}

function safeUrl(raw: string, tag: string, attribute: string, baseUrl: string | undefined): string | null {
  const value = raw.trim();
  if (value === "" || value.length > 4096) return null;
  if (value.startsWith("#")) return isSafeStoredUrlReference(value) ? value : null;
  let resolved: string;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === "http" || scheme === "https") {
      try { resolved = new URL(value).href; } catch { return null; }
    } else if ((scheme === "mailto" || scheme === "tel") && tag === "a" && attribute === "href") {
      return value;
    } else {
      return null;
    }
  } else if (value.startsWith("//")) {
    if (!baseUrl) return null;
    try { resolved = new URL(value, baseUrl).href; } catch { return null; }
  } else if (baseUrl) {
    try { resolved = new URL(value, baseUrl).href; } catch { return null; }
  } else {
    return value;
  }
  try {
    const parsed = new URL(resolved);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    assertSafeProvenanceUrl(parsed.href, "imported URL");
    return parsed.href;
  } catch {
    return null;
  }
}

function elementKind(tag: string): ImportNode["kind"] {
  if (tag === "img") return "image";
  if (tag === "svg") return "vector";
  if (tag === "video" || tag === "audio") return "media";
  return "element";
}

function directText(node: any): string {
  return (node?.childNodes ?? node?.content?.childNodes ?? [])
    .filter((child: any) => child?.nodeName === "#text")
    .map((child: any) => String(child.value ?? ""))
    .join("");
}

export function importHtmlSnapshot(requestInput: ImportRequest, html: string): ImportProposal {
  const request = normalizeImportRequest(requestInput);
  if (!["html-snapshot", "local-app", "remote-url"].includes(request.source.kind)) {
    throw new ImportValidationError("HTML snapshot import requires an HTML-compatible source kind");
  }
  if (typeof html !== "string") throw new ImportValidationError("html snapshot must be a string");
  const htmlBytes = byteLength(html);
  if (htmlBytes === 0) throw new ImportValidationError("html snapshot must not be empty");
  if (htmlBytes > request.policy.maxHtmlBytes) throw new ImportSecurityError("html snapshot exceeds maxHtmlBytes");
  if (htmlBytes > request.policy.maxTotalBytes) throw new ImportSecurityError("html snapshot exceeds maxTotalBytes");

  const inputSha256 = sha256Text(html);
  const proposalId = `import-proposal:${sha256Text(canonicalImportStringify({
    requestId: request.requestId,
    inputSha256,
    source: request.source,
    policy: request.policy,
  })).slice(0, 32)}`;

  const fragment: any = parseFragment(html, { sourceCodeLocationInfo: true });
  const nodes: Record<string, ImportNode> = Object.create(null);
  const rootIds: string[] = [];
  const stylesheets: ImportStylesheet[] = [];
  const resources: ResourceReference[] = [];
  const diagnostics: ImportDiagnostic[] = [];
  const security: ImportSecuritySummary = {
    scriptsRemoved: 0,
    dangerousElementsRemoved: 0,
    eventHandlersRemoved: 0,
    dangerousUrlsRemoved: 0,
    unsafeStylesRemoved: 0,
  };
  const baseUrl = baseUrlFor(request);
  let visitedNodes = 0;
  let textBytes = 0;
  let cssBytes = 0;

  const diagnostic = (entry: ImportDiagnostic) => {
    if (diagnostics.length >= request.policy.maxDiagnostics) throw new ImportSecurityError("import diagnostics exceed maxDiagnostics");
    diagnostics.push(entry);
  };
  // Forbidden elements that are neutralized or dropped without a per-element
  // diagnostic are reported once per class after the walk, with the first
  // occurrence's node context, so the diagnostic count stays bounded.
  type SourceLocation = { startOffset?: number; endOffset?: number } | undefined;
  const removalClasses = new Map<"form" | "link" | "meta", { count: number; domPath: string; location: SourceLocation; nodeId?: string }>();
  const recordRemoval = (tag: "form" | "link" | "meta", domPath: string, location: SourceLocation, removedNodeId?: string) => {
    security.dangerousElementsRemoved += 1;
    const existing = removalClasses.get(tag);
    if (existing) existing.count += 1;
    else removalClasses.set(tag, { count: 1, domPath, location, ...(removedNodeId === undefined ? {} : { nodeId: removedNodeId }) });
  };
  const resource = (entry: ResourceReference) => {
    if (resources.length >= request.policy.maxAssets) throw new ImportSecurityError("resource references exceed maxAssets");
    resources.push(entry);
  };

  const walk = (node: any, parentId: string | null, domPath: string, depth: number): string | null => {
    if (depth > request.policy.maxDomDepth) throw new ImportSecurityError("DOM exceeds maxDomDepth");
    visitedNodes += 1;
    if (visitedNodes > request.policy.maxDomNodes) throw new ImportSecurityError("DOM exceeds maxDomNodes");
    if (node?.nodeName === "#comment" || node?.nodeName === "#documentType") return null;

    if (node?.nodeName === "#text") {
      const value = String(node.value ?? "");
      if (value.trim() === "") return null;
      textBytes += byteLength(value);
      if (textBytes > request.policy.maxTextBytes) throw new ImportSecurityError("text exceeds maxTextBytes");
      const id = nodeId(proposalId, domPath);
      nodes[id] = {
        id, kind: "text", parentId, children: [], text: value, attributes: {}, style: {},
        sourceBinding: binding(request, domPath, node.sourceCodeLocation),
      };
      return id;
    }

    const rawTag = String(node?.tagName ?? node?.nodeName ?? "").toLowerCase();
    if (!rawTag || rawTag === "#document-fragment") return null;
    if (
      DROP_SUBTREE.has(rawTag)
      || (isForbiddenImportTag(rawTag) && !["meta", "style", "link", "form"].includes(rawTag))
    ) {
      if (rawTag === "script") security.scriptsRemoved += 1;
      else security.dangerousElementsRemoved += 1;
      diagnostic({
        code: "executable-element-removed",
        severity: "warning",
        message: `Removed executable or privileged <${rawTag}> element`,
        sourceBinding: binding(request, domPath, node.sourceCodeLocation),
      });
      return null;
    }
    if (rawTag === "meta") {
      recordRemoval("meta", domPath, node.sourceCodeLocation);
      return null;
    }
    if (rawTag === "style") {
      const rawCss = directText(node);
      const sanitized = sanitizeImportedCssText(rawCss, request.policy.maxCssBytes);
      if (sanitized.unsafe) {
        security.unsafeStylesRemoved += 1;
        diagnostic({
          code: "unsafe-stylesheet-removed",
          severity: "warning",
          message: "Removed stylesheet containing executable or external-loading CSS",
          sourceBinding: binding(request, domPath, node.sourceCodeLocation),
        });
      }
      if (sanitized.cssText !== null && sanitized.cssText !== "") {
        cssBytes += byteLength(sanitized.cssText);
        if (cssBytes > request.policy.maxCssBytes) throw new ImportSecurityError("stylesheets exceed maxCssBytes");
        stylesheets.push({ id: styleId(proposalId, domPath), cssText: sanitized.cssText, sourceBinding: binding(request, domPath, node.sourceCodeLocation) });
      }
      return null;
    }

    const attrs = Array.isArray(node.attrs) ? node.attrs : [];
    if (attrs.length > request.policy.maxAttributesPerNode) throw new ImportSecurityError(`<${rawTag}> exceeds maxAttributesPerNode`);

    if (rawTag === "link") {
      const attrMap: Record<string, string> = Object.create(null);
      for (const attr of attrs) attrMap[String(attr.name).toLowerCase()] = String(attr.value ?? "");
      if ((attrMap.rel ?? "").toLowerCase().split(/\s+/u).includes("stylesheet") && attrMap.href) {
        const href = safeUrl(attrMap.href, rawTag, "href", baseUrl);
        if (href) resource({ kind: "stylesheet", uri: href });
        else security.dangerousUrlsRemoved += 1;
      } else {
        recordRemoval("link", domPath, node.sourceCodeLocation);
      }
      return null;
    }

    const tag = rawTag === "form" ? "div" : rawTag;
    const id = nodeId(proposalId, domPath);
    if (rawTag === "form") recordRemoval("form", domPath, node.sourceCodeLocation, id);
    const attributes: Record<string, string> = Object.create(null);
    const style: Record<string, string> = Object.create(null);
    let attributeBytes = 0;

    for (const attr of attrs) {
      const name = String(attr.name ?? "").toLowerCase();
      const rawValue = String(attr.value ?? "");
      attributeBytes += byteLength(name) + byteLength(rawValue);
      if (attributeBytes > request.policy.maxAttributeBytes) throw new ImportSecurityError(`<${rawTag}> attributes exceed maxAttributeBytes`);

      if (FORM_AUTHORITY_ATTRIBUTES.has(name)) {
        security.dangerousUrlsRemoved += 1;
        continue;
      }
      if (name.startsWith("on") || name === "srcdoc") {
        security.eventHandlersRemoved += 1;
        diagnostic({
          code: "executable-attribute-removed", severity: "warning",
          message: `Removed executable attribute ${name}`, nodeId: id,
          sourceBinding: binding(request, domPath, node.sourceCodeLocation),
        });
        continue;
      }
      if (name === "srcset") {
        security.dangerousUrlsRemoved += 1;
        diagnostic({
          code: "srcset-removed", severity: "info",
          message: "Removed srcset pending bounded candidate parsing", nodeId: id,
          sourceBinding: binding(request, domPath, node.sourceCodeLocation),
        });
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeImportedCssText(rawValue, request.policy.maxCssBytes);
        if (sanitized.unsafe) {
          security.unsafeStylesRemoved += 1;
          diagnostic({
            code: "unsafe-inline-style-removed", severity: "warning",
            message: "Removed inline style containing executable or external-loading CSS", nodeId: id,
            sourceBinding: binding(request, domPath, node.sourceCodeLocation),
          });
        }
        if (sanitized.cssText !== null && sanitized.cssText !== "") style.cssText = sanitized.cssText;
        continue;
      }
      if (PRESENTATION_URL_ATTRIBUTES.has(name)) {
        const sanitized = sanitizeImportedCssText(
          rawValue,
          Math.min(request.policy.maxAttributeBytes, request.policy.maxCssBytes),
        );
        if (sanitized.unsafe) {
          security.dangerousUrlsRemoved += 1;
          diagnostic({
            code: "presentation-url-removed",
            severity: "warning",
            message: `Removed presentation attribute ${name} containing URL or executable CSS authority`,
            nodeId: id,
            sourceBinding: binding(request, domPath, node.sourceCodeLocation),
          });
          continue;
        }
      }
      if (URL_ATTRIBUTES.has(name)) {
        const resolved = safeUrl(rawValue, rawTag, name, baseUrl);
        if (resolved === null) {
          security.dangerousUrlsRemoved += 1;
          diagnostic({
            code: "unsafe-url-removed", severity: "warning",
            message: `Removed unsafe URL attribute ${name}`, nodeId: id,
            sourceBinding: binding(request, domPath, node.sourceCodeLocation),
          });
          continue;
        }
        if (resolved.startsWith("#")) {
          attributes[name] = resolved;
          continue;
        }
        const kind = RESOURCE_TAGS.get(rawTag)
          ?? (["src", "poster", "background", "xlink:href"].includes(name) ? "image" : "link");
        resource({
          kind,
          uri: resolved,
          nodeId: id,
          attribute: name as ResourceReference["attribute"],
        });
        continue;
      }
      attributes[name] = rawValue;
    }

    const imported: ImportNode = {
      id,
      kind: elementKind(tag),
      parentId,
      children: [],
      tag,
      attributes: Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => compareCodeUnits(a, b))),
      style,
      sourceBinding: binding(request, domPath, node.sourceCodeLocation),
    };
    nodes[id] = imported;

    const children = node.content?.childNodes ?? node.childNodes ?? [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const childTag = child?.nodeName === "#text" ? "#text" : String(child?.tagName ?? child?.nodeName ?? "node").toLowerCase();
      const childId = walk(child, id, `${domPath}/${childTag}[${index + 1}]`, depth + 1);
      if (childId) imported.children.push(childId);
    }
    return id;
  };

  const roots = fragment.childNodes ?? [];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    const tag = root?.nodeName === "#text" ? "#text" : String(root?.tagName ?? root?.nodeName ?? "node").toLowerCase();
    const id = walk(root, null, `/${tag}[${index + 1}]`, 0);
    if (id) rootIds.push(id);
  }
  if (rootIds.length === 0) throw new ImportValidationError("HTML snapshot produced no importable semantic nodes");

  for (const tag of ["form", "link", "meta"] as const) {
    const entry = removalClasses.get(tag);
    if (!entry) continue;
    const plural = entry.count === 1 ? "" : "s";
    diagnostic(tag === "form"
      ? {
        code: "form-element-neutralized",
        severity: "warning",
        message: `Neutralized ${entry.count} <form> element${plural} into <div>; children kept, submission removed`,
        nodeId: entry.nodeId,
        sourceBinding: binding(request, entry.domPath, entry.location),
      }
      : {
        code: "forbidden-element-removed",
        severity: "info",
        message: `Removed ${entry.count} <${tag}> element${plural}`,
        sourceBinding: binding(request, entry.domPath, entry.location),
      });
  }

  const uniqueResources = [...new Map(
    resources
      .sort((a, b) => compareCodeUnits(`${a.kind}:${a.uri}:${a.nodeId ?? ""}:${a.attribute ?? ""}`, `${b.kind}:${b.uri}:${b.nodeId ?? ""}:${b.attribute ?? ""}`))
      .map((entry) => [`${entry.kind}:${entry.uri}:${entry.nodeId ?? ""}:${entry.attribute ?? ""}`, entry]),
  ).values()];

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
    rootIds,
    nodes: Object.fromEntries(Object.entries(nodes).sort(([a], [b]) => compareCodeUnits(a, b))),
    stylesheets: stylesheets.sort((a, b) => compareCodeUnits(a.id, b.id)),
    assets: [],
    resources: uniqueResources,
    diagnostics,
    security,
  };
}
