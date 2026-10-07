// Reference serializer for import proposals, used only by tests (Lilac has no product
// HTML exporter yet). It writes a proposal back to HTML so that re-importing it can be
// compared with the proposal it came from.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Raw-text elements (parse5 parses with scripting on, so noscript is one): their text is
// not entity-decoded, so it is written as is, as every HTML serializer does.
const RAW_TEXT = new Set(["noscript", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
// The parser drops one line feed right after these start tags, so a text that starts with
// one needs another in front.
const LEADING_LF_DROPPED = new Set(["pre", "textarea", "listing"]);

const escapeText = (value) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/\u00a0/gu, "&nbsp;");
const escapeAttribute = (value) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/\u00a0/gu, "&nbsp;");

// URL-bearing attributes leave the node and become resources; put them back.
function attributesOf(proposal, node) {
  const attributes = { ...node.attributes };
  for (const resource of proposal.resources) {
    if (resource.nodeId === node.id && resource.attribute !== undefined) attributes[resource.attribute] = resource.uri;
  }
  if (node.style.cssText !== undefined) attributes.style = node.style.cssText;
  return Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Inside SVG or MathML no element is void, until an HTML integration point.
const FOREIGN_ROOTS = new Set(["svg", "math"]);
const HTML_INTEGRATION = new Set(["foreignobject", "desc", "title", "annotation-xml", "mi", "mo", "mn", "ms", "mtext"]);

function serializeNode(proposal, id, rawText = false, foreign = false) {
  const node = proposal.nodes[id];
  if (node.kind === "text") return rawText ? node.text : escapeText(node.text);
  const attributes = attributesOf(proposal, node).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
  if (!foreign && VOID.has(node.tag)) return `<${node.tag}${attributes}>`;
  // Raw text only in HTML: inside SVG a <noscript> is an ordinary element.
  const raw = !foreign && RAW_TEXT.has(node.tag);
  const childForeign = FOREIGN_ROOTS.has(node.tag) || (foreign && !HTML_INTEGRATION.has(node.tag));
  const first = node.children.length > 0 ? proposal.nodes[node.children[0]] : undefined;
  const lead = !foreign && LEADING_LF_DROPPED.has(node.tag) && first?.kind === "text" && first.text.startsWith("\n") ? "\n" : "";
  const inner = node.children.map((child) => serializeNode(proposal, child, raw, childForeign)).join("");
  // <plaintext> has no end tag: everything after it is its text.
  if (!foreign && node.tag === "plaintext") return `<plaintext${attributes}>${inner}`;
  return `<${node.tag}${attributes}>${lead}${inner}</${node.tag}>`;
}

export function proposalToHtml(proposal) {
  const links = proposal.resources.filter((resource) => resource.kind === "stylesheet" && resource.nodeId === undefined)
    .map((resource) => `<link rel="stylesheet" href="${escapeAttribute(resource.uri)}">`);
  const styles = proposal.stylesheets.map((sheet) => `<style>${sheet.cssText}</style>`);
  return [...links, ...styles, ...proposal.rootIds.map((id) => serializeNode(proposal, id))].join("");
}

// What an import means, without ids or source bindings: the tree, the stylesheets in
// order, and the resources by node path.
export function proposalView(proposal) {
  const viewNode = (id, path) => {
    const node = proposal.nodes[id];
    if (node.kind === "text") return { text: node.text };
    return {
      kind: node.kind,
      tag: node.tag,
      attributes: Object.fromEntries(attributesOf(proposal, node)),
      children: mergeText(node.children.map((child, index) => viewNode(child, `${path}/${index}`))),
    };
  };
  // Adjacent text nodes (left when an element between them was removed) are one text run
  // to any HTML parser, so the view merges them.
  const mergeText = (list) => list.reduce((out, item) => {
    const last = out[out.length - 1];
    if (item.text !== undefined && last?.text !== undefined) out[out.length - 1] = { text: last.text + item.text };
    else out.push(item);
    return out;
  }, []);
  return {
    roots: mergeText(proposal.rootIds.map((id, index) => viewNode(id, `${index}`))),
    stylesheets: proposal.stylesheets.map((sheet) => sheet.cssText),
    resources: proposal.resources.map((resource) => ({ kind: resource.kind, uri: resource.uri, attribute: resource.attribute ?? null })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
  };
}
