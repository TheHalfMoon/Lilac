# PC6b: design and code through the product

PC6b closes PC gate 11: the design/code workflow through the product, which means exporting JSX through `code-ir` and bringing code into the design. PC6a (#164) closed gate 10.

## Design

**Reused, not rebuilt:**
- `@lilac/code-ir`: `designToCode`, `buildCodeIr` and `codeToDesign` handle JSX in both directions, in code-ir's documented subset.
- `@lilac/renderer`: `planElement` is the renderer's own sanitizer. It decides what an exported layer contains.
- The studio session commits code brought into the design as an ordinary attributed, undoable transaction.

**Export** (`exportJsx`, `packages/studio-host/src/code.ts`). A layer and everything inside it become one function component, named from the layer's name in PascalCase (`Price card` gives `PriceCard`).
- **What the canvas shows.** Each layer is reduced by `planElement` first, so the code holds exactly what the canvas draws:
  - only allowlisted tags, so a `script` layer becomes the `div` the canvas shows;
  - only safe attributes, with no event handlers;
  - only safe styles, with no `url()`.
- **Conversions:**
  - `class` becomes `className`, and a link's `href` is restored from the canvas's inert form;
  - the style is written as a CSS string prop, which Preact, Solid and Qwik accept;
  - a text layer with no tag, attributes or style of its own folds into its parent's text when it is the parent's only content.
- **Output** is deterministic.
- **Bounds:** 5,000 layers, and a depth of 32.
- **code-ir's emitter limits** are reported as a clean refusal: text over 4,096 characters, more than 256 children on one layer, and a value containing a line break.

**Bring code in** (`importJsx`):
- A JSX function component of at most 256 KiB, in code-ir's subset (elements, text, literal props), is parsed by code-ir.
- Code containing anything code-ir cannot read, such as fragments, spreads or expression props, is refused whole, with the reason. It is never partly imported.
- The element brought in is the declared export's own, found by its component symbol, and the root layer is named after it.
- The code becomes layers inside a new page frame, as one `restore-subtree` committed as the person's change, with intent `Bring in <Name>` and tool `lilac:code`:
  - `className` becomes `class`, and a style string becomes style properties, keeping custom properties (`--brand`);
  - `{true}` becomes an empty attribute, and `{false}` is left out, as in JSX;
  - text keeps its order around elements: alone, it is the element's text; mixed with elements, each run of text is its own text layer;
  - a component (`<Button>`) is kept as a named layer, which the canvas draws as a box.
- Undo removes it in one step.

**Routes:** `POST /api/code/export { nodeId }` and `POST /api/code/import { code }`.

**The editor's Code dialog:**
- it shows the selected layer as code, with Copy;
- it brings a component into the design.

**Agents.** MCP gains Paper's `get_jsx`, a read tool, through the same export. Lilac now implements 16 of Paper's 36 tools.

**Limits of the subset.** These come from code-ir and are stated, not hidden:
- JSX expressions other than literals are not brought in;
- when exported, text mixed with elements is written as `span`s, so a mixed paragraph re-imports with those spans;
- style objects are not read; style strings are.

## Tests

**`tests/code-workflow.test.mjs`:** 3 Node tests and 1 Chromium test.
1. **Export.** The exact JSX for a card is checked. It has no handler and no `url()` style, the script becomes a `div`, entities are escaped, and the output is deterministic. code-ir reads it back to the same tags and text.
2. **Import.** A `Hero` with a class, a style string, an attribute and a `<Button>` component becomes the expected layers. Empty code, a fragment and code over 256 KiB are refused.
3. **The editor, end to end:**
   - with nothing selected, the dialog says so;
   - a component is brought in from code, and the canvas shows its colour and text;
   - the layer is selected and its width changed in the inspector; exporting the selection then shows code that follows the edit (`width: 600px`);
   - that code brought back in gives the same design again, with equal styles;
   - undo removes it in one step;
   - there are no foreign requests and no page errors.
4. **MCP.** Code brought in through the route is attributed (`lilac:code`, `Bring in Note`), and an agent's `get_jsx` returns the layer's JSX.

The MCP tool count assertion is now 16.

## Review delta 1

The security and correctness judge found nothing that injects code or makes anything executable. It confirmed that export escaping is sound against hostile titles, classes, text and data values, that `componentName` is constrained, and that `el()`'s deeper flattening only ever appends text nodes. Bounds, ids, attribution, undo and `get_jsx`'s classification are correct. It found two must-fix issues, both now fixed.

**Fixed:**
- **Partial or misdirected code import.** code-ir records constructs it cannot read and carries on, and the import used the first element under the first export's name. One component could be imported under another's name, or a spread silently dropped. Now any unsupported region refuses the whole import, and the root is the declared export's own element, found through its component symbol.
- **Mixed text was reordered.** For example, `<p>Click <a>here</a> to start</p>` came in as "Click  to start" followed by the link. Text and elements are now placed in source order using code-ir's ranges.

**Also taken:**
- the root layer is named after the component, so export → import → export keeps the name;
- CSS custom properties survive;
- `{true}` and `{false}` follow JSX;
- the emitter limits are stated above.

**New test cases (test 2):**
- the declared export is chosen, by name, over an earlier helper;
- the judge's two partial-import cases are refused;
- mixed text keeps its order;
- booleans and custom properties.
