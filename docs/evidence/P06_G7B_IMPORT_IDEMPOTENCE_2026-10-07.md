# P06 G7b: import round-trip idempotence (#126)

Part of P06 gate 7 (#100). G7a (#123) covers the code-ir half. The frozen spec is in #126.

## Disposition

Lilac has no product HTML exporter for import proposals, so a product export round trip cannot be tested and is not claimed. What exists is tested instead: **sanitized import is a fixpoint**.

`tests/support/proposal-html.mjs` is a test-only reference serializer. It writes a proposal back to HTML, putting URL attributes back from the resource list and treating raw-text and foreign-content elements correctly. Re-importing that HTML must remove nothing more and give the same structural view: tree, attributes, text, stylesheets in order, and resources.

## Findings on base `0acf81c`

A seeded exploration (3,000 to 12,000 generated documents, minimised by a ddmin string shrinker) found three classes of divergence in import-stack.

1. **Stylesheet order.** `importHtmlSnapshot` sorted stylesheets by a hashed id, and the static-mirror path sorted them the same way. Document order, which decides the CSS cascade, was lost. Minimal input: `<style>}</style><style>.</style>`.
2. **`xlink:href` merged into `href`.** parse5 reports a foreign attribute such as `xlink:href` as name `href` with a prefix. Import used the bare name, so `<use xlink:href=a href=b>` kept only one of the two URLs.
3. **`<form>` neutralisation changed parsing.** Import replaces `<form>` with `<div>`, but a `<div>` parses differently from a `<form>` in some places:
   - in a table section, the parser keeps a `<form>` empty in place but moves a `<div>` out of the table;
   - in SVG or MathML, a `<div>` breaks out of foreign content, while a foreign "form" is not an HTML form at all;
   - under an open `<p>`, a `<div>` closes the `<p>`. This placement only arises through table-mode insertion.

   Minimal inputs: `<table><form>`, `<svg><form>`, `<tr><p><b><form>`.

## Changes (`packages/import-stack`)

- **Stylesheet order.** Stylesheets keep document order. In the mirror path, inline sheets keep document order and captured external sheets follow in capture order.
- **Attribute names.** Attributes use their qualified name, so `xlink:href` stays distinct from `href`.
- **Forms.** In those three contexts a `<form>` is unwrapped, keeping its children, instead of becoming a `<div>`. It is still counted in `dangerousElementsRemoved` and reported in the existing neutralisation diagnostic. In ordinary flow it still becomes a `<div>`.

## Allowed class: trees no HTML can express

Foster parenting can nest an element inside one with the same tag that the parser closes on reopen. For example, `<a><table><a>` produces an `a` inside an `a`, placed before the table. The same happens with `button`, `option` and similar tags. No HTML string produces such a tree, so no serializer can reproduce it.

For this class only, re-import may change the nesting. It must still remove nothing, and it must keep the same elements, attributes, text, stylesheets and resources. Over 12,000 generated documents, this was the only divergence left after the fixes.

## Tests

`tests/import-idempotence.test.mjs` has 8 tests. With the import-stack changes stashed, tests 2, 3, 5, 6 and 7 fail on base, and each failure reports its minimal input.

1. Every non-rejected malicious-corpus case (43) re-imports to itself with nothing more removed.
2. Four realistic pages re-import to themselves: stylesheets, entities, SVG `use` with both link attributes, tables with forms, hostile attributes and `template`.
3. 600 seeded generated documents over context-sensitive tags re-import to themselves. A failure reports its seed, a `LILAC_PROPERTY_SEED` replay and the shrunk minimal HTML.
4. Import is byte-deterministic, and its structural view does not depend on source attribute order.
5. Two to six stylesheets keep document order.
6. `xlink:href` and `href` on one element stay two resources.
7. Forms in table, SVG and paragraph contexts are unwrapped, counted, and re-import stably. In ordinary flow a form still becomes a `<div>`.
8. The string shrinker reaches a minimal failing input.

## Residual

The proposal does not record where each `<link rel=stylesheet>` sat relative to the inline `<style>` elements. A product exporter or renderer must therefore treat link stylesheets as preceding the inline ones; this is recorded for the future exporter.
