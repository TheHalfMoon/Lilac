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
- **Forms.** In those three contexts a `<form>` is unwrapped, keeping its children, instead of becoming a `<div>`. Above an `li`, `dd` or `dt` it becomes a `<section>` (review delta 2). It is still counted in `dangerousElementsRemoved` and reported in the neutralisation diagnostic. In ordinary flow it still becomes a `<div>`.

## Scope: inputs whose own parse is representable

Some HTML parses to a tree that no HTML string can express. Foster parenting can put an `<a>` inside an `<a>` (`<a><table><a>`), and the parser clones formatting elements when it reopens them. This is a property of the input, not of the import.

The fixpoint is therefore required for every input whose own parsed tree is representable, that is, where parse5's serialize-then-parse is a fixpoint for the source itself. Unrepresentable inputs are skipped and counted, and the generated-markup test requires at least half its inputs to be in scope; most are.

There is no exemption inside an in-scope input. If sanitising makes a representable tree unrepresentable, re-import catches it as a real divergence. That is how the list-item form bug in review delta 2 was found.

## Review delta 1

**Combined judge, must-fix:**
1. **The exemption was too broad.** It fired on any same-tag nesting, including expressible `li>ul>li` and `p>button>p`. It then weakened the check for the whole document, so on base the form bug next to a nested list went undetected. Delta 1 fixed this with a nesting detector and a strict check of the rest of the source. Delta 2 replaced both with the scope rule, because the detector could not be made sound. The judge's two inputs are now test 14; on base it fails and reports the minimal input `<table><form>`.
2. **SVG links lost the link role.** Intake gave the link role only to `href`, so a qualified `xlink:href` no longer counted. Intake now accepts both (test 12).

**Combined judge, worth-considering:**
- **Too narrow:** headings, `dd`/`dt` and `option`/`optgroup` close each other as groups. They are now handled as groups.
- **Serializer gaps:** the leading LF in `pre`, `textarea` and `listing`; raw text inside foreign content; and `plaintext`, which has no end tag. These are fixed in the test serializer, a future product exporter must handle them too, and the generator now covers them (test 11).

**Security judge (no must-fix), worth-considering:**
- **Uncounted form attributes.** An unwrapped form's attributes were dropped without being counted. They are now counted as the `<div>` path counts them.
- **Foreign `<link>`.** It merged `href` and `xlink:href`; it is now dropped.

Both are covered by test 13. The security judge also confirmed that `xml:base` in SVG is now caught. parse5 reported it as a bare `base`, which slipped past the remote-authority set before the qualified names.

**Spec note.** Item 2 says "the existing import fixtures", but no import fixture files exist apart from the malicious corpus. The four inline pages in test 2 stand in for them.

## Tests

`tests/import-idempotence.test.mjs` has 14 tests. Tests 1 to 8 were in the first version: with the import-stack changes stashed, 2, 3, 5, 6 and 7 fail on base, and each failure reports its minimal input. Tests 9 to 14 were added in review delta 1.

1. Every non-rejected malicious-corpus case (43) re-imports to itself with nothing more removed.
2. Four realistic pages re-import to themselves: stylesheets, entities, SVG `use` with both link attributes, tables with forms, hostile attributes and `template`.
3. 600 seeded generated documents over context-sensitive tags re-import to themselves. A failure reports its seed, a `LILAC_PROPERTY_SEED` replay and the shrunk minimal HTML.
4. Import is byte-deterministic, and its structural view does not depend on source attribute order.
5. Two to six stylesheets keep document order.
6. `xlink:href` and `href` on one element stay two resources.
7. Forms in table, SVG and paragraph contexts are unwrapped, counted, and re-import stably. In ordinary flow a form still becomes a `<div>`.
8. The string shrinker reaches a minimal failing input.
9. Unrepresentable sources are out of scope. Expressible nestings, foreign nesting and the review shapes are in scope and strict. Rewritten in review delta 2.
10. The `<pre>`, `<textarea>` and `<listing>` leading-LF cases, SVG `noscript`, `plaintext` and SVG `input` all re-import exactly.
11. The generator covers headings, `dl`/`dt`/`dd`, `optgroup`, `caption`, `listing`, `xmp`, `nobr`, `marquee` and LF-leading text.
12. An SVG `xlink:href` link keeps its link role.
13. An unwrapped form's handlers, URLs and styles are counted, and a foreign `<link>` is unwrapped with its children kept.
14. The two review inputs are fixpoints. On base this test fails.

## Residual

The proposal does not record where each `<link rel=stylesheet>` sat relative to the inline `<style>` elements. A product exporter or renderer must therefore treat link stylesheets as preceding the inline ones; this is recorded for the future exporter.

## Review delta 2

The delta-1 re-review found three must-fix items. Two showed that the delta-1 exemption rule (a nesting detector, plus cutting the exempt subtree out of the source by its offsets) could not be made sound:
- **Lost namespaces.** Proposal nodes carry no namespace, so expressible SVG nestings such as `<svg><a><a>` were exempted. That hid the SVG form divergence beside them.
- **Clone offsets.** Formatting elements cloned by the parser keep the original's start offset, so the cut removed source that belonged outside the exempt subtree.

The exemption is removed and replaced by the scope rule above. A test checks that the foster-parenting and clone cases are out of scope, and that the review's shapes, including SVG `a>a`, are in scope and strict.

**Third must-fix, in the product.** A `<form>` turned into a `<div>` changes the `li`/`dd`/`dt` rule: a form is a special element that stops the parser's search for an open list item, and a div does not. So `<ul><li><form><li>x` re-imported as two sibling `li` elements. Unwrapping the form fails the same way, because the two `li` then touch. Above a list item the form now becomes a `<section>`, which stops that search too and is a generic block when unlabelled.

Caveats of using `<section>`:
- it is sectioning content, so it scopes `header` and `footer` beneath it;
- if it carries an `aria-label`, it is a region.

**Worth-considering items, also fixed:**
- **Counting.** An unwrapped element's attributes are now counted by the same rules as the attribute loop, with qualified names: authority attributes, `srcset`, event handlers, unsafe styles, and unsafe URL and presentation attributes. An unwrapped SVG form with `xml:base`, a `javascript:` `href`, a `url()` style, `srcset` and `onclick` now counts 3 dangerous URLs, 1 unsafe style and 1 handler.
- **Foreign `<link>`.** It is now unwrapped, so its children are kept, instead of being dropped.
- **Integration points.** In the test serializer they are SVG-only (`foreignObject`, `desc`, `title`); MathML is never imported.
- **Generator.** It now leaves out some end tags, as real-world markup does.
- **Diagnostic.** The form diagnostic no longer says "into <div>", because a form may become a `<div>` or a `<section>`, or be unwrapped. The one test that pinned the old wording is updated.

The review inputs in test 14 now include the SVG `a>a` and `li>form>li` shapes. They fail on base `d45c2bb` (minimal input `<table><form>`) and on delta-1 head `4170796` (minimal input `<li><form><li>`).
