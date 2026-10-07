# PC8a: WCAG 2.2 AA checklist for the Lilac editor

**What this is.** This document assesses PC gate 12. It covers the editor application (`packages/studio-web`, served by `npm start`) and its generated output (exported JSX), against every WCAG 2.2 Level A and AA success criterion. 4.1.1 Parsing is removed in WCAG 2.2.

**Status values:**
- **Supports**;
- **Partially supports**, with the gap stated;
- **Not applicable**, with the reason.

**Evidence types:**
- **T:** an automated test in `tests/editor-accessibility.test.mjs`, run in Chromium on every CI run;
- **A:** `auditAccessibility` from `@lilac/design-assurance`, run on the live DOM of every editor state, using the colours the browser actually paints (part of T);
- **I:** assessed by inspection of the source and behaviour, with the reasoning given.

**The canvas.** The rendered design inside the canvas frame is `inert`, and the frame itself is `aria-hidden` and not a Tab stop. The design is therefore outside the accessibility tree and takes no input (PC2, PC3, PC8a). It is the person's own content, not editor chrome. The layers tree, the inspector, and the keyboard commands are its accessible form.

**Generated output.** Exported code carries the person's design faithfully, so its accessibility is the design's. T checks that an accessibly made design exports to code that audits clean, and that missing alt text or button names in exported output are found.

## Perceivable

| Criterion | Level | Status | Evidence |
|---|---|---|---|
| 1.1.1 Non-text Content | A | Supports | A: every editor state (no `image-alt` findings). Icon-only controls carry text names: zoom "Zoom out" and "Zoom in"; the step buttons "Move left 10 pixels" and so on. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | Not applicable | The editor has no audio or video. Media in a person's design is their content. |
| 1.2.2 Captions (Prerecorded) | A | Not applicable | As 1.2.1. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | Not applicable | As 1.2.1. |
| 1.2.4 Captions (Live) | AA | Not applicable | As 1.2.1. |
| 1.2.5 Audio Description (Prerecorded) | AA | Not applicable | As 1.2.1. |
| 1.3.1 Info and Relationships | A | Supports | A: `control-label` and `heading-order` give no findings. The layers panel is an ARIA tree with `aria-level`, `aria-expanded` and `aria-selected`. Panels are landmarks (`nav`, `main`, `aside`) with headings, and the toolbar groups are labelled. Code brought in keeps `htmlFor`, and export keeps the id a label points to (T). |
| 1.3.2 Meaningful Sequence | A | Supports | I: the DOM order is the reading order: toolbar, layers, canvas, inspector, history, status. The 320 px layout reorders visually but keeps that DOM order. |
| 1.3.3 Sensory Characteristics | A | Supports | I: no instruction relies on shape, position or sound. |
| 1.3.4 Orientation | AA | Supports | I and T: no orientation lock; the layout reflows down to 320 px wide. |
| 1.3.5 Identify Input Purpose | AA | Not applicable | No field collects personal information about the person. The fields are project, layer and agent names, styles and code. |
| 1.4.1 Use of Color | A | Supports | I: selection is shown by outline, background and an inset bar, plus `aria-selected`. Agent history entries say "agent" in text, and errors are text. |
| 1.4.2 Audio Control | A | Not applicable | No audio. |
| 1.4.3 Contrast (Minimum) | AA | Supports | A: `text-contrast` is checked on computed colours in every editor state, with no findings. Muted text is #55526a on white (7.50:1), and disabled text is #5c596e on #efeef4 (5.86:1), so even inactive controls clear 4.5:1. |
| 1.4.4 Resize Text | AA | Supports | I: text sizes are CSS pixels, so browser zoom scales all text and controls to 200 %. At 200 % zoom on a 640 px-wide window the layout is the reflowed one T checks at 320 px. |
| 1.4.5 Images of Text | AA | Supports | I: the editor uses no images of text. |
| 1.4.10 Reflow | AA | Supports | T: at 320 px there is no horizontal scrolling. The canvas, layers, inspector and history are all within the viewport width (panels stack), and so is every dialog (import, agents, code, projects). Both were fixed in PC8a: the layout used to need 840 px, and the import dialog's file field widened it. |
| 1.4.11 Non-text Contrast | AA | Supports | I: the focus ring (#1a5fd0, 3 px) is 5.85:1 against white and 5.44:1 against the page background. Input borders (#8e8aa3) are 3.33:1 against white. A selected layer row is marked by a 3 px accent bar (#5b3fd6), added in PC8a; it is 5.27:1 against the row's own background, where the light background alone was 1.27:1. The canvas selection outline (#6d4aff) is 4.26:1 against the stage. All ratios were computed with `contrastRatio` from `@lilac/design-assurance`. |
| 1.4.12 Text Spacing | AA | Supports | I: no text container has a fixed height that would clip. Buttons use `min-height`, panels scroll, and line height is relative. |
| 1.4.13 Content on Hover or Focus | AA | Supports | I: the editor shows no hover or focus popups or tooltips. The skip link appears on focus, in place, and goes away on blur. |

## Operable

| Criterion | Level | Status | Evidence |
|---|---|---|---|
| 2.1.1 Keyboard | A | Supports | T: one keyboard-only journey covers:<br>• creating a project, and Tab reaching every toolbar button;<br>• inserting;<br>• the layers tree (Home, arrows, collapse and expand, select);<br>• renaming and the step buttons in the inspector;<br>• the skip link, which lands on the canvas;<br>• panning the canvas with the arrows when nothing is selected (added in PC8a: panning used to need the wheel);<br>• nudge, delete, undo and redo;<br>• opening a dialog and closing it with Escape;<br>• save.<br>I: the remaining controls (the other dialogs, Revert, Disconnect, the file field) are native buttons and fields, reached by Tab like the ones tested. |
| 2.1.2 No Keyboard Trap | A | Supports | I and T: dialogs are modal `<dialog>` elements. Dismissible ones close with Escape, returning focus to the opener (T). The ones that need an answer (approval, reopen, lock-held) have buttons to give it. The "open Lilac from its launcher" notice, shown when a page has no session, has nothing to operate and holds no focus. |
| 2.1.4 Character Key Shortcuts | A | Supports | I: single-key commands (arrows, Delete, Escape) work only while the canvas or the layers tree has focus. Global shortcuts need Ctrl or Cmd, and are ignored while typing in a field. |
| 2.2.1 Timing Adjustable | A | Supports | I: the editor imposes no time limits on the person. A launch link expires after two minutes as a security measure, and a new one is available at any time by pressing Enter where Lilac runs. An agent's request for approval waits 5 minutes and can be asked again. |
| 2.2.2 Pause, Stop, Hide | A | Supports | I: nothing moves, blinks or auto-updates, apart from content changing because of edits. |
| 2.3.1 Three Flashes or Below Threshold | A | Supports | I: nothing flashes. |
| 2.4.1 Bypass Blocks | A | Supports | T: the first tab stop is "Skip to canvas", and it is visible when focused. Panels are landmarks. |
| 2.4.2 Page Titled | A | Supports | I: the title is "<project> — Lilac", or "Lilac". |
| 2.4.3 Focus Order | A | Supports | T: Tab follows the toolbar order. Dialogs take focus and return it when closed, and the layers tree has a single tab stop with roving focus. I: below 900 px the canvas is shown above the layers panel while Tab still visits the layers first (DOM order). That order is meaningful, since the layers describe the canvas. |
| 2.4.4 Link Purpose (In Context) | A | Supports | A: `link-name` gives no findings. The editor's only link is the skip link. |
| 2.4.5 Multiple Ways | AA | Not applicable | The editor is one application screen, not a set of pages. |
| 2.4.6 Headings and Labels | AA | Supports | A: there are headings for the brand, every panel and every dialog. Every field has a visible label. |
| 2.4.7 Focus Visible | AA | Supports | T: every toolbar control shows a 3 px focus ring when reached by Tab. The canvas, reached by keyboard or by the skip link, shows an inset 3 px ring, drawn on its top layer so the design never covers it. T samples the painted pixel, zoomed in until the design fills the canvas. The design frame is not a Tab stop. Both were added in PC8a: the canvas used to show no ring, and the frame was an invisible stop. Tree rows and fields use the same ring. |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Supports | I: nothing is sticky or overlaid apart from modal dialogs, which hold the focus themselves. |
| 2.5.1 Pointer Gestures | A | Supports | I: the canvas uses no path-based or multipoint gestures. Wheel zoom has the Zoom buttons and Ctrl+−/= as alternatives, and wheel panning has the arrow keys and Fit. |
| 2.5.2 Pointer Cancellation | A | Supports | I: buttons act on click, on the up event. A drag commits on release, and moving the pointer back before release commits nothing (T, PC3). Selection on press can be undone by clicking empty canvas or pressing Escape. |
| 2.5.3 Label in Name | A | Supports | I: visible text is the accessible name for text buttons. The step buttons were changed in PC8a from "W+" style labels to "Narrower", "Wider", "Shorter" and "Taller". Symbol-only buttons (arrows, −, +) have names. |
| 2.5.4 Motion Actuation | A | Not applicable | Nothing is operated by device motion. |
| 2.5.7 Dragging Movements | AA | Supports | T: moving and resizing, the only dragging on the canvas, can be done by single clicks on the inspector's step buttons, added in PC8a. They are also available through the X, Y, width and height fields. |
| 2.5.8 Target Size (Minimum) | AA | Supports | T: every visible button, field and tree row is at least 24 by 24 px. |

## Understandable

| Criterion | Level | Status | Evidence |
|---|---|---|---|
| 3.1.1 Language of Page | A | Supports | I: `<html lang="en">`. |
| 3.1.2 Language of Parts | AA | Not applicable | The editor's text is all in one language. Text in a person's design is their content. |
| 3.2.1 On Focus | A | Supports | I: focus never changes context. A dialog opens only on activation. |
| 3.2.2 On Input | A | Supports | I: an inspector field changes the design when it is committed (Enter, or leaving the field), which is the action the person took. It never changes context. |
| 3.2.3 Consistent Navigation | AA | Supports | I: the toolbar and panels are the same throughout. |
| 3.2.4 Consistent Identification | AA | Supports | I: the same function has the same name everywhere, for example "Save", "Import", "Revert" and "Close". |
| 3.2.6 Consistent Help | A | Not applicable | The editor offers no help mechanism. Guidance is inline in each dialog. |
| 3.3.1 Error Identification | A | Supports | I: errors are text in `role="alert"`, for example "Give a reason for taking over the project." and the host's reason for a refused import. |
| 3.3.2 Labels or Instructions | A | Supports | A and I: every field has a label, and constraints are stated, such as the project name rule and the code subset. |
| 3.3.3 Error Suggestion | AA | Supports | I: messages say what to do, for example "Choose an HTML file or paste HTML.", "Open Lilac again from its launcher." and "Reopen". |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Supports | I: every change to a design is a history transaction that can be undone, or reverted for an agent's. An agent cannot delete without the person's approval, and an import is reviewed before anything is added. |
| 3.3.7 Redundant Entry | A | Supports | I: nothing asks for the same information twice. |
| 3.3.8 Accessible Authentication (Minimum) | AA | Supports | I: the person opens a link; there is nothing to remember, transcribe or solve. An agent credential is shown in a selectable read-only field, with Copy. |

## Robust

| Criterion | Level | Status | Evidence |
|---|---|---|---|
| 4.1.2 Name, Role, Value | A | Supports | A: `button-name` and `control-label` give no findings. The tree uses the ARIA tree pattern. The canvas is `role="application"` with a name, and dialogs are named by their headings. |
| 4.1.3 Status Messages | AA | Supports | I: results are announced through `role="status"` (aria-live polite), for example "Move layer.", "Saved." and "Import Pricing page: 8 layers added.". |

## Limits

- **Assistive technology.** The automated audit and the keyboard test are evidence, not a substitute for testing with real screen readers. That is recommended before the P07 release and is not yet done.
- **The canvas.** Its rendered design is not exposed to assistive technology; the layers tree and inspector are. A person who cannot see the canvas works on the design's structure and properties, not its visual layout.

## What PC8a changed in the product

Each of these was found by the audit, the tests, or this walk through the criteria:
- **Reflow (1.4.10).** Below 900 px the panels stack under the canvas, and panel grids and inputs shrink to their column. The layout used to need 840 px.
- **Dragging alternatives (2.5.7).** The inspector has move and resize step buttons: ←, →, ↑, ↓, Narrower, Wider, Shorter, Taller. They use the canvas's new `nudge` and `resizeBy`, which commit the same transactions a drag does.
- **Label in name (2.5.3).** The resize steps use words, not "W+".
- **Non-text contrast (1.4.11).** A selected layer row gets a 3 px accent bar.
- **Contrast (1.4.3).** Disabled text is darkened to 5.86:1.
- **Focus on start.** The editor is ready only once the projects dialog is open, so focus starts in the project name field (T).
- **Labels in code (1.3.1).** Code brought in maps `htmlFor` to `for`. Export maps it back. A control a label in the export points to gets an id unique in the export (a second copy of a form gets `email-2`), and its label points to that id.
- **Canvas focus and panning (2.4.7, 2.1.1).** The canvas shows a focus ring, the skip link lands on it, and the arrows pan the view when nothing is selected.
- **Dialog reflow (1.4.10).** Dialog fields never grow wider than the dialog.

## Tests

`tests/editor-accessibility.test.mjs`: 4 Chromium tests and 1 Node test.
1. **Every editor state audits clean:**
   - the projects dialog;
   - an empty project;
   - layers, inspector and history;
   - the agents and credential dialogs;
   - the import dialog and the import review;
   - the code dialog;
   - an agent's approval request.
2. **The lock and recovery dialogs** audit clean.
3. **The keyboard journey**, with visible focus (2.1.1, 2.4.3, 2.4.7, 2.4.1).
4. **Reflow at 320 px**, and every target at least 24 by 24 px (1.4.10, 2.5.8).
5. **Generated output.** An accessibly made form exports to code whose design audits clean. A missing alt and an unnamed button in exported output are found.

## Review delta 1

The judge found the evidence genuine: the snapshot's hidden handling is sound, and every computed colour today is plain rgb with no images or translucency. Its probes confirmed 1.4.12, 1.4.4, 2.1.2, 4.1.3, 2.5.8 in dialogs, and 1.4.11. It found three claims false, all now fixed, with tests that fail against the previous code:
- **2.4.7:** the focused canvas showed no ring, and the skip link landed on a ringless `main`;
- **1.4.10:** the import dialog overflowed at 320 px;
- **2.1.1:** panning the canvas needed the wheel.

**Also taken:**
- **Export ids.** Ids are kept only when a label in the export points to them, and only once. A form exported twice under one parent had duplicated `id="email"`.
- **The snapshot fails loudly.** It reports any colour the contrast check cannot resolve (gradients, images, translucency, non-rgb colours), so findings cannot be masked silently.
- **The keyboard test** drives the skip link to the canvas by Enter, checks the ring and the panning, and adds redo.
- **2.4.3** notes the visual order at narrow widths.

**Recorded:** repeated clicks on a step button faster than each change completes are skipped with a message, as fast arrow-key nudges are. The revision contract refuses to send a change computed from an older document.

## Review delta 2

The cycle-1 re-review confirmed the reflow, panning, skip-link and id fixes, with no regressions in the PC3 canvas tests. It found two must-fix focus issues, both now fixed:
- **The canvas ring was painted under the design.** It was an inset shadow on the canvas element, below the white frame, so zooming in hid it. It is now drawn on the overlay, the canvas's top layer. T zooms in until the frame fills the canvas and samples the painted pixel at the edge; against the previous placement, it reads white.
- **The design frame was an invisible Tab stop.** It is now `tabindex="-1"` and `aria-hidden="true"`. T checks that Tab leaves the canvas for the next control.

**Also taken:**
- **Labels in a second copy.** Each copy of a labelled control gets its own id (`email`, `email-2`), and each label points to its own control. A second label used to point at the first input. T checks the pairing.
- **Backgrounds.** The snapshot's unresolved-colour guard checks background colours as well as text colours.

## Review delta 3

The cycle-2 re-review confirmed the ring on top of the design (every edge pixel reads the ring colour at 6x zoom) and the frame no longer a Tab stop. It found one must-fix, now fixed:
- **The label pairing was cubic and ran before the export's size limit.** It took 4.4 s at 2,000 label/control pairs and did not finish at 5,000. Everything ran on the studio host's one thread, and an agent could reach it through `export_code`.
  - Each id's positions are now indexed once, in document order, and a label finds its control by binary search.
  - The walk that orders the export enforces the 5,000-layer limit itself, so a larger export is refused before any pairing work is done.
  - T exports 2,000 pairs that all share one id in about 0.2 s, with every label still naming its own control, and refuses 10,000 layers at once.
