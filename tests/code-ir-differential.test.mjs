import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildCodeIr, codeToDesign, designToCode, roundTripFingerprint } from "../packages/code-ir/src/index.ts";
import { createPrng, propertySeeds } from "./support/prng.mjs";
import { shrinkDesign } from "./support/shrink.mjs";

// P06 gate 7 (#123): designToCode and codeToDesign are inverse over the design subset,
// code -> design -> code -> design is stable, golden JSX fixtures keep pinned
// fingerprints, and a divergence is reported with its seed and minimal input.

const char = (code) => String.fromCharCode(code);
// Characters that stress escaping and JSX whitespace: entity starters, braces, quotes,
// backslashes, tabs, line breaks, no-break and non-ASCII characters, and entity-like text.
const ALPHABET = ["a", "b", "Z", " ", "  ", "&", "<", ">", "{", "}", "\"", "'", "\\", "`", "$", "/", "/>", "=", "*", "\t", "\n", "\r\n",
  char(0xa0), char(0xe9), char(0x20ac), char(0x2028), "&amp;", "&lt;", "&copy;", "&#123;", "-1", "1e5", "x y", "\\n"];
const TAGS = ["div", "span", "p", "h1", "button", "Card", "Item"];
const KEYS = ["className", "title", "id", "data-x", "aria-label", "count", "disabled", "href"];
const NUMBERS = [0, 1, -1, 1.5, -2.25, 1e21, 3e-7, 123456789, Number.MAX_SAFE_INTEGER];

const text = (random, max) => Array.from({ length: random.int(1, max) }, () => random.pick(ALPHABET)).join("");

function generateNode(random, depth) {
  const node = { tag: random.pick(TAGS), props: {} };
  for (let index = random.int(0, 3); index > 0; index -= 1) {
    const kind = random.int(0, 2);
    // Prop strings must stay on one line (designToCode refuses multi-line props).
    node.props[random.pick(KEYS)] = kind === 0 ? text(random, 5).replace(/[\r\n\u2028]/gu, "") : kind === 1 ? random.pick(NUMBERS) : random.next() < 0.5;
  }
  if (random.next() < 0.6) node.text = text(random, 6);
  if (depth < 3 && random.next() < 0.5) node.children = Array.from({ length: random.int(1, 3) }, () => generateNode(random, depth + 1));
  return node;
}

function designRoundTrip(doc) {
  const ir = buildCodeIr([{ path: "Gen.jsx", content: designToCode(doc) }]);
  return codeToDesign(ir, ir.rootIds[0], doc.componentName);
}

function divergence(doc, roundTrip) {
  try {
    const back = roundTrip(doc);
    return roundTripFingerprint(back) === roundTripFingerprint(doc) ? null : `diverged to ${JSON.stringify(back)}`;
  } catch (error) {
    return `threw ${error.message}`;
  }
}

// Fails with the seed, the minimal input the shrinker reaches, and what went wrong.
function assertRoundTrips(doc, seed, roundTrip = designRoundTrip) {
  const problem = divergence(doc, roundTrip);
  if (problem === null) return;
  const minimal = shrinkDesign(doc, (candidate) => divergence(candidate, roundTrip) !== null);
  const replay = typeof seed === "number" ? ` (replay with LILAC_PROPERTY_SEED=${seed})` : "";
  assert.fail(`seed ${seed}: design -> code -> design ${divergence(minimal, roundTrip)}; minimal input ${JSON.stringify(minimal)}${replay}`);
}

test("design -> code -> design is the identity on generated documents", () => {
  for (const seed of propertySeeds(400)) {
    const random = createPrng(seed);
    assertRoundTrips({ componentName: "Gen", root: generateNode(random, 0) }, seed);
  }
});

test("generated code is stable: code -> design -> code is a fixpoint", () => {
  for (const seed of propertySeeds(200)) {
    const doc = { componentName: "Gen", root: generateNode(createPrng(seed), 0) };
    const code = designToCode(doc);
    assert.equal(designToCode(designRoundTrip(doc)), code, `seed ${seed}`);
  }
});

// Hand-written JSX in the subset: whitespace across lines, entities, quoted attributes of
// both kinds, literal expressions and string-literal children. Lifting it, emitting the
// design and lifting again must give the same design.
const SNIPPETS = [
  "<p>\n  hello\n  world\n</p>",
  "<p>a &amp; b &lt;c&gt; &#123;x&#125; &#x41;</p>",
  "<p title='single \"quoted\"' data-x=\"a\\b\">  spaced  </p>",
  "<p>{\"  exact  \"}{'tab\\there'}</p>",
  "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>",
  "<Card count={-1.5e3} enabled={true} off={false} />",
  "<p>line\n\n\n   more   text  \n</p>",
  "<div>\n  lead\n  <span>x</span>\n  trail\n</div>",
];

test("hand-written JSX lifts to a design that re-emits stably", () => {
  for (const snippet of SNIPPETS) {
    const ir = buildCodeIr([{ path: "S.jsx", content: snippet }]);
    const first = codeToDesign(ir, ir.rootIds[0], "Snippet");
    const again = designRoundTrip(first);
    assert.equal(roundTripFingerprint(again), roundTripFingerprint(first), snippet);
  }
});

test("JSX text and attribute strings follow JSX semantics", () => {
  const lift = (source) => {
    const ir = buildCodeIr([{ path: "S.jsx", content: source }]);
    return codeToDesign(ir, ir.rootIds[0], "Snippet").root;
  };
  assert.equal(lift("<p>\n  hello\n  world\n</p>").text, "hello world", "lines are trimmed and joined");
  assert.equal(lift("<p>a &amp; b &#123;&#x7d; &nbsp;</p>").text, `a & b {} ${char(0xa0)}`);
  assert.equal(lift("<p title=\"a\\b &quot;q&quot;\" />").props.title, "a\\b \"q\"", "attribute strings have no backslash escapes");
  assert.equal(lift("<p>{\"  a\\tb \\u00e9\\u{1F600}  \"}</p>").text, `  a\tb ${char(0xe9)}${String.fromCodePoint(0x1f600)}  `);
  assert.deepEqual(lift("<p n={1e+21} m={ -2.5 } />").props, { n: 1e21, m: -2.5 });
  assert.throws(() => lift("<p>&copy; 2026</p>"), /unsupported entity &copy;/u);
  assert.throws(() => lift("<p>&#xD800;</p>"), /invalid character reference/u);
  assert.throws(() => lift("<p>{\"a\\\nb\"}</p>"), /line continuations/u);
  assert.throws(() => lift("<p>{\"\\1\"}</p>"), /octal escapes/u);
  assert.throws(() => lift("<p>{42}</p>"), /non-string literal child/u);
});

test("a failed element is skipped whole: none of its descendants becomes a root", () => {
  const broken = "<Card>{items}\n  <h1>inner</h1>\n</Card>";
  assert.throws(() => buildCodeIr([{ path: "B.jsx", content: broken }]), /no supported elements/u);
  const withSibling = buildCodeIr([{ path: "B.jsx", content: `${broken}\n<p title="a > b">ok</p>` }]);
  assert.deepEqual(withSibling.rootIds.map((id) => withSibling.symbols[id].name), ["p"]);
  // Braces and quoted ">" inside the failed element do not end it early.
  const tricky = buildCodeIr([{ path: "B.jsx", content: "<div a={x}>{\"</div>\"}<span title=\"/>\">s</span>{fn()}</div><em>after</em>" }]);
  assert.deepEqual(tricky.rootIds.map((id) => tricky.symbols[id].name), ["em"]);
});

test("recovery stops rather than guess when the failed element's structure is ambiguous", () => {
  // Each input once promoted <h1>inner</h1> to a root; now nothing is a root.
  for (const source of [
    "<Card><>{x}</><h1>inner</h1></Card>",
    "<Card>{a && <b>Don't</b>}<Inner>{'}'}</Inner><h1>inner</h1></Card>",
    "<Card>{/* don't */}<Inner>{'}'}</Inner><h1>inner</h1></Card>",
    "<a>{x}</c><h1>inner</h1></a>",
    "<A>{/}/.test(s) ? \"</A>\" : 1}<h1>inner</h1></A>",
    "<A>{/'/.test(s) ? '}' : \"</A>\"}<h1>inner</h1></A>",
  ]) {
    assert.throws(() => buildCodeIr([{ path: "R.jsx", content: source }]), /no supported elements/u, source);
  }
});

test("component binding stays fast on unclosed parameter lists", () => {
  const source = `${"const A=(".repeat(1500)}${"x".repeat(200_000)}\n<p>ok</p>`;
  const started = performance.now();
  buildCodeIr([{ path: "B.jsx", content: source }]);
  assert.ok(performance.now() - started < 500, `took ${(performance.now() - started).toFixed(0)} ms`);
});

test("long whitespace runs are trimmed in linear time", () => {
  // Trailing runs on the first line and leading and trailing runs on a middle line are
  // trimmed; each run is one token, so only the trimming cost grows with it.
  for (const filler of [" ", "\t"]) {
    const run = filler.repeat(64_000);
    for (const source of [`<a>x${run}\n</a>`, `<a>\n${run}y\n</a>`]) {
      const started = performance.now();
      const ir = buildCodeIr([{ path: "W.jsx", content: source }]);
      assert.match(codeToDesign(ir, ir.rootIds[0], "Wide").root.text, /^[xy]$/u);
      assert.ok(performance.now() - started < 1_000, `${JSON.stringify(filler)} run took ${(performance.now() - started).toFixed(0)} ms`);
    }
  }
  assert.throws(() => buildCodeIr([{ path: "W.jsx", content: `<a>${" ".repeat(70_000)}x</a>` }]), /exceeds 65536 source characters/u);
});

test("lone surrogates, __proto__ props and ambiguous numerals are refused, -0 is 0", () => {
  const lift = (source) => {
    const ir = buildCodeIr([{ path: "S.jsx", content: source }]);
    return codeToDesign(ir, ir.rootIds[0], "Snippet").root;
  };
  assert.throws(() => lift("<p>{\"\\uD800\"}</p>"), /lone surrogate/u);
  assert.throws(() => lift("<p title={\"a\\uDC00\"} />"), /lone surrogate/u);
  assert.throws(() => designToCode({ componentName: "S", root: { tag: "p", props: {}, text: `a${char(0xd800)}b` } }), /lone surrogate/u);
  assert.throws(() => designToCode({ componentName: "S", root: { tag: "p", props: { title: char(0xdc00) } } }), /lone surrogate/u);
  assert.throws(() => lift("<div __proto__=\"evil\" />"), /unsupported key/u);
  assert.equal(lift("<div constructor=\"c\" />").props.constructor, "c");
  assert.throws(() => lift("<p>{\"\\01\"}</p>"), /octal escapes/u);
  assert.throws(() => lift("<p n={010} />"), /non-literal/u);
  assert.equal(lift("<p>&#00000065;&#x0000041;</p>").text, "AA", "numeric references take any number of digits");
  assert.throws(() => lift("<p>&#X41;</p>"), /malformed character reference/u);
  assert.throws(() => lift("<p>&#;</p>"), /malformed character reference/u);
  const negativeZero = { componentName: "Z", root: { tag: "p", props: { n: -0 } } };
  assert.ok(Object.is(designRoundTrip(negativeZero).root.props.n, 0));
});

test("each original divergence is fixed", () => {
  const cases = [
    { tag: "p", props: {}, text: "a & b < c > d { e } &amp;" },
    { tag: "p", props: { title: "say \"hi\" & bye", "data-x": "back\\slash" } },
    { tag: "div", props: {}, text: "  lead and trail  ", children: [{ tag: "span", props: {}, text: "x" }] },
    { tag: "div", props: { n: 1e21, m: -1, f: 3e-7 } },
    { tag: "p", props: {}, text: "tab\there\nnewline" },
    { tag: "ul", props: {}, children: [{ tag: "li", props: {}, text: "one" }, { tag: "li", props: {}, text: "two" }] },
    { tag: "p", props: { "aria-label": "Close" }, text: "x" },
    { tag: "p", props: {}, text: "", children: [] },
  ];
  cases.forEach((root, index) => assertRoundTrips({ componentName: "Fixed", root }, `case-${index}`));
});

test("the shrinker reports the minimal failing input", () => {
  // A deliberately broken round trip that drops every "{" from text.
  const lossy = (doc) => {
    const strip = (node) => ({ ...node, ...(node.text === undefined ? {} : { text: node.text.replaceAll("{", "") }), ...(node.children ? { children: node.children.map(strip) } : {}) });
    return { ...doc, root: strip(doc.root) };
  };
  const doc = { componentName: "Gen", root: { tag: "div", props: { title: "t", count: 2 }, text: "ab", children: [{ tag: "span", props: {}, text: "x{y" }, { tag: "p", props: {}, text: "z" }] } };
  assert.throws(() => assertRoundTrips(doc, 7, lossy), (error) => {
    assert.match(error.message, /seed 7: design -> code -> design diverged/u);
    assert.match(error.message, /minimal input \{"componentName":"Gen","root":\{"tag":"span","props":\{\},"text":"\{"\}\}/u);
    assert.match(error.message, /LILAC_PROPERTY_SEED=7/u);
    return true;
  });
});

const GOLDEN = fileURLToPath(new URL("./fixtures/code-ir/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${GOLDEN}manifest.json`, "utf8"));

test("golden JSX fixtures lift to pinned designs and fingerprints", () => {
  assert.ok(manifest.cases.length >= 3);
  for (const entry of manifest.cases) {
    const source = readFileSync(`${GOLDEN}${entry.file}`, "utf8");
    const ir = buildCodeIr([{ path: entry.file, content: source }]);
    const design = codeToDesign(ir, ir.rootIds[0], entry.componentName);
    assert.deepEqual(design, entry.design, entry.file);
    assert.equal(roundTripFingerprint(design), entry.fingerprint, entry.file);
    assert.equal(roundTripFingerprint(designRoundTrip(design)), entry.fingerprint, `${entry.file} survives a round trip`);
  }
});
