import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IMPORT_SCHEMA_VERSION, canonicalImportStringify, defaultImportPolicy, importHtmlSnapshot } from "../packages/import-stack/src/index.ts";
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

// Foster parenting can nest an element inside an element of the same tag that the parser
// closes when it is reopened (<a><table><a>): no HTML string produces that tree, so no
// serializer can reproduce it. For that class only, re-import may change the nesting,
// but must keep every element, attribute and text.
const CLOSES_ON_REOPEN = new Set(["a", "button", "option", "nobr", "li", "dd", "dt", "p", "h1", "h2", "h3", "h4", "h5", "h6", "select"]);

function hasUnrepresentableNesting(proposal) {
  const visit = (id, open) => {
    const node = proposal.nodes[id];
    if (node.kind === "text") return false;
    if (CLOSES_ON_REOPEN.has(node.tag) && open.has(node.tag)) return true;
    const next = new Set(open);
    if (CLOSES_ON_REOPEN.has(node.tag)) next.add(node.tag);
    return node.children.some((child) => visit(child, next));
  };
  return proposal.rootIds.some((id) => visit(id, new Set()));
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
  if (hasUnrepresentableNesting(first) && JSON.stringify(contentOf(first)) === JSON.stringify(contentOf(second))) return null;
  return "re-import changed the structure";
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
const TAGS = ["div", "span", "p", "a", "img", "svg", "table", "tbody", "tr", "td", "ul", "li", "b", "button", "label", "input", "select", "option", "textarea", "template", "form", "h1", "pre", "br", "noscript", "title", "math", "mi", "foreignobject", "circle", "use", "style", "meta", "link", "script", "iframe", "object"];
const ATTRS = ["class", "id", "title", "href", "src", "style", "alt", "data-x", "onclick", "viewbox", "fill", "name", "value", "type", "xlink:href", "srcset", "action", "formaction"];
const VALUES = ["a", "b c", "#frag", "https://example.com/x.png", "javascript:alert(1)", "color:red", "color: red; background:url(x)", "&amp;", "&quot;q&quot;", "&lt;b&gt;", "x&amp;y", "/rel/path", "data:text/html,x"];
const TEXTS = ["hi", " ", "  x  ", "&amp;", "&lt;", "&gt;", "&lt;b&gt;", "&nbsp;", "a\nb", "\t", "{}", "'", "\""];

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
