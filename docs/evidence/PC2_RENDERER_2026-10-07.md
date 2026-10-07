# PC2: renderer

PC2 adds `@lilac/renderer`, which renders a Lilac document as web semantics inside a sandboxed frame. It advances PC gate 2 (canvas and rendering surface), which PC3 closes once pan, zoom, selection and hit testing exist. It also measures the gate-13 renderer budgets that PC8 qualifies end to end.

## Design

**One module.** The renderer is a single dependency-free ES module (`packages/renderer/src/index.mjs`). It imports no Node built-ins, so the editor can serve it to the browser unchanged, as it does document-model and history.

**Rendering contract** (`docs/ARCHITECTURE.md`):
- **Web semantics.** Each node becomes one element.
- **Stable identity.** Each element carries `data-lilac-id`, and `elementFor(id)` and `nodeIdFor(element)` map in both directions. `nodeIdFor` finds the nearest rendered ancestor, which is the hit-test primitive the canvas (PC3) builds on.
- **No renderer-only document state.** The only state kept is the node-to-element map, which is derived from the document and rebuilt by `render()`.
- **An explicit sandbox for imported markup:**
  - the frame's `sandbox` is `allow-same-origin` only, with no scripts, forms, popups or top navigation;
  - its CSP is `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:`, so rendered content cannot fetch anything;
  - the parent drives the frame's DOM directly.

**Web-semantic props convention, frozen here.** A node's `props` may hold:
- `tag`: an allowlisted HTML or SVG element; it defaults by node type, for example `frame` → `div`, `text` → `span`, `image` → `img`, `vector` → `svg`;
- `text`: rendered before the node's children;
- `attributes`;
- `style`;
- `name`: the editor's layer name, never rendered.

Anything else is ignored. This is the shape the import stack already produces.

**Allowlists**, decided by the pure `planElement(node)`:
- **Tags:** HTML or SVG. Anything else, including `script`, `style`, `iframe`, `object`, `form`, `link`, `meta`, `base` and `template`, falls back to the type's default element.
- **Attributes:** global and per-element allowlists, plus `aria-*` and `data-*`. Never `on*`, `style`, `id`, `srcdoc` or `data-lilac*`.
- **URLs:** `href`/`cite` must be http(s), mailto, tel or a fragment. A link's `href` is rendered as `data-lilac-href`, so the canvas never navigates. `src` must be a base64 `data:` raster image; remote images are dropped and SVG data images are refused. `target` may only be `_blank`. Input types are allowlisted.
- **Styles:** CSS property names are checked by pattern. Values containing `url(`, `image-set`, `expression(`, `javascript:`, `@import`, `behavior:`, `-moz-binding`, backslashes, `;`, braces or angle brackets are refused.

**Incremental patching.** `patch(document, affectedNodeIds)` updates only the affected nodes, reconciling their children in place. Existing elements are reused, so an edit creates no elements and a move keeps the element. Elements that leave the document are forgotten. Roots are reconciled every time. The studio host's change events carry `affectedNodeIds` and the committed operations (PC1), which is all a client needs.

## Dependency

`playwright-core@1.56.1` (Apache-2.0, no dependencies, no install scripts) is a devDependency used only by tests to drive a local Chromium. It is in the lockfile, `THIRD_PARTY_NOTICES.md` and `docs/provenance/LICENSE_REGISTER.json`. The SBOM correctly scopes it as `excluded` (dev), and `tests/sbom.test.mjs` now expects that for dev packages. The release bundle's license collector also picks up its `ThirdPartyNotices.txt`.

`tests/support/browser.mjs` looks for Chromium in this order: `LILAC_TEST_BROWSER`, a system Chrome or Chromium, then the Playwright cache. It answers every request from the repository under a fake origin and aborts all others, so browser tests never touch the network. Without a browser the tests skip locally, but they fail in CI (`CI=true`).

## Tests

**`tests/renderer-plan.test.mjs`** (Node, 3 tests):
- every node that the import stack produces from the P06 malicious corpus plans into inert web semantics; at least 30 cases produce documents and more than 100 nodes are planned;
- hand-built hostile props are reduced to the allowlists;
- the sandbox and CSP constants.

**`tests/renderer-browser.test.mjs`** (Chromium, 4 tests):
1. **Rendering in the sandbox:** web semantics with stable identity. An `onclick` is not rendered, and links are inert (see Review delta 1).
2. **Patching:** patches for set-props, insert, move within a parent, move to another parent, and remove of a subtree. They create nothing on edits, reuse elements on moves, and forget the removed subtree. A full re-render produces the same DOM as the patched one.
3. **No fetching:** remote images and `url()` styles are dropped, and even an image inserted behind the renderer's back is blocked by the frame's CSP. No request leaves the page.
4. **Budgets:** a 10,000-node document renders in at most 2 s and single-node patches take at most 100 ms at p95, as set by PC gate 13. Measured here: a first render of 102–114 ms and a patch p95 of 0.3–0.4 ms.

## Catalog

`renderer` moves from `planned` to `stub`, owned by `@lilac/renderer`. It now depends only on document-model, because layout comes from the browser's CSS engine. Tokens, text shaping, vector editing and media stay their own planned subsystems.

## Review delta 1

The security and correctness judge found no script execution and no CSS network path. Its probes covered SVG, `<a target=_blank>`, meta, base, link, text escaping, `image-set`, `cross-fade`, `var()` assembly and `paint()`, and 1,435 random patch steps without tag changes. It confirmed that the `allow-same-origin`, no-scripts posture is sound. It found three must-fix issues, all now fixed.

**Fixed:**
- **A link click navigated the frame.** The sandbox lets a frame navigate itself, and CSP does not govern navigation. The click fetched the link target and destroyed the canvas document. The first test missed it because the route aborted the request and the test only checked the parent's URL.
  - Links are now rendered inert: `href` becomes `data-lilac-href`, styled as a link.
  - `mountSandboxedRenderer` also cancels click, middle-click, submit and Enter-activation in the frame, at capture.
  - Test 1 clicks, middle-clicks and Enter-activates the link. It asserts that no request goes to its target, that the frame document and its elements are still connected, and that no live `href` exists.
- **SVG case.** Lowercased `viewBox` and similar names never took effect. SVG attributes now keep the case the SVG DOM requires: `viewBox` and `preserveAspectRatio`. The unusable gradient, `defs` and `stop` entries were removed, because they need fragment references, which stay refused. New test 5 reads `viewBox.baseVal`.
- **A tag change was ignored by `patch`.** When a node's tag or namespace changes, its element is now rebuilt, its children move across, and the map is updated. Test 5 checks this against a fresh render.

**Also taken:**
- A trailing `!important` is applied as a priority.
- A value the browser's CSS parser rejects is counted in `stats.dropped`.
- The browser helper checks route confinement on the decoded, normalized path. `..%2f` no longer escapes `packages/*/src/`.
- The helper prefers the Chromium build matched to `playwright-core`, falling back to a system Chrome.
- New test 6: a seeded 300-step random sequence of inserts, moves, removes, props changes and tag changes. After every step, the patched DOM equals a fresh render and the identity map size.

**Consumer contract:** `data-*` and `aria-*` values pass through unchecked. They are inert in the frame, and editor code must never read them as URLs or markup.
