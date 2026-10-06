import { validateImportProposal, type ImportNode, type ImportProposal } from "@lilac/import-stack";
import { SEMANTIC_ROLES, type SemanticRecord, type SemanticReport, type SemanticRole } from "./types.ts";

const ROLE_SET: ReadonlySet<string> = new Set(SEMANTIC_ROLES);
const PRESENTATIONAL = new Set(["presentation", "none"]);
const TEXTBOX_INPUT_TYPES = new Set(["text", "email", "search", "tel", "url", "password", "number"]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
const MAX_NAME_LENGTH = 200;

const TAG_ROLES: Readonly<Record<string, SemanticRole>> = {
  button: "button",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  ul: "list",
  ol: "list",
  li: "listitem",
  textarea: "textbox",
  select: "combobox",
  dialog: "dialog",
};

function nativeRole(node: ImportNode, linkNodes: ReadonlySet<string>): { role: SemanticRole; source: string; level?: number } | null {
  if (node.kind === "image" || node.tag === "img") return { role: "img", source: "tag:img" };
  if (node.kind !== "element" || node.tag === undefined) return null;
  const tag = node.tag.toLowerCase();
  const heading = /^h([1-6])$/u.exec(tag);
  if (heading) return { role: "heading", source: `tag:${tag}`, level: Number(heading[1]) };
  // Grain 6 moves href into resource records; an anchor is a link only when one exists for it.
  if (tag === "a") return linkNodes.has(node.id) ? { role: "link", source: "tag:a+href" } : null;
  if (tag === "input") {
    const type = (node.attributes.type ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return { role: type, source: `input-type:${type}` };
    if (BUTTON_INPUT_TYPES.has(type)) return { role: "button", source: `input-type:${type}` };
    if (TEXTBOX_INPUT_TYPES.has(type)) return { role: "textbox", source: `input-type:${type}` };
    return null;
  }
  // A section is a region only when it is labelled.
  if (tag === "section") {
    return node.attributes["aria-label"] || node.attributes["aria-labelledby"] ? { role: "region", source: "tag:section+label" } : null;
  }
  const role = Object.hasOwn(TAG_ROLES, tag) ? TAG_ROLES[tag] : undefined;
  return role ? { role, source: `tag:${tag}` } : null;
}

function accessibleName(node: ImportNode): string | undefined {
  const label = node.attributes["aria-label"] ?? node.attributes.alt;
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_NAME_LENGTH);
}

/**
 * Derive web semantics from markup only. Every record is OBSERVED evidence with its source;
 * allow-listed ARIA roles override native semantics (recorded), presentational roles remove
 * them, and unknown roles are reported but never applied. Note: Grain 6 sanitization removes
 * <form> elements, so a form landmark can only come from an explicit role="form".
 */
export function inferSemantics(proposalInput: ImportProposal): SemanticReport {
  const proposal = validateImportProposal(proposalInput);
  const linkNodes = new Set(
    proposal.resources
      .filter((resource) => resource.kind === "link" && resource.attribute === "href" && typeof resource.nodeId === "string")
      .map((resource) => resource.nodeId as string),
  );
  const records: SemanticRecord[] = [];
  const unknownRoles: SemanticReport["unknownRoles"] = [];
  const overrides: SemanticReport["overrides"] = [];
  for (const id of Object.keys(proposal.nodes).sort()) {
    const node = proposal.nodes[id];
    const native = nativeRole(node, linkNodes);
    const ariaRaw = node.attributes.role;
    let role = native?.role ?? null;
    let source = native?.source ?? "";
    let level = native?.level;
    if (typeof ariaRaw === "string" && ariaRaw.trim() !== "") {
      // ARIA allows a space-separated fallback list; the first token is the requested role.
      const aria = ariaRaw.trim().toLowerCase().split(/\s+/u)[0];
      if (PRESENTATIONAL.has(aria)) {
        role = null;
      } else if (ROLE_SET.has(aria)) {
        if (native && native.role !== aria) overrides.push({ nodeId: id, native: native.role, aria: aria as SemanticRole });
        role = aria as SemanticRole;
        source = `aria-role:${aria}`;
        if (aria === "heading") {
          const ariaLevel = Number(node.attributes["aria-level"]);
          level = Number.isInteger(ariaLevel) && ariaLevel >= 1 && ariaLevel <= 6 ? ariaLevel : native?.role === "heading" ? native.level : undefined;
        } else {
          level = undefined;
        }
      } else {
        unknownRoles.push({ nodeId: id, role: aria.slice(0, 64) });
      }
    }
    if (role === null) continue;
    const record: SemanticRecord = { nodeId: id, role, evidence: "OBSERVED", source };
    if (level !== undefined) record.level = level;
    const name = accessibleName(node);
    if (name !== undefined) record.name = name;
    if (role === "img") record.hasAlt = Object.hasOwn(node.attributes, "alt");
    records.push(record);
  }
  return { records, unknownRoles, overrides };
}
