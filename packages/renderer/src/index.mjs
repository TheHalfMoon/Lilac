// @ninerr/renderer: turns a Lilac document into web semantics inside a sandboxed frame.
//
// Rendering contract (docs/ARCHITECTURE.md): web semantics out, a stable node -> DOM identity
// (`data-lilac-id`), no renderer-only document state, and an explicit sandbox for imported
// markup. This module has no imports and no Node built-ins, so the browser loads it as is.
//
// Web-semantic props convention (PC2, frozen): a node's props may hold
//   tag         HTML or SVG element name (allowlisted; defaults by node type)
//   text        text content, rendered before the node's children
//   attributes  { name: string } (allowlisted names, sanitized values)
//   style       { css-property: string } (sanitized values)
//   name        layer name for the editor; never rendered
// Anything else in props is ignored by the renderer. Imported nodes (@ninerr/import-stack)
// already use { tag, text, attributes, style }.

export const RENDERER_SCHEMA_VERSION = 1;

const HTML_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "button", "caption", "cite", "code", "col",
  "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "fieldset", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "input", "ins", "kbd", "label", "legend", "li",
  "main", "mark", "nav", "ol", "optgroup", "option", "p", "picture", "pre", "q", "s", "samp", "section", "select",
  "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "textarea", "tfoot", "th", "thead",
  "time", "tr", "u", "ul", "var",
]);
const SVG_TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc"]);
const SVG_NS = "http://www.w3.org/2000/svg";

const DEFAULT_TAG = Object.freeze({ page: "div", frame: "div", group: "div", element: "div", text: "span", image: "img", vector: "svg", media: "div" });

const GLOBAL_ATTRIBUTES = new Set(["class", "title", "lang", "dir", "role", "hidden"]);
const ELEMENT_ATTRIBUTES = Object.freeze({
  a: ["href", "rel", "target", "hreflang"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  time: ["datetime"],
  q: ["cite"],
  blockquote: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  label: ["for"],
  input: ["type", "value", "placeholder", "checked", "disabled", "readonly", "name", "min", "max", "step", "size", "maxlength"],
  textarea: ["placeholder", "disabled", "readonly", "name", "rows", "cols", "maxlength"],
  select: ["disabled", "name", "multiple", "size"],
  option: ["value", "selected", "disabled", "label"],
  optgroup: ["label", "disabled"],
  button: ["type", "disabled", "name", "value"],
  details: ["open"],
  fieldset: ["disabled", "name"],
});
// SVG attributes, keyed by lowercase name, with the case the SVG DOM requires.
const SVG_ATTRIBUTES = new Map([
  "viewBox", "width", "height", "d", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-opacity", "opacity", "transform", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "points", "text-anchor", "font-size", "preserveAspectRatio",
].map((name) => [name.toLowerCase(), name]));
const INPUT_TYPES = new Set(["text", "email", "number", "password", "search", "tel", "url", "checkbox", "radio", "range", "date", "time", "color", "button", "submit", "reset"]);
const SAFE_LINK = /^(https?:|mailto:|tel:|#)/iu;
const SAFE_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/iu;
const MAX_TEXT = 1_000_000;
const MAX_VALUE = 2_000;
const STYLE_NAME = /^(--[A-Za-z0-9_-]{1,64}|-?[a-z][a-z-]{0,63})$/u;
// Anything that could fetch, execute, or escape a declaration is refused outright.
const UNSAFE_STYLE = /url\s*\(|image-set|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding|[\\;{}<>]/iu;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (record, key) => (isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * What the renderer will create for `node`, decided without a DOM: a tag (or null when the
 * node is not rendered), its namespace, the attributes and styles that survive the
 * allowlists, its text, and how many values were dropped. Pure, so it can be tested in Node.
 */
export function planElement(node) {
  const props = isRecord(node?.props) ? node.props : {};
  const requested = own(props, "tag");
  const fallback = DEFAULT_TAG[node?.type] ?? "div";
  let tag = typeof requested === "string" ? requested.toLowerCase() : fallback;
  let namespace = "html";
  let dropped = 0;
  if (SVG_TAGS.has(tag) && (tag === "svg" || node?.type === "vector" || requested !== undefined)) {
    namespace = "svg";
  } else if (!HTML_TAGS.has(tag)) {
    dropped += 1;
    tag = fallback === "svg" ? "div" : fallback;
  }
  const attributes = {};
  const rawAttributes = own(props, "attributes");
  if (isRecord(rawAttributes)) {
    for (const [rawName, rawValue] of Object.entries(rawAttributes)) {
      const lower = rawName.toLowerCase();
      const value = sanitizeAttribute(tag, namespace, lower, rawValue);
      if (value === null) dropped += 1;
      // Links are rendered inert: the canvas is an editing surface, never a browser.
      else if (lower === "href") attributes["data-lilac-href"] = value;
      else attributes[namespace === "svg" ? SVG_ATTRIBUTES.get(lower) ?? lower : lower] = value;
    }
  }
  const style = {};
  const rawStyle = own(props, "style");
  if (isRecord(rawStyle)) {
    for (const [name, rawValue] of Object.entries(rawStyle)) {
      const value = typeof rawValue === "number" ? String(rawValue) : rawValue;
      if (typeof value !== "string" || !STYLE_NAME.test(name) || value.length > MAX_VALUE || UNSAFE_STYLE.test(value)) dropped += 1;
      else style[name] = value.trim();
    }
  }
  const rawText = own(props, "text");
  const text = typeof rawText === "string" ? rawText.slice(0, MAX_TEXT) : null;
  return { tag, namespace, attributes, style, text, dropped };
}

function sanitizeAttribute(tag, namespace, name, rawValue) {
  const value = typeof rawValue === "number" || typeof rawValue === "boolean" ? String(rawValue) : rawValue;
  if (typeof value !== "string" || value.length > MAX_VALUE) return null;
  // Event handlers, inline styles (they go through `style`), and our own identity never pass.
  if (name.startsWith("on") || name === "style" || name.startsWith("data-lilac") || name === "id") return null;
  if (name.startsWith("aria-") && /^aria-[a-z]{1,32}$/u.test(name)) return value;
  if (/^data-[a-z0-9-]{1,64}$/u.test(name)) return value;
  if (namespace === "svg") return SVG_ATTRIBUTES.has(name) && !/javascript:|url\s*\(/iu.test(value) ? value : null;
  if (!(GLOBAL_ATTRIBUTES.has(name) || (ELEMENT_ATTRIBUTES[tag] ?? []).includes(name))) return null;
  if (name === "href" || name === "cite") return SAFE_LINK.test(value.trim()) ? value.trim() : null;
  if (name === "src") return SAFE_IMAGE.test(value.trim()) ? value.trim() : null;
  if (name === "target") return value === "_blank" ? "_blank" : null;
  if (name === "type" && tag === "input") return INPUT_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : null;
  return value;
}

// The frame's document: no scripts (the sandbox has no allow-scripts), no forms, no
// navigation, no network (CSP default-src 'none'; images only as data: URLs).
export const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
export const FRAME_SANDBOX = "allow-same-origin";

export function frameSrcdoc() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>html,body{margin:0;padding:0}body{font-family:system-ui,sans-serif}[data-lilac-root]{position:relative;min-height:100vh}a[data-lilac-href]{color:LinkText;text-decoration:underline}</style></head><body><div data-lilac-root inert></div></body></html>`;
}

/**
 * Create the sandboxed frame inside `container` and resolve with a renderer bound to it.
 * The parent drives the frame's DOM directly (same origin, scripts disabled inside).
 */
export function mountSandboxedRenderer(container) {
  const owner = container.ownerDocument;
  const frame = owner.createElement("iframe");
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.setAttribute("title", "Canvas");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = frameSrcdoc();
  return new Promise((resolve) => {
    frame.addEventListener("load", () => {
      const frameDocument = frame.contentDocument;
      // Defense in depth: nothing in the frame may navigate it or submit anything.
      for (const type of ["click", "auxclick", "submit", "keydown"]) {
        frameDocument.addEventListener(type, (event) => {
          if (type !== "keydown" || event.key === "Enter") {
            if (type === "keydown" && !event.target?.closest?.("a, button, input, summary")) return;
            event.preventDefault();
          }
        }, true);
      }
      resolve({ frame, renderer: createRenderer(frameDocument.querySelector("[data-lilac-root]")) });
    }, { once: true });
    container.appendChild(frame);
  });
}

/**
 * A renderer over `root` (an element). It keeps only the node -> element map, which is
 * derived and rebuilt from the document; the document stays the sole source of truth.
 */
export function createRenderer(root) {
  const doc = root.ownerDocument;
  const elements = new Map();
  const stats = { created: 0, updated: 0, removed: 0, dropped: 0 };

  function build(node) {
    const plan = planElement(node);
    const element = plan.namespace === "svg" ? doc.createElementNS(SVG_NS, plan.tag) : doc.createElement(plan.tag);
    element.setAttribute("data-lilac-id", node.id);
    stats.created += 1;
    apply(element, node, plan);
    elements.set(node.id, element);
    return element;
  }

  function apply(element, node, plan) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name !== "data-lilac-id" && !Object.hasOwn(plan.attributes, attribute.name)) element.removeAttribute(attribute.name);
    }
    for (const [name, value] of Object.entries(plan.attributes)) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
    element.removeAttribute("style");
    let rejected = 0;
    for (const [name, raw] of Object.entries(plan.style)) {
      const important = /\s*!important$/iu.test(raw);
      const value = important ? raw.replace(/\s*!important$/iu, "") : raw;
      element.style.setProperty(name, value, important ? "important" : "");
      // The browser's CSS parser is the final judge; count what it refused.
      if (element.style.getPropertyValue(name) === "") rejected += 1;
    }
    element.setAttribute("data-lilac-type", node.type);
    stats.dropped += plan.dropped + rejected;
    const first = element.firstChild;
    const textNode = first !== null && first.nodeType === 3 && first.__lilacText ? first : null;
    if (plan.text === null) textNode?.remove();
    else if (textNode) textNode.data = plan.text;
    else {
      const created = doc.createTextNode(plan.text);
      created.__lilacText = true;
      element.insertBefore(created, element.firstChild);
    }
  }

  // Put exactly `ids` (in order) as the element children of `parent`, after any text node.
  function reconcileChildren(parent, ids, document) {
    let cursor = parent.firstChild !== null && parent.firstChild.__lilacText ? parent.firstChild.nextSibling : parent.firstChild;
    const wanted = new Set(ids);
    for (const id of ids) {
      const node = document.nodes[id];
      const element = elements.get(id) ?? buildTree(node, document);
      if (element !== cursor) parent.insertBefore(element, cursor);
      else cursor = cursor.nextSibling;
    }
    // Anything left after the wanted children is no longer a child here.
    for (let extra = cursor; extra !== null;) {
      const next = extra.nextSibling;
      const id = extra.getAttribute?.("data-lilac-id");
      if (id && !wanted.has(id)) {
        if (!Object.hasOwn(document.nodes, id)) forget(extra);
        extra.remove();
      }
      extra = next;
    }
  }

  function buildTree(node, document) {
    const element = build(node);
    reconcileChildren(element, node.children, document);
    return element;
  }

  function forget(element) {
    for (const descendant of [element, ...element.querySelectorAll("[data-lilac-id]")]) {
      elements.delete(descendant.getAttribute("data-lilac-id"));
      stats.removed += 1;
    }
  }

  return {
    stats,
    /** Render `document` from scratch. */
    render(document) {
      for (const element of elements.values()) element.remove();
      elements.clear();
      root.replaceChildren();
      reconcileChildren(root, document.rootIds, document);
    },
    /**
     * Bring the DOM up to date after a change touching `affectedNodeIds` (as history reports
     * them: the changed nodes plus the parents whose children changed). Only those nodes
     * and the subtrees they gain are touched.
     */
    patch(document, affectedNodeIds) {
      for (const id of affectedNodeIds) {
        const element = elements.get(id);
        if (!Object.hasOwn(document.nodes, id)) {
          if (element) {
            forget(element);
            element.remove();
          }
          continue;
        }
        const node = document.nodes[id];
        if (element) {
          const plan = planElement(node);
          const namespace = plan.namespace === "svg" ? SVG_NS : "http://www.w3.org/1999/xhtml";
          let target = element;
          if (element.localName !== plan.tag || element.namespaceURI !== namespace) {
            // A changed tag or namespace needs a new element; its children move across.
            target = build(node);
            for (const child of [...element.childNodes]) if (!child.__lilacText) target.appendChild(child);
            element.replaceWith(target);
          } else {
            apply(element, node, plan);
          }
          stats.updated += 1;
          reconcileChildren(target, node.children, document);
        }
      }
      // Roots are reconciled every time; it touches only the top level.
      reconcileChildren(root, document.rootIds, document);
      for (const id of affectedNodeIds) {
        const node = document.nodes[id];
        const element = elements.get(id);
        if (node && element && node.parentId !== null) {
          const parent = elements.get(node.parentId);
          if (parent && element.parentNode !== parent) reconcileChildren(parent, document.nodes[node.parentId].children, document);
        }
      }
    },
    elementFor(nodeId) {
      return elements.get(nodeId) ?? null;
    },
    /** The node id of the rendered element at or above `target`, or null. */
    nodeIdFor(target) {
      const element = target?.closest?.("[data-lilac-id]");
      return element ? element.getAttribute("data-lilac-id") : null;
    },
    get size() {
      return elements.size;
    },
  };
}
