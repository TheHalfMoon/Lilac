import test from "node:test";
import assert from "node:assert/strict";

import {
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
  const deep = buildCodeIr([{ path: "E.jsx", content: nested }]);
  assert.ok(deep.unsupported.length > 0);
  assert.ok(deep.rootIds.length <= 1);
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
  assert.throws(() => parseJsxFile("E.jsx", "<div>" + "a ".repeat(9000) + "</div>"), /token budget/u);
  assert.throws(() => designToCode({ componentName: "card", root: { tag: "div", props: {} } }), CodeIrValidationError);
  assert.throws(() => designToCode({ componentName: "Card", root: { tag: "9div", props: {} } }), CodeIrValidationError);
});

test("provenance marks the package as project-owned", () => {
  assert.equal(CODE_IR_PROVENANCE.package, "@lilac/code-ir");
});
