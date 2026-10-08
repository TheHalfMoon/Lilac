# PC11a: a connected codebase, in the studio host

PC11a is the host part of PC11 (#182), which addresses #181. MASTER_PLAN's "definition of genuinely complete" asks that a person can connect a codebase. Until now the product showed that only as pasting JSX into the Code dialog. PC11 lets a person connect a real local folder, bring its components into the design with their source, and write edits back to the files. PC11b adds the editor's side and puts it in the release-candidate journey.

It reuses `@lilac/code-ir` and adds no new parser or patcher:
- the multi-file IR, with its symbols and their exact source ranges;
- the range-anchored `applyPatch`, whose anchors must match the live text exactly;
- the Code dialog's own import (`importJsx`), now able to bring in a named component and record its source.

## What the host does

**Connect.** `POST /api/codebase/connect {folder}` links one folder to the open project, recorded in `<projects>/.lilac-codebases.json`. Like the agent registry, that file is written atomically and owner-only. A file others can write is ignored. The folder must be:
- an existing directory, given by its absolute path;
- outside Lilac's projects folder, and not holding it;
- not the disk's root.

**Scan.** `GET /api/codebase` lists the exported function components in the folder's `*.jsx` and `*.tsx` files.
- It skips hidden folders, `node_modules`, `dist` and `build`.
- It follows no symbolic link.
- It is bounded: 400 files, depth 8, 256 KiB per file.

**Bring in.** `POST /api/codebase/import {file, component}` brings the named component into the design, as one undoable transaction, the same as the Code dialog's import. Each element layer records `props.codeSource`:
- the file and the component;
- the layer's position in the component's tree (the path of child indexes);
- the tag;
- the base: the source's literal values when brought in (the text, and every string prop).

**Preview.** `POST /api/codebase/preview {nodeId}` compares each bound layer with the file as it is now, field by field, against the base:

| Layer | File | Result |
|---|---|---|
| unchanged | anything | nothing to write; the base follows the file |
| changed | unchanged | the layer's value is written |
| changed | changed, to the same value | nothing to write |
| changed | changed, differently | a conflict, never written |

Every comparison is made field by field:
- **Text** is written when the source's text is one literal.
- **Props** are `className`, `style` (compared as properties, and written in the source's own order) and other literal string attributes.
- **Not written** are added or removed attributes, layers added or removed, and text holding `{ } < >`. The preview lists each one, so the person sees what stays as it is.
- **The preview** carries a unified diff, the changes, the conflicts and what is not written. It also carries the sha256 of the file it was made from.

**Write.** `POST /api/codebase/write {nodeId, sha256}` makes the plan again and refuses if the file is not the previewed one. It then:
1. applies the patch through `applyPatch`, from the end of the file back;
2. writes a temporary file beside it, fsyncs it, checks the file once more, and renames;
3. commits the layers' new bases as one transaction.

**Only the person.** All of these are editor routes behind the person's session token. The MCP endpoint has no codebase tool, so an agent can neither connect a folder, read from it, nor write to it.

**Confinement.** Every source path:
- is relative, with no `..` and no empty part;
- is a `.jsx` or `.tsx` file and not a link;
- resolves through realpath to inside the folder;
- is at most 256 KiB.

## Tests

`tests/codebase.test.mjs` covers:
- **The links file:** it is owner-only (0600), and a links file others can write is ignored.
- **Folders:** a relative path is refused, as are a missing folder, a file, the projects folder or anything inside it, a folder holding the projects folder, and the root.
- **Files:** `..` in every form, an absolute path, an empty part, the wrong extension, a link to a file outside, and a file over the size limit are all refused.
- **The scan:**
  - it lists components in nested folders, in order;
  - it skips `node_modules`, `.git` and `dist`;
  - it follows no linked folder;
  - more than 400 files are cut off and reported as cut off.
- **The whole flow over HTTP:**
  - Connecting the projects folder is refused; connecting the code folder lists its component, and the link is kept.
  - Bringing the component in records each layer's source and base.
  - With no edit, the preview has nothing to write.
  - After an edit to text (with `&`), the fill, and an attribute (with quotes), the preview shows those three changes and a diff, and writes nothing.
  - A stale sha256 is refused.
  - The write changes the file exactly as previewed, keeping the source's style order, and the bases follow it.
  - **Three-way:** a field changed only in the file is kept, a field changed only here is written, and a field changed in both is a conflict that is not written.
  - A file changed between the preview and the write is refused, and nothing is written.
  - A new attribute is listed as not written.
  - A layer not from the codebase cannot be written back.
  - Disconnecting ends it.
