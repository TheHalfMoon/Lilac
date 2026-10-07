# P06 G6: malicious HTML/CSS/SVG corpus (#117)

Part of P06 gate 6 (#100).

## Corpus

`tests/fixtures/malicious/` holds 42 cases, one `.html` file each, across the categories `html`, `url`, `css`, `svg` and `mxss`. `manifest.json` records for each case:
- its description;
- its expected outcome;
- for imported cases, the exact expected security summary.

One case, `mxss-math`, is rejected with `ImportValidationError`: the MathML subtree is dropped entirely, which leaves no importable nodes. That is fail-closed. All other cases import.

Adding a case means adding a file and a manifest entry. The test checks that the two lists match.

## Invariants

Checked for every case by `tests/malicious-corpus.test.mjs`, which has 47 tests and runs in about 3 s:
- the outcome and exact security summary match the manifest;
- `validateImportProposal` passes;
- no forbidden tag survives;
- no `on*`, `srcdoc`, `srcset` or form-authority attribute survives;
- no attribute value starts with `javascript:`, `vbscript:`, `data:`, `file:` or `blob:`;
- inline styles, presentation attributes and stylesheets pass an independent CSS view in the test. It applies CSS Syntax preprocessing, so CR LF, CR and FF become LF, then removes comments and decodes escapes. It finds no fetching or executing function or at-rule. The test therefore does not reuse the sanitizer it checks;
- URL-bearing attributes keep only inert values (a fragment or a proven local object);
- no host-acting attribute survives;
- resources are http(s), without userinfo or secret-bearing queries;
- the link role is given only to `<a>`;
- the pinned Impeccable `scanStaticHtml` treats each case as data, completing with findings bound to the case.

Text content is not held to the patterns. For example, markup inside RCDATA `<textarea>` or `<title>` is inert text.

## Finding fixed

SVG `<use href="https://...">` was recorded as a `link` resource. `<use>` and `<feImage>` fetch their reference as a subresource, so they are now `image` resources. The corpus test for this fails on base `462bf7a`. Intake semantics were unaffected, because the link role requires `<a>`.

## Review delta 1: breaks found by the adversarial judge

The judge ran 81 further vectors and found five breaks. All are fixed and now corpus cases; each fails on the pre-delta head.
1. **CSS escape plus CR LF.** `\75&#13;&#10;rl(` hid `url(` in `style` and `fill`, and likewise `@import` and `image(`. The sanitizer's escape decoding consumed only the CR, while a browser folds CR LF into one LF first. `cssSecurityView` now performs CSS input preprocessing (CR LF, CR and FF to LF; NUL to U+FFFD) before decoding.
2. **Beacons.** `ping`, `attributionsrc` and `imagesrcset` survived, and with them `longdesc`, `xml:base`, `itemid`, `manifest`, `codebase` and similar. They are now stripped as `REMOTE_AUTHORITY_ATTRIBUTES`, counted in `dangerousUrlsRemoved`, and rejected by `validateImportProposal`.
3. **Host-acting attributes.** `is`, `commandfor`, `command`, `popovertarget` and similar are stripped as `HOST_AUTHORITY_ATTRIBUTES`, counted and rejected in the same way.
4. **`<animateColor>`.** It is now forbidden and dropped with its subtree.
5. **No base URL.** `safeUrl` returned scheme-less values unchanged, so `java&#9;script:` stayed a link that a URL parser reads as `javascript:`. Without a base URL, a relative value is now kept only when parsing it against a sentinel base keeps the sentinel origin.

The judge also found that SVG `pattern`, `filter`, `textPath`, `cursor`, `mpath` and `tref` references were labelled `link`. They are now `image` subresources. This is a labelling fix.
