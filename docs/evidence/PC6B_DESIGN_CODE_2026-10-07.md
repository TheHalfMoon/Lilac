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
- **Bounds:** 5,000 layers, and a depth of 32 (code-ir's own limit).

**Bring code in** (`importJsx`):
- A JSX function component of at most 256 KiB, in code-ir's subset (elements, text, literal props), is parsed by code-ir. Unsupported constructs, such as fragments, are refused with code-ir's reason, not guessed.
- The code becomes layers inside a new page frame, as one `restore-subtree` committed as the person's change, with intent `Bring in <Name>` and tool `lilac:code`:
  - `className` becomes `class`, and a style string becomes style properties;
  - a component (`<Button>`) is kept as a named layer, which the canvas draws as a box.
- Undo removes it in one step.

**Routes:** `POST /api/code/export { nodeId }` and `POST /api/code/import { code }`.

**The editor's Code dialog:**
- it shows the selected layer as code, with Copy;
- it brings a component into the design.

**Agents.** MCP gains Paper's `get_jsx`, a read tool, through the same export. Lilac now implements 16 of Paper's 36 tools.

**Limits of the subset.** These come from code-ir and are stated, not hidden:
- JSX expressions other than literals are not brought in;
- mixed text and elements keep each text as its own `span`;
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
