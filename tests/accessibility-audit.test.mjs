import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCESSIBILITY_LIMITS,
  DesignAssuranceError,
  accessibilityTreeFromDesignDoc,
  accessibilityTreeFromImportProposal,
  auditAccessibility,
  contrastRatio,
  parseOpaqueColor,
} from "../packages/design-assurance/src/index.mjs";
import { buildCodeIr, codeToDesign, designToCode } from "../packages/code-ir/src/index.ts";
import { IMPORT_SCHEMA_VERSION, defaultImportPolicy, importHtmlSnapshot } from "../packages/import-stack/src/index.ts";
import { reviewImport } from "../packages/intake/src/index.ts";

const el = (tag, attributes = {}, children = [], extra = {}) => ({ tag, attributes, children, ...extra });
const text = (value, extra = {}) => ({ tag: "#text", attributes: {}, text: value, children: [], ...extra });
const rules = (tree) => auditAccessibility(tree).findings.map((finding) => finding.ruleId);

test("contrast ratios match WCAG reference values", () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), "21.00");
  assert.equal(contrastRatio(parseOpaqueColor("#777"), parseOpaqueColor("white")).toFixed(2), "4.48");
  assert.equal(contrastRatio(parseOpaqueColor("#767676"), parseOpaqueColor("#fff")).toFixed(2), "4.54");
  assert.equal(contrastRatio([10, 20, 30], [10, 20, 30]), 1);
  assert.deepEqual(parseOpaqueColor("rgb(1, 2, 3)"), [1, 2, 3]);
  assert.deepEqual(parseOpaqueColor("rgba(1,2,3,1)"), [1, 2, 3]);
  for (const value of ["rgba(1,2,3,0.5)", "transparent", "red", "#12", "rgb(300,0,0)", "var(--x)", undefined]) {
    assert.equal(parseOpaqueColor(value), null, String(value));
  }
});

test("image alternatives", () => {
  assert.deepEqual(rules(el("div", {}, [el("img", { src: "a.png" })])), ["a11y/image-alt"]);
  assert.deepEqual(rules(el("div", {}, [el("img", { src: "a.png", alt: "" })])), [], "empty alt marks a decorative image");
  assert.deepEqual(rules(el("div", {}, [el("img", { role: "presentation" })])), []);
  assert.deepEqual(rules(el("div", {}, [el("input", { type: "image" })])), ["a11y/image-alt"]);
  assert.deepEqual(rules(el("div", {}, [el("input", { type: "image", alt: "Search" })])), []);
});

test("form control labels", () => {
  assert.deepEqual(rules(el("form", {}, [el("input", { type: "email" })])), ["a11y/control-label"]);
  assert.deepEqual(rules(el("form", {}, [el("select"), el("textarea")])), ["a11y/control-label", "a11y/control-label"]);
  assert.deepEqual(rules(el("form", {}, [el("input", { type: "hidden" }), el("input", { type: "submit", value: "Go" })])), []);
  const labelled = el("form", {}, [
    el("input", { "aria-label": "Email" }),
    el("label", { htmlFor: "name" }, [text("Name")]),
    el("input", { id: "name" }),
    el("label", {}, [text("Phone"), el("input", { type: "tel" })]),
    el("span", { id: "c-label" }, [text("Comment")]),
    el("textarea", { "aria-labelledby": "c-label" }),
    el("select", { title: "Country" }),
  ]);
  assert.deepEqual(rules(labelled), []);
  assert.deepEqual(rules(el("form", {}, [el("label", { for: "x" }, []), el("input", { id: "x" })])), ["a11y/control-label"], "an empty label does not label");
  assert.deepEqual(rules(el("form", {}, [el("input", { "aria-labelledby": "missing" })])), ["a11y/control-label"]);
});

test("button and link names", () => {
  assert.deepEqual(rules(el("div", {}, [el("button"), el("div", { role: "button" }), el("input", { type: "button" })])), ["a11y/button-name", "a11y/button-name", "a11y/button-name"]);
  assert.deepEqual(rules(el("div", {}, [
    el("button", {}, [text("Save")]),
    el("button", { "aria-label": "Close" }),
    el("button", {}, [el("img", { alt: "Settings" })]),
    el("input", { type: "submit", value: "Send" }),
  ])), []);
  assert.deepEqual(rules(el("nav", {}, [el("a", { href: "/x" })])), ["a11y/link-name"]);
  assert.deepEqual(rules(el("nav", {}, [el("a", { href: "/x" }, [text("  ")])])), ["a11y/link-name"], "whitespace is not a name");
  assert.deepEqual(rules(el("nav", {}, [el("a", { href: "/x", title: "Home" }), el("a", {}, [])])), [], "an anchor without href is not a link");
});

test("heading order", () => {
  assert.deepEqual(rules(el("main", {}, [el("h1", {}, [text("A")]), el("h3", {}, [text("B")])])), ["a11y/heading-order"]);
  assert.deepEqual(rules(el("main", {}, [el("h2", {}, [text("A")]), el("h3", {}, [text("B")]), el("h2", {}, [text("C")]), el("h1", {}, [text("D")])])), []);
  assert.deepEqual(rules(el("main", {}, [el("h1", {}, [text("A")]), el("div", { role: "heading", "aria-level": "4" }, [text("B")])])), ["a11y/heading-order"]);
  assert.deepEqual(rules(el("main", {}, [el("h1", {}, [text("A")]), el("div", { role: "heading" }, [text("B")])])), [], "role=heading defaults to level 2");
});

test("text contrast where colours resolve", () => {
  const card = (color, background, extraStyle = "") => el("div", {}, [el("p", {}, [], { text: "Hello", style: `color: ${color};${extraStyle}` })], { style: `background-color: ${background}` });
  assert.deepEqual(rules(card("#777", "#fff")), ["a11y/text-contrast"]);
  assert.deepEqual(rules(card("#767676", "#fff")), []);
  assert.deepEqual(rules(card("#777", "#fff", "font-size: 24px")), [], "large text needs 3:1");
  assert.deepEqual(rules(card("#999", "#fff", "font-size: 19px; font-weight: bold")), ["a11y/text-contrast"], "#999 on white is 2.85:1, below 3:1");
  assert.deepEqual(rules(card("#888", "#fff", "font-size: 19px; font-weight: 700")), [], "#888 on white is 3.54:1, enough for large bold text");
  assert.deepEqual(rules(card("rgba(0,0,0,0.5)", "#fff")), [], "translucent colours are skipped, not guessed");
  assert.deepEqual(rules(card("#777", "url(x.png)")), [], "an unresolvable background is skipped");
  const message = auditAccessibility(card("#777", "#fff")).findings[0].message;
  assert.match(message, /4\.47:1 is below 4\.5:1/u, "the ratio is floored, not rounded up");
  // True ratio 4.4995: fails, and is not reported as "4.50 is below 4.5".
  const edge = auditAccessibility(card("rgb(2,2,2)", "rgb(207,0,207)")).findings;
  assert.equal(edge.length, 1);
  assert.match(edge[0].message, /4\.49:1 is below 4\.5:1/u);
});

test("generated JSX is audited identically before emission and after re-parsing", () => {
  const doc = {
    componentName: "Signup",
    root: {
      tag: "form",
      props: { style: "background-color: #ffffff" },
      children: [
        { tag: "h1", props: {}, text: "Join" },
        { tag: "h3", props: {}, text: "Details" },
        { tag: "img", props: { src: "logo.png" } },
        { tag: "input", props: { type: "email" } },
        { tag: "p", props: { style: "color: #aaaaaa" }, text: "Faint" },
        { tag: "button", props: {} },
      ],
    },
  };
  const before = auditAccessibility(accessibilityTreeFromDesignDoc(doc));
  const code = designToCode(doc);
  const ir = buildCodeIr([{ path: "Signup.jsx", content: code }]);
  const after = auditAccessibility(accessibilityTreeFromDesignDoc(codeToDesign(ir, ir.rootIds[0], "Signup")));
  assert.deepEqual(after, before);
  assert.deepEqual(before.findings.map((finding) => finding.ruleId).sort(), [
    "a11y/button-name", "a11y/control-label", "a11y/heading-order", "a11y/image-alt", "a11y/text-contrast",
  ]);
  assert.equal(before.summary.findings, 5);
});

test("imported HTML is audited through its proposal", () => {
  const proposal = importHtmlSnapshot({
    schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "a11y-1", actorId: "user-1", intent: "Import", at: "2026-10-07T09:00:00.000Z",
    policy: defaultImportPolicy("offline"), source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
  }, '<main style="background-color:#000"><h1>Title</h1><a href="/x"></a><a href="/y">Named</a><img src="/a.png"><img src="/b.png" alt=""><label>Email <input type="email"></label><input name="q"><p style="color:#222">Dark on black</p></main>');
  const result = auditAccessibility(accessibilityTreeFromImportProposal(proposal));
  assert.deepEqual(result.findings.map((finding) => finding.ruleId).sort(), ["a11y/control-label", "a11y/image-alt", "a11y/link-name", "a11y/text-contrast"]);
  assert.ok(result.findings.every((finding) => typeof finding.nodeId === "string" && proposal.nodes[finding.nodeId]), "findings name proposal nodes");
});

test("findings are deterministically ordered and carry WCAG references", () => {
  const tree = el("div", {}, [el("button"), el("img"), el("a", { href: "/" }), el("img")]);
  const first = auditAccessibility(tree);
  assert.deepEqual(auditAccessibility(structuredClone(tree)), first);
  assert.deepEqual(first.findings.map((finding) => finding.path), ["/div[1]/a[1]", "/div[1]/button[1]", "/div[1]/img[1]", "/div[1]/img[2]"]);
  assert.deepEqual(first.findings.map((finding) => finding.wcag), ["2.4.4", "4.1.2", "1.1.1", "1.1.1"]);
  assert.deepEqual(first.summary.byRule, { "a11y/link-name": 1, "a11y/button-name": 1, "a11y/image-alt": 2 });
});

test("malformed and oversized trees fail closed", () => {
  assert.throws(() => auditAccessibility(null), DesignAssuranceError);
  assert.throws(() => auditAccessibility({ tag: "", attributes: {}, children: [] }), DesignAssuranceError);
  assert.throws(() => auditAccessibility({ tag: "div", attributes: [], children: [] }), DesignAssuranceError);
  assert.throws(() => auditAccessibility({ tag: "div", attributes: {}, children: {} }), DesignAssuranceError);
  let deep = el("div");
  for (let level = 0; level < ACCESSIBILITY_LIMITS.maxDepth + 1; level += 1) deep = el("div", {}, [deep]);
  assert.throws(() => auditAccessibility(deep), /depth 1024/u);
  const wide = el("div", {}, Array.from({ length: ACCESSIBILITY_LIMITS.maxNodes }, () => el("span")));
  assert.throws(() => auditAccessibility(wide), /exceeds 100000 nodes/u);
  const name = "x".repeat(1000);
  const finding = auditAccessibility(el("div", {}, [el("label", { htmlFor: "n" }, [text(name)]), el("input", { id: "n" }), el("h1", {}, [text("a")]), el("h3", {}, [text(name)])])).findings[0];
  assert.ok(finding.message.length < 200, "messages do not echo content");
  assert.throws(() => accessibilityTreeFromImportProposal({ nodes: {}, rootIds: ["missing"] }), /missing node/u);
  assert.throws(() => accessibilityTreeFromDesignDoc({}), DesignAssuranceError);
});

test("text colour and size inherit from ancestors", () => {
  const tree = el("section", {}, [
    el("div", {}, [text("Inherited faint")], { style: "color: #aaa" }),
    el("div", {}, [el("span", {}, [text("Large inherited")])], { style: "color: #777; font-size: 30px" }),
  ], { style: "background: #fff" });
  const findings = auditAccessibility(tree).findings;
  assert.deepEqual(findings.map((finding) => finding.path), ["/section[1]/div[1]/#text[1]"]);
});

test("hidden content and nested controls do not name or label", () => {
  assert.deepEqual(rules(el("div", {}, [el("button", {}, [el("span", { "aria-hidden": "true" }, [text("X")])])])), ["a11y/button-name"]);
  assert.deepEqual(rules(el("nav", {}, [el("a", { href: "/" }, [el("span", { hidden: "" }, [text("Home")])])])), ["a11y/link-name"]);
  assert.deepEqual(rules(el("form", {}, [el("label", {}, [el("select", {}, [el("option", {}, [text("One")])])])])), ["a11y/control-label"], "option text is not a label");
  assert.deepEqual(rules(el("form", {}, [el("textarea", { "aria-labelledby": "missing" }, [text("draft")])])), ["a11y/control-label"], "content is not a label for a control");
  assert.deepEqual(rules(el("form", {}, [el("label", {}, [text("Pick"), el("select", {}, [el("option", {}, [text("One")])])])])), []);
});

test("adapters bound shared references and reject malformed nodes", () => {
  // Every level reuses one child id twice, which would expand to 2^40 nodes.
  const nodes = {};
  for (let level = 0; level < 40; level += 1) {
    const id = `n${level}`;
    const child = `n${level + 1}`;
    nodes[id] = { id, kind: "element", tag: "div", attributes: {}, style: {}, children: level < 39 ? [child, child] : [] };
  }
  const started = performance.now();
  assert.throws(() => accessibilityTreeFromImportProposal({ nodes, rootIds: ["n0"] }), /exceeds 100000 nodes/u);
  assert.ok(performance.now() - started < 5000, "the budget stops expansion early");
  const shared = { tag: "span", props: {} };
  let level = { tag: "div", props: {}, children: [shared, shared] };
  for (let index = 0; index < 40; index += 1) level = { tag: "div", props: {}, children: [level, level] };
  assert.throws(() => accessibilityTreeFromDesignDoc({ componentName: "X", root: level }), /exceeds 100000 nodes/u);
  assert.throws(() => accessibilityTreeFromImportProposal({ nodes: { a: { kind: "element", tag: "div", attributes: {} } }, rootIds: ["a"] }), DesignAssuranceError);
  assert.throws(() => accessibilityTreeFromDesignDoc({ componentName: "X", root: { tag: "div", props: {}, children: "x" } }), DesignAssuranceError);
});

test("intake review surfaces accessibility findings without blocking the commit", () => {
  const proposal = importHtmlSnapshot({
    schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "a11y-2", actorId: "user-1", intent: "Import", at: "2026-10-07T09:00:00.000Z",
    policy: defaultImportPolicy("offline"), source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
  }, '<main><h1>Title</h1><img src="/a.png"><button></button></main>');
  const review = reviewImport(proposal);
  assert.equal(review.accessibility.findings, 2);
  assert.deepEqual(review.accessibility.byRule, { "a11y/button-name": 1, "a11y/image-alt": 1 });
  assert.deepEqual(review.accessibility.items.map((item) => item.wcag), ["4.1.2", "1.1.1"]);
  assert.ok(review.accessibility.items.every((item) => proposal.nodes[item.nodeId]));
  assert.equal(review.accessibility.truncated, 0);
  assert.equal(review.commitReady, true, "accessibility findings are advisory");
});

test("imports at the import depth hard limit can be reviewed", () => {
  const depth = 256;
  const html = `${"<div>".repeat(depth)}<img src="/a.png">${"</div>".repeat(depth)}`;
  const policy = { ...defaultImportPolicy("offline"), maxDomDepth: 256 };
  const proposal = importHtmlSnapshot({
    schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "a11y-deep", actorId: "user-1", intent: "Import", at: "2026-10-07T09:00:00.000Z",
    policy, source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
  }, html);
  assert.equal(reviewImport(proposal).accessibility.findings, 1);
});

test("hidden elements are not audited but still label", () => {
  assert.deepEqual(rules(el("div", {}, [el("button", { hidden: "" }), el("div", { "aria-hidden": "TRUE" }, [el("img"), el("input")])])), []);
  assert.deepEqual(rules(el("form", {}, [el("span", { id: "l", hidden: "" }, [text("Email")]), el("input", { "aria-labelledby": "l" })])), []);
  assert.deepEqual(rules(el("div", { "aria-hidden": "false" }, [el("img")])), ["a11y/image-alt"]);
});
