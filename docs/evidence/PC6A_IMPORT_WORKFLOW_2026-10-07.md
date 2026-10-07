# PC6a: import → edit → save → reopen through the product

PC6a closes PC gate 10: import → edit → save → reopen through the UI. PC6b, design and code, closes gate 11.

## Design

**Reused, not rebuilt.**
- `@lilac/import-stack` (`importHtmlSnapshot`, `commitImportProposal`) parses and sanitizes.
- `@lilac/intake` (`reviewImport`, `inferSemantics`) reviews.
- The studio session commits, through the same attributed, undoable, persisted path as every other edit.

**Offline by construction.** The host imports with `defaultImportPolicy("offline")`, so nothing the page links to is fetched. Website and URL imports, which need a network-policy grant, are not offered in the editor.

**The flow** (`packages/studio-host/src/imports.ts`, `ImportDesk`):
1. `POST /api/import { html, name }` parses and reviews the HTML. The limits are the import stack's offline policy: at most 2 MiB and 10,000 elements. It returns a summary:
   - layer counts;
   - what was removed for safety (scripts, event handlers, unsafe links, elements and styles);
   - the accessibility findings count;
   - notes on what is not carried over;
   - `commitReady` and any blocking reasons.

   Nothing changes yet. At most 4 reviews wait at a time, each for at most 10 minutes. They are dropped when the project closes.
2. In the editor, the person reads the review and chooses Import or Discard.
3. `POST /api/import/commit { proposalId }` commits the change as the person's, with intent `Import <name>` and tool `lilac:import`. The review is used up only once the commit succeeds. The change is built when the import is reviewed (see review delta 1):
   - it is one `restore-subtree` of a new page frame, named after the import, which holds the imported layers;
   - its nodes are the ones import-stack's commit makes;
   - import ids derive from a fresh request id, so a page imported twice does not collide, and a collision is refused anyway;
   - inline `style` (`cssText`) becomes style properties, which the renderer re-checks;
   - intake's observed semantics are kept in `props.semantics`, as `commitIntake` does;
   - the import's provenance (`requestId`, `proposalId`, `inputSha256`, `sourceKind`, `requestedAt`) is kept in the transaction's `metadata.lilac.provenance.import`.

**Editor.** "Import HTML" opens a dialog to choose a file or paste HTML, followed by the review dialog. After the import, the new page is selected and the canvas fits it. Undo removes the whole import in one step.

**Not carried, and stated in the review:**
- stylesheets (`<style>` and linked CSS), because the renderer applies inline styles only;
- linked resources, such as remote images and fonts, because imports are offline.

## Tests

**`tests/import-workflow.test.mjs`:** 3 Node tests and 1 Chromium test.
1. **`styleProperties`:** `cssText` becomes style properties, with names lowercased and malformed declarations dropped.
2. **Host:**
   - **Before committing:** with no project open, an import is refused. Empty HTML gets 400. The review reports 1 script, 1 event handler, the unsafe URLs, 1 stylesheet and the not-fetched note, and it changes nothing.
   - **The commit:** revision 1, `Import Pricing page` with tool `lilac:import` by the person. The new frame is named after the import, the heading's inline style becomes properties, and semantics are kept. No `steal` handler survives, and a review can be committed only once.
   - **Re-import:** the same page imported again does not collide.
   - **Undo, provenance and limits:** undo removes an import in one step, and a discarded review cannot be committed. The journal records the import's provenance. The offline policy's limits are 2 MiB and 10,000 elements; over 2 MiB gets 413.
   - **Large imports (test 3):**
     - 5,000 top-level elements review as ready and commit as one operation;
     - a page whose layers would exceed one journal entry is reported as not ready, with the reason, and cannot be committed;
     - a commit that fails (the project must be reopened) keeps its review.
3. **Editor, end to end:**
   - **Import:** choose `pricing.html` in the Import dialog; the review shows "1 script removed, 1 event handler removed" and the stylesheet note. On Import, the canvas shows the heading with its inline colour and text, and no remote image or live link.
   - **Edit and save:** edit the heading's text from the layers tree and inspector, then Save.
   - **Reopen:** quit the host, start a new one, and reopen the project from the dialog. The document deep-equals what was saved, and the canvas shows the edited text and the colour.
   - **Isolation:** no request ever leaves the host, including for the page's linked stylesheet and image, and there are no page errors.

`tests/support/editor.mjs` is a small shared helper to open the editor from a launch link with foreign requests blocked.

## Review delta 1

The security and correctness judge found the sanitizing, the offline guarantee, authorization, attribution, undo, and the per-project clearing all sound, and the editor UI free of markup injection. It found two must-fix issues, both now fixed.

**Fixed:**
- **A review marked ready could fail to commit and was then lost.** The commit used one operation per top-level element, so 5,000 elements hit the session's 5,000-operation cap. A large page could also exceed persistence's 4 MiB journal entry. And the review was deleted before the commit was attempted. Now:
  - The change is a single `restore-subtree` of the new page frame, whatever the page's shape.
  - It is built and measured when the import is reviewed. A change over 3.5 MiB is a blocking reason, so the review never says ready for something that cannot commit.
  - The review is used up only after the commit succeeds.
  - **Faster review.** Building the change once also cut the time to review a 5,000-element page from about 295 s to well under a second. The earlier code called the import stack's commit, which applies one operation per root, and validated the proposal once per root; the proposal is now validated once and walked directly.
- **The limits were wrong.** The offline policy allows 2 MiB and 10,000 elements, not 4 MiB and 25,000. The host, the editor's message and this document now use the policy's own values.

**Also taken:**
- **Provenance.** It is kept in the transaction, as `commitIntake` keeps it.
- **Id remapping removed.** The old id remap could never run, because import ids are already unique per request. A collision check takes its place.
- **Editor errors.** A failed commit in the editor follows the usual edit handling: a project that needs reopening closes the dialog and offers Reopen, and other errors leave the review open to try again.
- **Body limit.** The request limit for an import allows JSON-escaped HTML, which can be up to six times larger.
- **Nesting.** The page frame is a `div`, so imported content with its own `<main>` is not nested inside another.

**Recorded, not changed:**
- **Commit cost** grows with the document. This is persistence's O(document) commit, tracked as #154.
- **A large change event** may exceed a slow stream's buffer. The editor then refreshes.
