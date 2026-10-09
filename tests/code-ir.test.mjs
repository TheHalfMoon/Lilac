import test from "node:test";
import assert from "node:assert/strict";

import {
  CODE_IR_HARD_LIMITS,
  CODE_IR_PROVENANCE,
  CODE_IR_SCHEMA_VERSION,
  CodeIrConflictError,
  CodeIrUnsupportedError,
  CodeIrValidationError,
  applyPatch,
  buildCodeIr,
  codeToDesign,
  designToCode,
  mapClassTokens,
  parseCssFile,
  parseJsxFile,
  roundTripFingerprint,
  threeWayMerge,
  tokenizeClassList,
} from "../packages/code-ir/src/index.ts";

const CARD = `export function Card() {
  return (
    <div className="card p-4">
      <h1 title="Hello">Welcome</h1>
      <button count={3} disabled={false}>Don't click</button>
    </div>
  );
}
`;

const CARD_CSS = `.card { display: grid; color: red; }
@media (min-width: 100px) { .card { display: block; } }
`;

function cardIr() {
  return buildCodeIr([{ path: "Card.jsx", content: CARD }]);
}

function cardSymbols() {
  const ir = cardIr();
  return Object.fromEntries(Object.values(ir.symbols).map((symbol) => [symbol.name, symbol]));
}

test("subset parsing succeeds deterministically with provenance", () => {
  const first = cardIr();
  const second = cardIr();
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, CODE_IR_SCHEMA_VERSION);
  const symbols = cardSymbols();
  assert.equal(symbols.div.kind, "element");
  assert.equal(symbols.h1.texts[0].value, "Welcome");
  assert.equal(symbols.button.props.find((prop) => prop.name === "count")?.literal.value, 3);
  assert.equal(symbols.button.props.find((prop) => prop.name === "disabled")?.literal.value, false);
  assert.deepEqual(symbols.button.texts.map((entry) => entry.value).join(""), "Don't click");
  assert.deepEqual(symbols.div.classTokens, ["card", "p-4"]);
  assert.deepEqual(symbols.div.children.length, 2);
  for (const symbol of Object.values(first.symbols)) {
    assert.equal(symbol.range.file, "Card.jsx");
    assert.ok(symbol.range.startOffset < symbol.range.endOffset);
    assert.ok(symbol.range.startLine >= 1);
  }
  assert.equal(first.unsupported.length, 0);
});

test("out-of-subset constructs fail as unsupported with reasons", () => {
  const mixed = buildCodeIr([{ path: "E.jsx", content: "<section>ok</section><div onClick={handler}>x</div>" }]);
  assert.equal(mixed.rootIds.length, 1);
  assert.match(mixed.unsupported[0].reason, /non-literal.*expression attribute/u);
  const exprChild = buildCodeIr([{ path: "E.jsx", content: "<section>ok</section><div>{items}</div>" }]);
  assert.match(exprChild.unsupported[0].reason, /expression child/u);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: "<><div /></>" }]), /fragments/u);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: "<div><span>" }]), /no supported elements/u);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: "<div></span>" }]), /no supported elements/u);
  assert.throws(() => buildCodeIr([{ path: "E.txt", content: "<div />" }]), CodeIrUnsupportedError);
  const nested = "<div>" + "<section>".repeat(40) + "x" + "</section>".repeat(40) + "</div>";
  // A failed element is skipped whole: no nested <section> is promoted to a root (#123).
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: nested }]), /no supported elements: unparseable top-level JSX: JSX nesting exceeds maxDepth/u);
  const unclosedDeep = "<div>" + "<section>".repeat(40);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: unclosedDeep }]), /maxDepth/u);
});

test("stray top-level angle brackets become unsupported regions, not silent loss", () => {
  const ir = buildCodeIr([{ path: "Mix.jsx", content: "if (a < b) { }\n<span>ok</span>" }]);
  assert.equal(ir.rootIds.length, 1);
  assert.equal(ir.unsupported.length, 1);
  assert.match(ir.unsupported[0].reason, /stray angle bracket/u);
});

test("CSS subset parses flat rules and reports at-rules", () => {
  const parsed = parseCssFile("card.css", CARD_CSS);
  assert.equal(parsed.symbols.length, 1);
  assert.equal(parsed.symbols[0].name, ".card");
  assert.equal(parsed.symbols[0].props.length, 2);
  assert.equal(parsed.unsupported.length, 1);
  assert.match(parsed.unsupported[0].reason, /at-rule/u);
  assert.throws(() => parseCssFile("x.css", ".a { color: red; "), /unclosed/u);
});

test("Tailwind classes preserve verbatim and map only on exact match", () => {
  assert.deepEqual(tokenizeClassList("  card  p-4  "), ["card", "p-4"]);
  const mapped = mapClassTokens("card p-4 unknown", [{ fromClass: "p-4", toToken: "space.4" }]);
  assert.deepEqual(mapped.preserved, ["card", "p-4", "unknown"]);
  assert.deepEqual(mapped.mapped, [{ fromClass: "p-4", toToken: "space.4" }]);
  assert.deepEqual(mapped.unmapped, ["card", "unknown"]);
});

test("AST-aware patches apply by range and reject mismatches", () => {
  const ir = cardIr();
  const symbols = Object.fromEntries(Object.values(ir.symbols).map((symbol) => [symbol.name, symbol]));
  const button = symbols.button;
  const textAnchor = button.texts[0];
  const titleProp = symbols.h1.props.find((prop) => prop.name === "title");
  assert.ok(titleProp);
  const { files, applied } = applyPatch(ir, [{ path: "Card.jsx", content: CARD }], [
    {
      op: "update-text",
      targetSymbolId: button.id,
      anchor: { range: textAnchor.range, expectedText: "Don't click" },
      replacement: "Do click",
    },
    {
      op: "update-prop",
      targetSymbolId: symbols.h1.id,
      anchor: { range: titleProp.range, expectedText: 'title="Hello"' },
      replacement: 'title="Hi"',
    },
  ]);
  assert.equal(applied, 2);
  assert.ok(files[0].content.includes(">Do click<"));
  assert.ok(files[0].content.includes('title="Hi"'));
  assert.ok(!files[0].content.includes("Don't click"));
  // Unrelated-code preservation: everything outside the two patched ranges is byte-identical.
  assert.equal(CARD.split("Don't click").length, 2);
  assert.equal(CARD.split('title="Hello"').length, 2);
  assert.equal(files[0].content, CARD.replace("Don't click", "Do click").replace('title="Hello"', 'title="Hi"'));
  assert.throws(() => applyPatch(ir, [{ path: "Card.jsx", content: CARD }], [
    {
      op: "update-text",
      targetSymbolId: button.id,
      anchor: { range: textAnchor.range, expectedText: "wrong text" },
      replacement: "Do click",
    },
  ]), CodeIrConflictError);
  assert.throws(() => applyPatch(ir, [{ path: "Card.jsx", content: CARD }], [
    {
      op: "update-prop",
      targetSymbolId: button.id,
      anchor: { range: textAnchor.range, expectedText: "Don't click" },
      replacement: 'title="Hi"',
    },
  ]), /not a recorded prop/u);
  assert.throws(() => applyPatch(ir, [{ path: "Card.jsx", content: CARD }], [
    {
      op: "update-text",
      targetSymbolId: "code-symbol:deadbeef",
      anchor: { range: textAnchor.range, expectedText: "Don't click" },
      replacement: "x",
    },
  ]), /unknown/u);
});

test("three-way merge reconciles disjoint edits and reports conflicts", () => {
  const base = "line1\nline2\nline3\n";
  const ours = "line1\nours2\nline3\n";
  const theirs = "line1\nline2\ntheirs3\n";
  const clean = threeWayMerge(base, ours, theirs);
  assert.deepEqual(clean.conflicts, []);
  assert.equal(clean.merged, "line1\nours2\ntheirs3\n");
  const clash = threeWayMerge(base, "line1\nours2\nline3\n", "line1\ntheirs2\nline3\n");
  assert.equal(clash.merged, null);
  assert.equal(clash.conflicts.length, 1);
  assert.equal(clash.conflicts[0].startLine, 2);
  const identical = threeWayMerge(base, base, base);
  assert.equal(identical.merged, base);
});

test("round-trips are stable in both directions on golden fixtures", () => {
  const doc = {
    componentName: "Card",
    root: {
      tag: "div",
      props: { className: "card p-4" },
      children: [
        { tag: "h1", props: { title: "Hello" }, text: "Welcome" },
        { tag: "button", props: { count: 3, disabled: false }, text: "Do click" },
      ],
    },
  };
  const code = designToCode(doc);
  assert.ok(code.includes("export function Card()"));
  assert.ok(code.includes('className="card p-4"'));
  const ir = buildCodeIr([{ path: "Card.jsx", content: code }]);
  const back = codeToDesign(ir, ir.rootIds[0], "Card");
  assert.deepEqual(back, doc);
  const codeAgain = designToCode(back);
  assert.equal(codeAgain, code);
  assert.equal(roundTripFingerprint(doc), roundTripFingerprint(back));
  assert.throws(() => designToCode(ir, "code-symbol:missing", "Card"), CodeIrValidationError);
});

test("bounds and malformed inputs fail closed", () => {
  assert.throws(() => buildCodeIr([]), CodeIrUnsupportedError);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: "" }]), CodeIrValidationError);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: "x".repeat(300 * 1024) }]), /maxSourceBytes/u);
  // Every token is at least one character, so the token budget covers any source the size limit lets through.
  assert.ok(CODE_IR_HARD_LIMITS.maxTokens >= CODE_IR_HARD_LIMITS.maxSourceBytes);
  assert.throws(() => parseJsxFile("E.jsx", "<div>" + "b".repeat(5000) + "</div>"), /exceeds 4096/u);
  assert.equal(Object.keys(buildCodeIr([{ path: "E.jsx", content: "<i />".repeat(CODE_IR_HARD_LIMITS.maxSymbols) }]).symbols).length, CODE_IR_HARD_LIMITS.maxSymbols);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: "<i />".repeat(CODE_IR_HARD_LIMITS.maxSymbols + 1) }]), /maxSymbols/u);
  // Nested elements count once against maxSymbols (#250): 1,600 cards of three elements each.
  const cards = Array.from({ length: 1600 }, (_, index) => `<section><h2>Card ${index}</h2><p>Text ${index}</p></section>`).join("");
  assert.equal(Object.keys(buildCodeIr([{ path: "E.jsx", content: `<main>${cards}</main>` }]).symbols).length, 4801);
  const wide = (children) => `<ul>${"<li />".repeat(children)}</ul>`;
  assert.equal(Object.keys(buildCodeIr([{ path: "E.jsx", content: wide(CODE_IR_HARD_LIMITS.maxChildrenPerSymbol) }]).symbols).length, CODE_IR_HARD_LIMITS.maxChildrenPerSymbol + 1);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: wide(CODE_IR_HARD_LIMITS.maxChildrenPerSymbol + 1) }]), /maxChildrenPerSymbol/u);
  // Runs of text around the most children an element may have fit (#256); more are refused by name.
  const runs = buildCodeIr([{ path: "E.jsx", content: `<ul>${"a<li />".repeat(CODE_IR_HARD_LIMITS.maxChildrenPerSymbol)}a</ul>` }]);
  assert.equal(Object.values(runs.symbols).find((symbol) => symbol.name === "ul").texts.length, CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: `<p>${"{\"a\"}".repeat(CODE_IR_HARD_LIMITS.maxTextRunsPerSymbol + 1)}</p>` }]), /p has more than 4097 runs of text/u);
  // One patch carries at most maxPatchOps edits, and says how many it had.
  assert.throws(() => applyPatch(buildCodeIr([{ path: "E.jsx", content: "<p>a</p>" }]), [{ path: "E.jsx", content: "<p>a</p>" }], Array.from({ length: CODE_IR_HARD_LIMITS.maxPatchOps + 1 }, () => ({}))), /this change has 5001 edits, more than the 5000 one write-back can carry/u);
  const hugeNumber = "<div n={" + "9".repeat(400) + "} />";
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: hugeNumber }]), /finite|no supported elements/u);
  assert.throws(() => buildCodeIr([{ path: "E.jsx", content: '<div a="1" a="2" />' }]), /duplicate props/u);
  assert.throws(() => designToCode({ componentName: "card", root: { tag: "div", props: {} } }), CodeIrValidationError);
  assert.throws(() => designToCode({ componentName: "Card", root: { tag: "9div", props: {} } }), CodeIrValidationError);
  assert.throws(() => designToCode({ componentName: "Card", root: { tag: "div", props: { title: "a\nb" } } }), /must not span lines/u);
  const bigBase = Array.from({ length: 1200 }, (_, index) => `line${index}`).join("\n");
  const bigOurs = `${bigBase}\nours-extra`;
  const bigTheirs = `${bigBase}\ntheirs-extra`;
  const budgeted = threeWayMerge(bigBase, bigOurs, bigTheirs);
  assert.equal(budgeted.merged, null);
  assert.match(budgeted.conflicts[0].reason, /quadratic diff budget/u);
});

test("provenance marks the package as project-owned", () => {
  assert.equal(CODE_IR_PROVENANCE.package, "@ninerr/code-ir");
});
