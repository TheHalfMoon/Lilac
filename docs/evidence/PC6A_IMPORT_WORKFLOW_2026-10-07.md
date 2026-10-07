# PC6a: import → edit → save → reopen through the product

PC6a closes PC gate 10: import → edit → save → reopen through the UI. PC6b, design and code, closes gate 11.

## Design

**Reused, not rebuilt.**
- `@lilac/import-stack` (`importHtmlSnapshot`, `commitImportProposal`) parses and sanitizes.
- `@lilac/intake` (`reviewImport`, `inferSemantics`) reviews.
- The studio session commits, through the same attributed, undoable, persisted path as every other edit.

**Offline by construction.** The host imports with `defaultImportPolicy("offline")`, so nothing the page links to is fetched. Website and URL imports, which need a network-policy grant, are not offered in the editor.

**The flow** (`packages/studio-host/src/imports.ts`, `ImportDesk`):
1. `POST /api/import { html, name }` parses and reviews the HTML (at most 4 MiB, the import stack's own limit) and returns a summary:
   - layer counts;
   - what was removed for safety (scripts, event handlers, unsafe links, elements and styles);
   - the accessibility findings count;
   - notes on what is not carried over;
   - `commitReady` and any blocking reasons.

   Nothing changes yet. At most 4 reviews wait at a time, each for at most 10 minutes. They are dropped when the project closes.
2. In the editor, the person reads the review and chooses Import or Discard.
3. `POST /api/import/commit { proposalId }` consumes the review. It builds the import stack's own transaction against the current document, then commits it as the person's change with intent `Import <name>` and tool `lilac:import`:
   - the imported layers go inside a new page frame, named after the import;
   - ids already in the document (from an earlier import of the same page) get a fresh suffix;
   - inline `style` (`cssText`) becomes style properties, which the renderer re-checks;
   - intake's observed semantics are kept in `props.semantics`, as `commitIntake` does.

**Editor.** "Import HTML" opens a dialog to choose a file or paste HTML, followed by the review dialog. After the import, the new page is selected and the canvas fits it. Undo removes the whole import in one step.

**Not carried, and stated in the review:**
- stylesheets (`<style>` and linked CSS), because the renderer applies inline styles only;
- linked resources, such as remote images and fonts, because imports are offline.

## Tests

**`tests/import-workflow.test.mjs`:** 2 Node tests and 1 Chromium test.
1. **`styleProperties`:** `cssText` becomes style properties, with names lowercased and malformed declarations dropped.
2. **Host:**
   - **Before committing:** with no project open, an import is refused. Empty HTML gets 400. The review reports 1 script, 1 event handler, the unsafe URLs, 1 stylesheet and the not-fetched note, and it changes nothing.
   - **The commit:** revision 1, `Import Pricing page` with tool `lilac:import` by the person. The new frame is named after the import, the heading's inline style becomes properties, and semantics are kept. No `steal` handler survives, and a review can be committed only once.
   - **Re-import:** the same page imported again does not collide.
   - **Undo and limits:** undo removes an import in one step. A discarded review cannot be committed, and over 4 MiB gets 413.
3. **Editor, end to end:**
   - **Import:** choose `pricing.html` in the Import dialog; the review shows "1 script removed, 1 event handler removed" and the stylesheet note. On Import, the canvas shows the heading with its inline colour and text, and no remote image or live link.
   - **Edit and save:** edit the heading's text from the layers tree and inspector, then Save.
   - **Reopen:** quit the host, start a new one, and reopen the project from the dialog. The document deep-equals what was saved, and the canvas shows the edited text and the colour.
   - **Isolation:** no request ever leaves the host, including for the page's linked stylesheet and image, and there are no page errors.

`tests/support/editor.mjs` is a small shared helper to open the editor from a launch link with foreign requests blocked.
