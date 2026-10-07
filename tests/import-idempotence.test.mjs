import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IMPORT_SCHEMA_VERSION, canonicalImportStringify, defaultImportPolicy, importHtmlSnapshot } from "../packages/import-stack/src/index.ts";
import { inferSemantics } from "../packages/intake/src/index.ts";
import { createPrng, propertySeeds } from "./support/prng.mjs";
import { proposalToHtml, proposalView } from "./support/proposal-html.mjs";
import { shrinkString } from "./support/shrink-string.mjs";

// P06 gate 7 (#126): sanitized import is a fixpoint. Writing a proposal back to HTML
// (with the test-only reference serializer; Lilac has no product exporter yet) and
// importing it again removes nothing more and yields the same structure.

const request = (withBase = true) => ({
  schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "idempotence", actorId: "test", intent: "Import idempotence", at: "2026-10-07T09:00:00.000Z",
  policy: defaultImportPolicy("offline"),
  source: withBase ? { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" } : { kind: "html-snapshot" },
});

const view = (proposal) => JSON.stringify(proposalView(proposal));
const zeroSecurity = (proposal) => Object.values(proposal.security).every((count) => count === 0);

// Foster parenting can nest an element inside another of its group that the parser would
// close on reopen (<a><table><a> puts an <a> inside an <a>): no HTML string produces that
// tree, so no serializer can reproduce it. The rule per group follows the HTML parser:
// how far up a start tag looks for an open element of its group before a boundary stops it.
const DEFAULT_SCOPE = new Set(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template", "svg", "math"]);
const SPECIAL = new Set([...DEFAULT_SCOPE, "address", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote", "body", "br", "button", "center", "col", "colgroup", "dd", "details", "dir", "dl", "dt", "embed", "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "iframe", "img", "input", "keygen", "li", "link", "listing", "main", "menu", "meta", "nav", "noembed", "noframes", "noscript", "ol", "param", "plaintext", "pre", "script", "search", "section", "select", "source", "style", "summary", "tbody", "textarea", "tfoot", "thead", "title", "tr", "track", "ul", "wbr", "xmp"]);
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const GROUPS = [
  { tags: new Set(["a"]), stops: DEFAULT_SCOPE },
  { tags: new Set(["button"]), stops: DEFAULT_SCOPE },
  { tags: new Set(["nobr"]), stops: DEFAULT_SCOPE },
  { tags: new Set(["p"]), stops: new Set([...DEFAULT_SCOPE, "button"]) },
  // li, dd and dt look up past anything except special elements other than address, div and p.
  { tags: new Set(["li"]), stops: new Set([...SPECIAL].filter((tag) => !["address", "div", "p", "li"].includes(tag))) },
  { tags: new Set(["dd", "dt"]), stops: new Set([...SPECIAL].filter((tag) => !["address", "div", "p", "dd", "dt"].includes(tag))) },
  // Headings and options only close the current node: direct children only.
  { tags: new Set(HEADINGS), directOnly: true },
  { tags: new Set(["option", "optgroup"]), directOnly: true, inner: new Set(["option", "optgroup"]), outer: new Set(["option"]) },
];

// Outermost elements that contain an unrepresentable nesting.
function unrepresentableOuters(proposal) {
  const outers = new Set();
  const visit = (id, ancestors) => {
    const node = proposal.nodes[id];
    if (node.kind === "text") return;
    for (const group of GROUPS) {
      if (!(group.inner ?? group.tags).has(node.tag)) continue;
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const ancestor = proposal.nodes[ancestors[index]];
        if ((group.outer ?? group.tags).has(ancestor.tag)) { outers.add(ancestors[index]); break; }
        if (group.directOnly || group.stops.has(ancestor.tag)) break;
      }
    }
    for (const child of node.children) visit(child, [...ancestors, id]);
  };
  proposal.rootIds.forEach((id) => visit(id, []));
  // Keep only the outermost: an outer inside another outer is covered by it.
  const inside = (id) => { for (let parent = proposal.nodes[id].parentId; parent !== null; parent = proposal.nodes[parent].parentId) if (outers.has(parent)) return true; return false; };
  return [...outers].filter((id) => !inside(id)).map((id) => proposal.nodes[id]);
}

function contentOf(proposal) {
  const view = proposalView(proposal);
  const elements = [];
  let text = "";
  const walk = (node) => {
    if (node.text !== undefined) { text += node.text; return; }
    elements.push(JSON.stringify({ tag: node.tag, attributes: node.attributes }));
    node.children.forEach(walk);
  };
  view.roots.forEach(walk);
  return { elements: elements.sort(), text, stylesheets: view.stylesheets, resources: view.resources };
}

// Why re-importing `html` is not a fixpoint, or null.
function divergence(html, withBase = true) {
  let first;
  try { first = importHtmlSnapshot(request(withBase), html); } catch { return null; }
  let second;
  try { second = importHtmlSnapshot(request(withBase), proposalToHtml(first)); } catch (error) { return `re-import threw ${error.message}`; }
  if (!zeroSecurity(second)) return `re-import removed more: ${JSON.stringify(second.security)}`;
  if (view(first) === view(second)) return null;
  // Only an unrepresentable nesting may change, and only inside its own subtree: the
  // whole document must keep its content, and with those subtrees cut out of the source
  // the rest must be a strict fixpoint.
  const outers = unrepresentableOuters(first);
  if (outers.length === 0) return "re-import changed the structure";
  if (JSON.stringify(contentOf(first)) !== JSON.stringify(contentOf(second))) return "re-import changed the content of an unrepresentable nesting";
  let rest = html;
  for (const outer of [...outers].sort((a, b) => (b.sourceBinding?.start ?? 0) - (a.sourceBinding?.start ?? 0))) {
    const startOffset = outer.sourceBinding?.start;
    if (startOffset === undefined) return "an unrepresentable nesting has no source range";
    rest = rest.slice(0, startOffset) + rest.slice(outer.sourceBinding?.end ?? rest.length);
  }
  if (rest === html) return "re-import changed the structure";
  return rest.trim() === "" ? null : divergence(rest, withBase);
}

function assertFixpoint(html, label, withBase = true) {
  const problem = divergence(html, withBase);
  if (problem === null) return;
  const minimal = shrinkString(html, (candidate) => divergence(candidate, withBase) !== null);
  assert.fail(`${label}: ${divergence(minimal, withBase)}; minimal input ${JSON.stringify(minimal)}`);
}

const CORPUS = fileURLToPath(new URL("./fixtures/malicious/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${CORPUS}manifest.json`, "utf8"));

test("every malicious corpus case re-imports to itself with nothing more removed", () => {
  let checked = 0;
  for (const entry of manifest.cases) {
    if (entry.outcome.startsWith("rejected:")) continue;
    assertFixpoint(readFileSync(`${CORPUS}${entry.file}`, "utf8"), `corpus ${entry.id}`, entry.baseUrl !== null);
    checked += 1;
  }
  assert.ok(checked >= 40);
});

const PAGES = [
  "<style>.card{padding:8px}</style><style>.card{padding:16px}</style><main><section class=\"card\"><h1>Plans &amp; pricing</h1><p>From <b>$12</b>&nbsp;/ seat</p><a href=\"/signup\" title=\"Sign &quot;up&quot;\">Start</a></section></main>",
  "<nav><ul><li><a href=\"#a\">A</a></li><li><a href=\"#b\">B</a></li></ul></nav><svg viewBox=\"0 0 10 10\"><use xlink:href=\"#icon\" href=\"/sprite.svg#icon\"></use><title>Icon</title></svg>",
  "<table><thead><tr><th>Plan</th></tr></thead><tbody><tr><td>Free<form><input name=\"q\"></form></td></tr></tbody></table><form action=\"/x\"><label>Email <input type=\"email\"></label><button>Go</button></form>",
  "<div style=\"color:red;background:url(x)\">styled</div><img src=\"https://cdn.example.com/a.png\" alt=\"A\" srcset=\"a.png 1x\"><p onclick=\"x()\">p</p><template><span>inert</span></template>",
];

test("realistic pages re-import to themselves", () => {
  PAGES.forEach((page, index) => assertFixpoint(page, `page ${index}`));
});

// Seeded generated markup over context-sensitive tags (tables, forms, SVG and MathML,
// templates, select, raw-text elements) with hostile attributes and text.
const TAGS = ["div", "span", "p", "a", "img", "svg", "table", "tbody", "tr", "td", "caption", "ul", "ol", "li", "dl", "dt", "dd", "b", "nobr", "button", "label", "input", "select", "option", "optgroup", "textarea", "template", "form", "h1", "h2", "h3", "pre", "listing", "br", "noscript", "xmp", "title", "desc", "math", "mi", "foreignobject", "circle", "use", "style", "meta", "link", "script", "iframe", "object", "marquee"];
const ATTRS = ["class", "id", "title", "href", "src", "style", "alt", "data-x", "onclick", "viewbox", "fill", "name", "value", "type", "xlink:href", "srcset", "action", "formaction"];
const VALUES = ["a", "b c", "#frag", "https://example.com/x.png", "javascript:alert(1)", "color:red", "color: red; background:url(x)", "&amp;", "&quot;q&quot;", "&lt;b&gt;", "x&amp;y", "/rel/path", "data:text/html,x"];
const TEXTS = ["hi", " ", "  x  ", "&amp;", "&lt;", "&gt;", "&lt;b&gt;", "&nbsp;", "a\nb", "\t", "{}", "'", "\"", "\nlead", "\n\nlead"];

function generate(random, depth) {
  const tag = random.pick(TAGS);
  if (tag === "style") return `<style>.c${random.int(0, 9)}{color:red}</style>`;
  const attributes = Array.from({ length: random.int(0, 3) }, () => ` ${random.pick(ATTRS)}="${random.pick(VALUES)}"`).join("");
  const children = depth < 4 ? Array.from({ length: random.int(0, 3) }, () => (random.next() < 0.4 ? random.pick(TEXTS) : generate(random, depth + 1))).join("") : "";
  return `<${tag}${attributes}>${children}</${tag}>`;
}

test("generated markup re-imports to itself", () => {
  for (const seed of propertySeeds(600)) {
    const random = createPrng(seed);
    const html = Array.from({ length: random.int(1, 3) }, () => generate(random, 0)).join("");
    assertFixpoint(html, `seed ${seed} (replay with LILAC_PROPERTY_SEED=${seed})`, seed % 2 === 0);
  }
});

test("import is deterministic and independent of source attribute order", () => {
  const html = PAGES.join("");
  assert.equal(canonicalImportStringify(importHtmlSnapshot(request(), html)), canonicalImportStringify(importHtmlSnapshot(request(), html)));
  const forward = importHtmlSnapshot(request(), "<a title=\"t\" class=\"c\" href=\"/x\" data-x=\"1\">x</a>");
  const reversed = importHtmlSnapshot(request(), "<a data-x=\"1\" href=\"/x\" class=\"c\" title=\"t\">x</a>");
  assert.equal(view(forward), view(reversed));
});

test("stylesheets keep document order, which decides the cascade", () => {
  for (let count = 2; count <= 6; count += 1) {
    const sheets = Array.from({ length: count }, (_, index) => `.x{z-index:${index}}`);
    const proposal = importHtmlSnapshot(request(), `${sheets.map((css) => `<style>${css}</style>`).join("")}<p class="x">p</p>`);
    assert.deepEqual(proposal.stylesheets.map((sheet) => sheet.cssText), sheets);
  }
});

test("xlink:href and href on one element stay two attributes", () => {
  const proposal = importHtmlSnapshot(request(), "<svg><use xlink:href=\"/a.svg#i\" href=\"/b.svg#i\"></use></svg>");
  const attributes = proposal.resources.filter((resource) => resource.nodeId !== undefined).map((resource) => [resource.attribute, resource.uri]).sort();
  assert.deepEqual(attributes, [["href", "https://example.com/b.svg#i"], ["xlink:href", "https://example.com/a.svg#i"]]);
});

test("forms are neutralized without changing how the result parses", () => {
  for (const html of ["<table><form><tr><td>x</td></tr></form></table>", "<svg><form><circle></circle></form></svg>", "<table><p><b><form>t</form></b></p></table>", "<svg><g><form><rect></rect></form></g></svg>"]) {
    const proposal = importHtmlSnapshot(request(), html);
    assert.equal(Object.values(proposal.nodes).some((node) => node.tag === "div"), false, `${html}: unwrapped, not turned into a div`);
    assert.ok(proposal.security.dangerousElementsRemoved >= 1);
    assertFixpoint(html, html);
  }
  const flow = importHtmlSnapshot(request(), "<form><input name=\"q\"></form>");
  assert.deepEqual(Object.values(flow.nodes).filter((node) => node.tag !== undefined).map((node) => node.tag).sort(), ["div", "input"], "in ordinary flow a form still becomes a div");
});

test("the string shrinker reports a minimal failing input", () => {
  const fails = (input) => input.includes("<b>") && input.includes("x");
  assert.equal(shrinkString("<div class=\"a\"><b>hello x world</b></div>", fails).length, 4);
});

test("only unrepresentable nesting is exempt, and only within its own subtree", () => {
  const outersOf = (html) => unrepresentableOuters(importHtmlSnapshot(request(), html)).map((node) => node.tag);
  // Expressible nestings are never exempt.
  for (const html of ["<ul><li><ul><li>x</li></ul></li></ul>", "<p><button><p>y</p></button></p>", "<h1><b><h2>x</h2></b></h1>", "<dl><dt><dl><dd>x</dd></dl></dt></dl>", "<a><table><tr><td><a>x</a></td></tr></table></a>"]) {
    assert.deepEqual(outersOf(html), [], html);
  }
  for (const [html, tag] of [["<a><table><a>x</a></table></a>", "a"], ["<button><table><button>x</button></table></button>", "button"], ["<h1><table><h2>x</h2></table></h1>", "h1"], ["<dt><table><dd>x</dd></table></dt>", "dt"], ["<option><table><optgroup>x</optgroup></table></option>", "option"], ["<li><table><li>x</li></table></li>", "li"]]) {
    assert.deepEqual(outersOf(html), [tag], html);
  }
  // An exempt nesting next to ordinary markup: the rest is still checked strictly.
  assert.equal(divergence("<a><table><a>x</a></table></a><p>ok</p>"), null);
});

// Inputs from the G7b review that the earlier, broader exemption let through on the base
// import: an expressible nesting must not hide the form divergence next to it.
const REVIEW_INPUTS = [
  "<ul><li><ul><li>x</li></ul></li></ul><table><form></form></table><p>x</p>",
  "<p><button><p>y</p></button></p><table><form></form></table>",
];

test("an expressible nesting does not hide a divergence beside it", () => {
  REVIEW_INPUTS.forEach((html) => assertFixpoint(html, html));
});

test("serializer edge cases re-import exactly", () => {
  for (const html of ["<pre>\n\nx</pre>", "<textarea>\n\nx</textarea>", "<listing>\n\nx</listing>", "<svg><noscript>&lt;b&gt;</noscript></svg>", "<p>before</p><plaintext><b>raw</b>", "<svg><input></input>&amp;</svg>"]) {
    assertFixpoint(html, JSON.stringify(html));
  }
});

test("an SVG link keeps its link role", () => {
  const proposal = importHtmlSnapshot(request(), "<svg><a xlink:href=\"/x\"><text>go</text></a></svg>");
  assert.deepEqual(inferSemantics(proposal).records.filter((record) => record.role === "link").map((record) => proposal.nodes[record.nodeId].tag), ["a"]);
});

test("an unwrapped form's attributes are counted, and a foreign link is dropped", () => {
  const svg = importHtmlSnapshot(request(), "<svg><form action=\"javascript:x()\" onsubmit=\"y()\"><circle></circle></form></svg>");
  assert.equal(svg.security.eventHandlersRemoved, 1);
  assert.equal(svg.security.dangerousUrlsRemoved, 1);
  const table = importHtmlSnapshot(request(), "<table><form onclick=\"x()\" class=\"c\"></form></table>");
  assert.equal(table.security.eventHandlersRemoved, 1);
  const link = importHtmlSnapshot(request(), "<svg><link rel=\"stylesheet\" href=\"#x\" xlink:href=\"https://evil.test/a.css\"></link><circle></circle></svg>");
  assert.equal(link.resources.some((resource) => resource.kind === "stylesheet"), false);
  assert.equal(link.security.dangerousElementsRemoved, 1);
});
