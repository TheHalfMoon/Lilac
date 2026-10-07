# P06 G6: malicious HTML/CSS/SVG corpus (#117)

Part of P06 gate 6 (#100).

## Corpus

`tests/fixtures/malicious/` holds 35 cases, one `.html` file each, across the categories `html`, `url`, `css`, `svg` and `mxss`. `manifest.json` records for each case:
- its description;
- its expected outcome;
- for imported cases, the exact expected security summary.

One case, `mxss-math`, is rejected with `ImportValidationError`: the MathML subtree is dropped entirely, which leaves no importable nodes. That is fail-closed. All other cases import.

Adding a case means adding a file and a manifest entry. The test checks that the two lists match.

## Invariants

Checked for every case by `tests/malicious-corpus.test.mjs`, which has 38 tests and runs in about 3 s:
- the outcome and exact security summary match the manifest;
- `validateImportProposal` passes;
- no forbidden tag survives;
- no `on*`, `srcdoc`, `srcset` or form-authority attribute survives;
- no attribute value starts with `javascript:`, `vbscript:`, `data:`, `file:` or `blob:`;
- inline styles and stylesheets pass `sanitizeImportedCssText` as safe;
- resources are http(s), without userinfo or secret-bearing queries;
- the link role is given only to `<a>`;
- the pinned Impeccable `scanStaticHtml` treats each case as data, completing with findings bound to the case.

Text content is not held to the patterns. For example, markup inside RCDATA `<textarea>` or `<title>` is inert text.

## Finding fixed

SVG `<use href="https://...">` was recorded as a `link` resource. `<use>` and `<feImage>` fetch their reference as a subresource, so they are now `image` resources. The corpus test for this fails on base `462bf7a`. Intake semantics were unaffected, because the link role requires `<a>`.
