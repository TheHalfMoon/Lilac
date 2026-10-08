# PC11b: a connected codebase, in the editor and the journey

PC11b is the editor part of PC11 (#182). It closes #181. PC11a gave the studio host a connected codebase. PC11b puts it in the person's hands and in the release-candidate journey.

## In the editor

The Code dialog has a Codebase section.
- **Nothing connected.** The section asks for a folder of JSX or TSX components, by its full path, and offers "Connect folder".
- **Connected.** It shows:
  - the folder and a "Disconnect" button;
  - the exported components found in it, each with "Bring in";
  - a note when the scan was cut off at its limit.
- **Bring in.** It brings the component into the design as one undoable change, bound to its source, and selects it.
- **A layer from the codebase.** For a selected layer that came from the codebase, or holds one, the section offers "Write changes back to <file>". That shows the plan:
  - the number of changes and the unified diff;
  - what changed both here and in the file, which is not written;
  - what is not written back.

  "Write to file" appears only when there is something to write. It writes exactly the previewed file, or is refused if the file has changed since the preview.
- **A folder that can no longer be read** is reported, with "Disconnect".

## Tests

**`tests/codebase-workflow.test.mjs`** (Chromium, the real editor and host):
1. It connects a folder; its one component is listed.
2. It brings the component in, then edits its heading (with `&`) and its fill in the inspector.
3. It reviews the diff: the old and new heading and the new fill appear, and the file is unchanged.
4. It writes. The status says "Wrote 2 changes to PriceCard.jsx.", and the file is exactly the original with those two changes.
5. The file is changed outside Lilac and the same heading is edited again. The review now reports a conflict, there is nothing to write and no "Write to file" button, and the file keeps its own change.
6. No foreign request is made and no page error occurs.

**The release-candidate journey** (`scripts/journey-desktop.mjs`) now does steps 4a and 4b through the packaged app on each runner:
- connect a folder;
- bring its component in;
- edit the heading and fill;
- review the diff (nothing written yet);
- write it back. The file on disk then has exactly the two changes.

Locally, the Linux package passed all 18 steps. The evidence for each platform is in the Desktop workflow's "Release-candidate journey evidence" annotations.
