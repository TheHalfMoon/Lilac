// Lilac-owned accessibility audit of generated and imported output.
// Input is a neutral tree, so code-ir design documents and import proposals
// are both audited by the same deterministic rules; adapters below build it.

import { DesignAssuranceError } from "./errors.mjs";
import { compareCodeUnits } from "./order.mjs";

export const ACCESSIBILITY_LIMITS = Object.freeze({ maxDepth: 256, maxNodes: 100_000 });

export const ACCESSIBILITY_RULES = Object.freeze({
  "a11y/image-alt": { wcag: "1.1.1", severity: "major" },
  "a11y/control-label": { wcag: "1.3.1, 4.1.2", severity: "major" },
  "a11y/button-name": { wcag: "4.1.2", severity: "major" },
  "a11y/link-name": { wcag: "2.4.4", severity: "major" },
  "a11y/heading-order": { wcag: "1.3.1", severity: "minor" },
  "a11y/text-contrast": { wcag: "1.4.3", severity: "major" },
});

const UNLABELLED_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image"]);
const BUTTON_INPUT_TYPES = new Set(["submit", "reset", "button"]);

function attribute(node, name) {
  const value = Object.hasOwn(node.attributes, name) ? node.attributes[name] : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function lowerTag(node) {
  return node.tag.toLowerCase();
}

function role(node) {
  return (attribute(node, "role") ?? "").trim().toLowerCase().split(/\s+/u)[0] ?? "";
}

function inputType(node) {
  return (attribute(node, "type") ?? "text").trim().toLowerCase();
}

const FORM_CONTROLS = new Set(["input", "select", "textarea"]);

function isHidden(node) {
  return attribute(node, "aria-hidden") === "true" || attribute(node, "hidden") !== undefined;
}

// Text a node contributes to an ancestor's name: its own text, image alt text,
// and descendants'. Hidden subtrees and nested form controls (whose option or
// value text is not a label) contribute nothing.
function contentText(node) {
  const parts = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== node && (isHidden(current) || FORM_CONTROLS.has(lowerTag(current)))) continue;
    if (current.text !== undefined) parts.push(current.text);
    if (lowerTag(current) === "img" && present(attribute(current, "alt"))) parts.push(attribute(current, "alt"));
    for (let index = current.children.length - 1; index >= 0; index -= 1) stack.push(current.children[index]);
  }
  return parts.join(" ");
}

// Text of the elements aria-labelledby references; empty when none resolve.
function labelledByText(node, context) {
  const labelledBy = attribute(node, "aria-labelledby");
  if (!present(labelledBy)) return "";
  return labelledBy.trim().split(/\s+/u).map((id) => context.byId.get(id)).filter(Boolean).map((target) => contentText(target)).join(" ");
}

function accessibleName(node, context) {
  const labelledBy = labelledByText(node, context);
  if (present(labelledBy)) return labelledBy;
  if (present(attribute(node, "aria-label"))) return attribute(node, "aria-label");
  const tag = lowerTag(node);
  if ((tag === "img" || (tag === "input" && inputType(node) === "image")) && attribute(node, "alt") !== undefined) {
    return attribute(node, "alt");
  }
  if (tag === "input" && BUTTON_INPUT_TYPES.has(inputType(node)) && present(attribute(node, "value"))) {
    return attribute(node, "value");
  }
  const content = contentText(node);
  if (present(content)) return content;
  if (present(attribute(node, "title"))) return attribute(node, "title");
  return "";
}

// ---- Colour and contrast -------------------------------------------------

const NAMED_COLORS = { black: [0, 0, 0], white: [255, 255, 255] };

function parseDeclarations(style) {
  const declarations = Object.create(null);
  if (typeof style !== "string") return declarations;
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim().toLowerCase();
    if (name !== "" && value !== "") declarations[name] = value;
  }
  return declarations;
}

/** Parse an opaque colour; translucent or unsupported values return null (never guessed). */
export function parseOpaqueColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (Object.hasOwn(NAMED_COLORS, text)) return NAMED_COLORS[text];
  let match = /^#([0-9a-f]{3})$/u.exec(text);
  if (match) return [...match[1]].map((digit) => Number.parseInt(digit + digit, 16));
  match = /^#([0-9a-f]{6})$/u.exec(text);
  if (match) return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
  match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(text);
  if (match) {
    if (match[4] !== undefined && Number(match[4]) !== 1) return null;
    const channels = match.slice(1, 4).map(Number);
    return channels.every((channel) => channel <= 255) ? channels : null;
  }
  return null;
}

function relativeLuminance([red, green, blue]) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** WCAG 2.x contrast ratio between two opaque colours, from 1 to 21. */
export function contrastRatio(foreground, background) {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function backgroundOf(declarations) {
  if (declarations["background-color"] !== undefined) return declarations["background-color"];
  return declarations.background;
}

// color, font-size and font-weight inherit; the nearest declaration wins.
function inherited(entry, name) {
  for (let cursor = entry; cursor; cursor = cursor.parent) {
    if (cursor.declarations[name] !== undefined) return cursor.declarations[name];
  }
  return undefined;
}

function isLargeText(entry) {
  const size = /^([\d.]+)px$/u.exec(inherited(entry, "font-size") ?? "");
  if (!size) return false;
  const pixels = Number(size[1]);
  const weightValue = inherited(entry, "font-weight");
  const weight = weightValue === "bold" ? 700 : Number(weightValue ?? 400);
  return pixels >= 24 || (pixels >= 18.66 && weight >= 700);
}

// ---- Audit ---------------------------------------------------------------

function assertTree(tree) {
  if (tree === null || typeof tree !== "object") throw new DesignAssuranceError("accessibility tree must be an object");
  let count = 0;
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    count += 1;
    if (count > ACCESSIBILITY_LIMITS.maxNodes) throw new DesignAssuranceError(`accessibility tree exceeds ${ACCESSIBILITY_LIMITS.maxNodes} nodes`);
    if (depth > ACCESSIBILITY_LIMITS.maxDepth) throw new DesignAssuranceError(`accessibility tree exceeds depth ${ACCESSIBILITY_LIMITS.maxDepth}`);
    if (node === null || typeof node !== "object" || typeof node.tag !== "string" || node.tag === "") {
      throw new DesignAssuranceError("accessibility tree nodes need a non-empty tag");
    }
    if (node.attributes === null || typeof node.attributes !== "object" || Array.isArray(node.attributes)) {
      throw new DesignAssuranceError("accessibility tree node attributes must be a record");
    }
    if (!Array.isArray(node.children)) throw new DesignAssuranceError("accessibility tree node children must be an array");
    if (node.text !== undefined && typeof node.text !== "string") throw new DesignAssuranceError("accessibility tree node text must be a string");
    for (const child of node.children) stack.push([child, depth + 1]);
  }
}

/**
 * Audit a neutral tree ({ id?, tag, attributes, text?, style?, children }) for
 * missing image alternatives, unlabelled controls, unnamed buttons and links,
 * skipped heading levels, and insufficient text contrast where colours resolve.
 */
export function auditAccessibility(tree) {
  assertTree(tree);
  const entries = [];
  const byId = new Map();
  const walk = [[tree, `/${tree.tag}[1]`, null]];
  while (walk.length > 0) {
    const [node, path, parent] = walk.pop();
    const entry = { node, path, parent, declarations: parseDeclarations(node.style) };
    entries.push(entry);
    const id = attribute(node, "id");
    if (present(id) && !byId.has(id)) byId.set(id, node);
    const counts = new Map();
    const children = node.children.map((child) => {
      const index = (counts.get(child.tag) ?? 0) + 1;
      counts.set(child.tag, index);
      return [child, `${path}/${child.tag}[${index}]`, entry];
    });
    for (let index = children.length - 1; index >= 0; index -= 1) walk.push(children[index]);
  }

  const labelFor = new Map();
  for (const { node } of entries) {
    const target = attribute(node, "htmlFor") ?? attribute(node, "for");
    if (lowerTag(node) === "label" && present(target) && present(contentText(node))) labelFor.set(target.trim(), true);
  }
  const context = { byId };
  const findings = [];
  const report = (ruleId, entry, message) => {
    findings.push({
      ruleId,
      wcag: ACCESSIBILITY_RULES[ruleId].wcag,
      severity: ACCESSIBILITY_RULES[ruleId].severity,
      path: entry.path,
      ...(entry.node.id === undefined ? {} : { nodeId: String(entry.node.id) }),
      message,
    });
  };

  let previousHeading = null;
  for (const entry of entries) {
    const { node } = entry;
    const tag = lowerTag(node);
    const nodeRole = role(node);

    if (tag === "img" && attribute(node, "alt") === undefined && nodeRole !== "presentation" && nodeRole !== "none") {
      report("a11y/image-alt", entry, "Image has no alt attribute; use alt=\"\" if it is decorative");
    }
    if (tag === "input" && inputType(node) === "image" && !present(attribute(node, "alt"))) {
      report("a11y/image-alt", entry, "Image button has no alt text");
    }

    const isControl = (tag === "input" && !UNLABELLED_INPUT_TYPES.has(inputType(node))) || tag === "select" || tag === "textarea";
    if (isControl) {
      const id = attribute(node, "id");
      let ancestorLabel = false;
      for (let cursor = entry.parent; cursor; cursor = cursor.parent) {
        if (lowerTag(cursor.node) === "label" && present(contentText(cursor.node))) ancestorLabel = true;
      }
      const labelled = present(attribute(node, "aria-label"))
        || present(labelledByText(node, context))
        || (present(id) && labelFor.has(id.trim()))
        || ancestorLabel
        || present(attribute(node, "title"));
      if (!labelled) report("a11y/control-label", entry, `<${tag}> has no label`);
    }

    const isButton = tag === "button" || nodeRole === "button" || (tag === "input" && BUTTON_INPUT_TYPES.has(inputType(node)));
    if (isButton && !present(accessibleName(node, context))) report("a11y/button-name", entry, "Button has no accessible name");

    if (tag === "a" && attribute(node, "href") !== undefined && !present(accessibleName(node, context))) {
      report("a11y/link-name", entry, "Link has no accessible name");
    }

    const headingTag = /^h([1-6])$/u.exec(tag);
    let level = null;
    if (headingTag) level = Number(headingTag[1]);
    else if (nodeRole === "heading") {
      const declared = Number.parseInt(attribute(node, "aria-level") ?? "", 10);
      level = Number.isInteger(declared) && declared >= 1 ? declared : 2;
    }
    if (level !== null) {
      if (previousHeading !== null && level > previousHeading + 1) {
        report("a11y/heading-order", entry, `Heading level ${level} follows level ${previousHeading}; levels should not be skipped`);
      }
      previousHeading = level;
    }

    if (present(node.text)) {
      const foreground = parseOpaqueColor(inherited(entry, "color"));
      let background = null;
      for (let cursor = entry; cursor && background === null; cursor = cursor.parent) {
        const value = backgroundOf(cursor.declarations);
        if (value !== undefined) background = parseOpaqueColor(value) ?? "unresolved";
      }
      if (foreground && Array.isArray(background)) {
        const ratio = contrastRatio(foreground, background);
        const required = isLargeText(entry) ? 3 : 4.5;
        if (ratio < required) {
          // Floor, so a ratio of 4.4995 is not reported as "4.50 is below 4.5".
          report("a11y/text-contrast", entry, `Text contrast ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 is below ${required}:1`);
        }
      }
    }
  }

  findings.sort((left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.ruleId, right.ruleId) || compareCodeUnits(left.message, right.message));
  const byRule = {};
  for (const finding of findings) byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
  return { findings, summary: { nodes: entries.length, findings: findings.length, byRule } };
}

// ---- Adapters --------------------------------------------------------------

// Counts converted nodes so shared references cannot expand a small input
// into an exponentially large tree before the audit's own bound applies.
function nodeBudget(label) {
  let count = 0;
  return () => {
    count += 1;
    if (count > ACCESSIBILITY_LIMITS.maxNodes) throw new DesignAssuranceError(`${label} exceeds ${ACCESSIBILITY_LIMITS.maxNodes} nodes`);
  };
}

/** Neutral tree for a code-ir DesignDoc ({ componentName, root: { tag, props, text?, children? } }). */
export function accessibilityTreeFromDesignDoc(doc) {
  if (doc === null || typeof doc !== "object" || doc.root === null || typeof doc.root !== "object") {
    throw new DesignAssuranceError("design document needs a root node");
  }
  const budget = nodeBudget("design document");
  const convert = (node, depth) => {
    if (depth > ACCESSIBILITY_LIMITS.maxDepth) throw new DesignAssuranceError(`design document exceeds depth ${ACCESSIBILITY_LIMITS.maxDepth}`);
    budget();
    if (node === null || typeof node !== "object") throw new DesignAssuranceError("design document nodes must be objects");
    if (node.children !== undefined && !Array.isArray(node.children)) throw new DesignAssuranceError("design document node children must be an array");
    const props = node.props ?? {};
    return {
      tag: node.tag,
      attributes: Object.fromEntries(Object.entries(props).filter(([name]) => name !== "style")),
      ...(node.text === undefined ? {} : { text: node.text }),
      ...(typeof props.style === "string" ? { style: props.style } : {}),
      children: (node.children ?? []).map((child) => convert(child, depth + 1)),
    };
  };
  return convert(doc.root, 0);
}

/**
 * Neutral tree for an import-stack proposal. Import moves link and image URLs
 * into resources; their presence is restored as href/src so links and images
 * are recognised. Multiple roots are wrapped in a synthetic fragment node.
 */
export function accessibilityTreeFromImportProposal(proposal) {
  if (proposal === null || typeof proposal !== "object" || proposal.nodes === null || typeof proposal.nodes !== "object" || !Array.isArray(proposal.rootIds)) {
    throw new DesignAssuranceError("import proposal needs nodes and rootIds");
  }
  const resourceAttributes = new Map();
  for (const resource of proposal.resources ?? []) {
    if (typeof resource?.nodeId !== "string" || typeof resource.attribute !== "string") continue;
    const names = resourceAttributes.get(resource.nodeId) ?? new Set();
    names.add(resource.attribute);
    resourceAttributes.set(resource.nodeId, names);
  }
  const budget = nodeBudget("import proposal");
  const convert = (id, depth) => {
    if (depth > ACCESSIBILITY_LIMITS.maxDepth) throw new DesignAssuranceError(`import proposal exceeds depth ${ACCESSIBILITY_LIMITS.maxDepth}`);
    budget();
    const node = typeof id === "string" && Object.hasOwn(proposal.nodes, id) ? proposal.nodes[id] : undefined;
    if (!node || typeof node !== "object") throw new DesignAssuranceError(`import proposal references missing node ${String(id).slice(0, 80)}`);
    if (node.kind !== "text" && !Array.isArray(node.children)) throw new DesignAssuranceError("import proposal node children must be an array");
    if (node.kind === "text") return { id, tag: "#text", attributes: {}, text: node.text ?? "", children: [] };
    const attributes = { ...node.attributes };
    for (const name of resourceAttributes.get(id) ?? []) if (!Object.hasOwn(attributes, name)) attributes[name] = "";
    return {
      id,
      tag: node.tag ?? "div",
      attributes,
      ...(typeof node.style?.cssText === "string" ? { style: node.style.cssText } : {}),
      children: node.children.map((child) => convert(child, depth + 1)),
    };
  };
  const roots = proposal.rootIds.map((id) => convert(id, 1));
  return roots.length === 1 ? roots[0] : { tag: "#fragment", attributes: {}, children: roots };
}
