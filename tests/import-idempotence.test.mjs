import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFragment, serialize } from "parse5";

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

// Some HTML parses to a tree that no HTML string can express: foster parenting can put an
// <a> inside an <a> (<a><table><a>), and reopening formatting elements clones them. That
// is a property of the input, not of the import, so the fixpoint is required for every
// input whose own parsed tree is representable: parse5's serialize-then-parse is a
// fixpoint for the source itself. Unrepresentable inputs are skipped and counted.
function representable(html) {
  const once = serialize(parseFragment(html));
  return serialize(parseFragment(once)) === once;
}

// Why re-importing `html` is not a fixpoint, or null.
function divergence(html, withBase = true) {
  if (!representable(html)) return null;
  let first;
  try { first = importHtmlSnapshot(request(withBase), html); } catch { return null; }
  let second;
  try { second = importHtmlSnapshot(request(withBase), proposalToHtml(first)); } catch (error) { return `re-import threw ${error.message}`; }
  if (!zeroSecurity(second)) return `re-import removed more: ${JSON.stringify(second.security)}`;
  return view(first) === view(second) ? null : "re-import changed the structure";
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
const TAGS = ["div", "span", "p", "a", "i", "img", "svg", "table", "tbody", "tr", "td", "caption", "ul", "ol", "li", "dl", "dt", "dd", "b", "nobr", "button", "label", "input", "select", "option", "optgroup", "textarea", "template", "form", "h1", "h2", "h3", "pre", "listing", "br", "noscript", "xmp", "title", "desc", "math", "mi", "foreignobject", "circle", "use", "style", "meta", "link", "script", "iframe", "object", "marquee"];
const ATTRS = ["class", "id", "title", "href", "src", "style", "alt", "data-x", "onclick", "viewbox", "fill", "name", "value", "type", "xlink:href", "srcset", "action", "formaction"];
const VALUES = ["a", "b c", "#frag", "https://example.com/x.png", "javascript:alert(1)", "color:red", "color: red; background:url(x)", "&amp;", "&quot;q&quot;", "&lt;b&gt;", "x&amp;y", "/rel/path", "data:text/html,x"];
const TEXTS = ["hi", " ", "  x  ", "&amp;", "&lt;", "&gt;", "&lt;b&gt;", "&nbsp;", "a\nb", "\t", "{}", "'", "\"", "\nlead", "\n\nlead"];

// With `unclosed`, some end tags are left out, as in real-world markup.
function generate(random, depth, unclosed = false) {
  const tag = random.pick(TAGS);
  if (tag === "style") return `<style>.c${random.int(0, 9)}{color:red}</style>`;
  const attributes = Array.from({ length: random.int(0, 3) }, () => ` ${random.pick(ATTRS)}="${random.pick(VALUES)}"`).join("");
  const children = depth < 4 ? Array.from({ length: random.int(0, 3) }, () => (random.next() < 0.4 ? random.pick(TEXTS) : generate(random, depth + 1, unclosed))).join("") : "";
  return `<${tag}${attributes}>${children}${unclosed && random.next() < 0.4 ? "" : `</${tag}>`}`;
}

test("generated markup re-imports to itself", () => {
  let inScope = 0;
  const seeds = propertySeeds(600);
  for (const seed of seeds) {
    const random = createPrng(seed);
    const html = Array.from({ length: random.int(1, 3) }, () => generate(random, 0, random.next() < 0.3)).join("");
    if (representable(html)) inScope += 1;
    assertFixpoint(html, `seed ${seed} (replay with LILAC_PROPERTY_SEED=${seed})`, seed % 2 === 0);
  }
  // The property is not vacuous: most generated inputs are representable and checked.
  if (seeds.length > 1) assert.ok(inScope >= seeds.length * 0.5, `only ${inScope} of ${seeds.length} inputs were representable`);
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
  const listed = importHtmlSnapshot(request(), "<ul><li><form><li>x</li></form></li></ul>");
  assert.ok(Object.values(listed.nodes).some((node) => node.tag === "section"), "above a list item a form becomes a section, which still stops the list-item search");
});

test("the string shrinker reports a minimal failing input", () => {
  const fails = (input) => input.includes("<b>") && input.includes("x");
  assert.equal(shrinkString("<div class=\"a\"><b>hello x world</b></div>", fails).length, 4);
});

test("only inputs whose own parse is unrepresentable are out of scope", () => {
  for (const html of ["<a><table><a>x</a></table></a>", "<a><b><table><a>x", "<button><table><button>x</button></table></button>", "<div><a>x<table><form></form></table></div>q<table><a>y</a></table>"]) {
    assert.equal(representable(html), false, html);
  }
  // Expressible nestings, foreign nesting and the shapes the review found are in scope.
  for (const html of ["<ul><li><ul><li>x</li></ul></li></ul>", "<p><button><p>y</p></button></p>", "<svg><a><a>x</a></a></svg>", "<ul><li><form><li>x</li></form></li></ul>", "<dl><dt><form><dd>x</dd></form></dt></dl>", "<table><form></form></table>"]) {
    assert.equal(representable(html), true, html);
    assertFixpoint(html, html);
  }
});

// Inputs from the G7b reviews that an earlier exemption rule let through on the base
// import: a nesting must not hide the divergence next to it.
const REVIEW_INPUTS = [
  "<ul><li><ul><li>x</li></ul></li></ul><table><form></form></table><p>x</p>",
  "<p><button><p>y</p></button></p><table><form></form></table>",
  "<svg><a><a><form><circle></circle></form></a></a></svg>",
  "<ul><li><form><li>x</li></form></li></ul>",
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
  const link = importHtmlSnapshot(request(), "<svg><link rel=\"stylesheet\" href=\"#x\" xlink:href=\"https://evil.test/a.css\"><text>kept</text></link><circle></circle></svg>");
  assert.equal(link.resources.some((resource) => resource.kind === "stylesheet"), false);
  assert.equal(link.security.dangerousElementsRemoved, 1);
  assert.ok(Object.values(link.nodes).some((node) => node.text === "kept"), "a foreign link is unwrapped, its children kept");
  // Every attribute an unwrapped form carried is counted as the <div> path would count it.
  const counted = importHtmlSnapshot(request(), "<svg><form xml:base=\"https://evil.test/\" href=\"javascript:x()\" style=\"background:url(x)\" srcset=\"a 1x\" onclick=\"y()\"><circle></circle></form></svg>");
  assert.deepEqual([counted.security.dangerousUrlsRemoved, counted.security.unsafeStylesRemoved, counted.security.eventHandlersRemoved], [3, 1, 1]);
});
