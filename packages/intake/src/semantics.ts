import { validateImportProposal, type ImportNode, type ImportProposal } from "@lilac/import-stack";
import { SEMANTIC_ROLES, type SemanticRecord, type SemanticReport, type SemanticRole } from "./types.ts";

const ROLE_SET: ReadonlySet<string> = new Set(SEMANTIC_ROLES);
const PRESENTATIONAL = new Set(["presentation", "none"]);
const TEXTBOX_INPUT_TYPES = new Set(["text", "email", "tel", "url"]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
// Types with their own semantics; any other (or invalid) type falls back to the Text state.
const KNOWN_INPUT_TYPES = new Set([
  "text", "email", "tel", "url", "search", "number", "password", "checkbox", "radio", "button", "submit", "reset",
  "image", "hidden", "file", "range", "color", "date", "datetime-local", "month", "time", "week",
]);
// header/footer are page landmarks only when not scoped inside sectioning content (HTML-AAM).
const SCOPING_TAGS = new Set(["article", "aside", "main", "nav", "section"]);
const SCOPING_ROLES = new Set(["main", "navigation", "complementary", "region"]);
// Valid ARIA roles intake does not record; when chosen they remove native semantics and
// scope header/footer.
const SCOPING_ARIA_TOKENS = new Set(["article"]);
const MAX_NAME_CODE_POINTS = 200;
// HTML attribute keywords and ARIA role tokens are ASCII case-insensitive and split on ASCII whitespace.
const ASCII_WHITESPACE = /[\t\n\f\r ]+/u;
const SIZE_PREFIX = /^[\t\n\f\r ]*\+?([0-9]+)/u;

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
// Accessible names are display text: format characters (bidi, zero-width, tags) are removed;
// controls, separators, and whitespace runs become a single space.
const FORMAT = /\p{Cf}/gu;
const BREAKING = /[\p{Cc}\p{Zl}\p{Zp}\s]+/gu;

type Native = { role: SemanticRole; source: string; level?: number } | null;

interface WalkContext {
  scoped: boolean;
  parentRole: SemanticRole | null;
}

function nativeRole(node: ImportNode, linkNodes: ReadonlySet<string>, context: WalkContext): Native {
  if (node.kind === "image" || node.tag === "img") {
    // An empty alt marks the image as decorative (presentational).
    if (node.attributes.alt === "") return null;
    return { role: "img", source: "tag:img" };
  }
  if (node.kind !== "element" || node.tag === undefined) return null;
  const tag = node.tag.toLowerCase();
  const heading = /^h([1-6])$/u.exec(tag);
  if (heading) return { role: "heading", source: `tag:${tag}`, level: Number(heading[1]) };
  switch (tag) {
    // Grain 6 moves href into resource records; an anchor is a link only when one exists for it.
    case "a": return linkNodes.has(node.id) ? { role: "link", source: "tag:a+href" } : null;
    case "button": return { role: "button", source: "tag:button" };
    case "nav": return { role: "navigation", source: "tag:nav" };
    case "main": return { role: "main", source: "tag:main" };
    case "aside": return { role: "complementary", source: "tag:aside" };
    case "header": return context.scoped ? null : { role: "banner", source: "tag:header" };
    case "footer": return context.scoped ? null : { role: "contentinfo", source: "tag:footer" };
    case "section":
      return node.attributes["aria-label"] || node.attributes["aria-labelledby"] ? { role: "region", source: "tag:section+label" } : null;
    case "ul":
    case "ol":
    case "menu": return { role: "list", source: `tag:${tag}` };
    case "li": return context.parentRole === "list" ? { role: "listitem", source: "tag:li" } : null;
    case "textarea": return { role: "textbox", source: "tag:textarea" };
    case "select": {
      if (Object.hasOwn(node.attributes, "multiple")) return { role: "listbox", source: "tag:select+multiple" };
      // HTML non-negative integer parsing: ASCII whitespace, an optional "+", then leading digits.
      const digits = SIZE_PREFIX.exec(node.attributes.size ?? "");
      return digits !== null && Number(digits[1]) > 1 ? { role: "listbox", source: "tag:select+size" } : { role: "combobox", source: "tag:select" };
    }
    case "dialog": return { role: "dialog", source: "tag:dialog" };
    case "input": {
      const declared = asciiLower(node.attributes.type ?? "text");
      if (!KNOWN_INPUT_TYPES.has(declared)) return { role: "textbox", source: "input-type:invalid" };
      const type = declared;
      if (type === "checkbox" || type === "radio") return { role: type, source: `input-type:${type}` };
      if (BUTTON_INPUT_TYPES.has(type)) return { role: "button", source: `input-type:${type}` };
      if (Object.hasOwn(node.attributes, "list") && (TEXTBOX_INPUT_TYPES.has(type) || type === "search")) {
        return { role: "combobox", source: `input-type:${type}+list` };
      }
      if (TEXTBOX_INPUT_TYPES.has(type)) return { role: "textbox", source: `input-type:${type}` };
      if (type === "search") return { role: "searchbox", source: "input-type:search" };
      if (type === "number") return { role: "spinbutton", source: "input-type:number" };
      // password and other types have no ARIA role.
      return null;
    }
    default: return null;
  }
}

function cleanName(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const visible = value.toWellFormed().replace(FORMAT, "").replace(BREAKING, " ").trim();
  if (visible === "") return undefined;
  return Array.from(visible).slice(0, MAX_NAME_CODE_POINTS).join("").trimEnd();
}

function headingLevel(node: ImportNode, fallback: number | undefined): number | undefined {
  const raw = node.attributes["aria-level"];
  const level = Number(raw);
  return raw !== undefined && Number.isInteger(level) && level >= 1 && level <= 6 ? level : fallback;
}

/**
 * Derive web semantics from markup only, walking the tree in document order so scoping and
 * list membership are known. Every record is OBSERVED evidence with its source. The first
 * allow-listed token of an ARIA role list overrides native semantics (recorded as an
 * override); presentational roles remove semantics, and `article` removes them while scoping
 * header/footer; unknown tokens are reported and never applied. Grain 6 removes <form> elements, so a form landmark can only come from an
 * explicit role="form".
 */
export function inferSemantics(proposalInput: ImportProposal): SemanticReport {
  const proposal = validateImportProposal(proposalInput);
  const linkNodes = new Set(
    proposal.resources
      .filter((resource) => resource.kind === "link" && (resource.attribute === "href" || resource.attribute === "xlink:href") && typeof resource.nodeId === "string")
      .map((resource) => resource.nodeId as string),
  );
  const records: SemanticRecord[] = [];
  const unknownRoles: SemanticReport["unknownRoles"] = [];
  const overrides: SemanticReport["overrides"] = [];
  const stack: Array<{ id: string; context: WalkContext }> = [...proposal.rootIds]
    .reverse()
    .map((id) => ({ id, context: { scoped: false, parentRole: null } }));
  const visited = new Set<string>();
  while (stack.length > 0) {
    const { id, context } = stack.pop() as { id: string; context: WalkContext };
    if (visited.has(id) || !Object.hasOwn(proposal.nodes, id)) continue;
    visited.add(id);
    const node = proposal.nodes[id];
    const native = nativeRole(node, linkNodes, context);
    let role: SemanticRole | null = native?.role ?? null;
    let source = native?.source ?? "";
    let level = native?.level;
    let ariaScopes = false;
    const ariaRaw = node.attributes.role;
    const tokens = typeof ariaRaw === "string" ? asciiLower(ariaRaw).split(ASCII_WHITESPACE).filter((token) => token !== "").slice(0, 8) : [];
    if (tokens.length > 0) {
      const chosen = tokens.find((token) => PRESENTATIONAL.has(token) || ROLE_SET.has(token) || SCOPING_ARIA_TOKENS.has(token));
      for (const token of tokens) {
        if (token === chosen) break;
        unknownRoles.push({ nodeId: id, role: token.slice(0, 64) });
      }
      if (chosen !== undefined && (PRESENTATIONAL.has(chosen) || SCOPING_ARIA_TOKENS.has(chosen))) {
        role = null;
        ariaScopes = SCOPING_ARIA_TOKENS.has(chosen);
      } else if (chosen !== undefined) {
        if (native && native.role !== chosen) overrides.push({ nodeId: id, native: native.role, aria: chosen as SemanticRole });
        role = chosen as SemanticRole;
        source = `aria-role:${chosen}`;
        // ARIA's default heading level is 2.
        level = chosen === "heading" ? headingLevel(node, native?.role === "heading" ? native.level : 2) : undefined;
      }
    } else if (role === "heading") {
      level = headingLevel(node, level);
    }
    if (role !== null) {
      const record: SemanticRecord = { nodeId: id, role, evidence: "OBSERVED", source };
      if (level !== undefined) record.level = level;
      const name = cleanName(node.attributes["aria-label"] ?? node.attributes.alt);
      if (name !== undefined) record.name = name;
      if (role === "img") record.hasAlt = Object.hasOwn(node.attributes, "alt");
      records.push(record);
    }
    const tag = node.tag?.toLowerCase();
    const childContext: WalkContext = {
      scoped: context.scoped || ariaScopes || (tag !== undefined && SCOPING_TAGS.has(tag)) || (role !== null && SCOPING_ROLES.has(role)),
      parentRole: role,
    };
    for (const child of [...node.children].reverse()) stack.push({ id: child, context: childContext });
  }
  records.sort((left, right) => Number(left.nodeId > right.nodeId) - Number(left.nodeId < right.nodeId));
  return { records, unknownRoles, overrides };
}
