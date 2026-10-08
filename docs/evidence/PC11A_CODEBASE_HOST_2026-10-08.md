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

Runs of text inside an element that has children are bound too, as their element and their index among its texts.

**Preview.** `POST /api/codebase/preview {nodeId}` compares each bound layer with the file as it is now, field by field, against the base:

| Layer | File | Result |
|---|---|---|
| unchanged | anything | nothing to write. The base stays, so a change made only in the file is never undone later |
| changed | unchanged | the layer's value is written |
| changed | changed, to the same value | nothing to write |
| changed | changed, differently | a conflict, never written |

Every comparison is made field by field:
- **Text** is written when the source's text is one literal.
- **Props** are `className`, `style` (compared as properties, and written in the source's own order) and other literal string attributes.
- **Not written** are:
  - added or removed attributes;
  - layers added here (each one is listed);
  - layers removed here;
  - layers moved or reordered (each bound layer's place is compared with its source path);
  - runs of text moved to another element, reordered, or removed;
  - copies of a bound layer, which are reported as conflicts;
  - text holding `{ } < >`;
  - text the source writes as a `{…}` expression (such as `{" "}`), which is left as it is.

  The preview lists each one, so the person sees what stays as it is. Boolean and number props in the source are not mistaken for new attributes.
- **The whole component.** A layer inside the component plans for the whole component, from its root.
- **Read back.** Before a plan is offered, the new file is parsed again. Every written field must read back as the value written. A field that would not (whitespace, entities, a run merging with its neighbour) is left out and listed.
- **The preview** carries a unified diff, the changes, the conflicts and what is not written. It also carries a token naming this exact plan: the file's sha256 and what the file would become.

**Write.** `POST /api/codebase/write {nodeId, token}` makes the plan again and refuses unless it is the plan the person previewed. A change to the file, or to the layers, since the preview is refused. An agent editing a layer between the preview and the person's confirmation therefore cannot get unreviewed content written. The write then:
1. applies the patch through `applyPatch`, from the end of the file back;
2. writes a temporary file beside it, with the file's own permissions (not masked by the umask), fsyncs it, checks the file once more, and renames;
3. commits the layers' new bases as one transaction.

A base moves only where the layer's value was written, or where the file already had it. Text keeps the source's whitespace around it.

The file's owner and group become this user's, as Lilac writes it.

**Only the person.** All of these are editor routes behind the person's session token. The MCP endpoint has no codebase tool, so an agent can neither connect a folder, read from it, nor write to it.

**Confinement.** Every source path:
- is relative, with forward slashes only, no `..`, `.` or empty part, and no `:` (a Windows drive or alternate data stream);
- is a `.jsx` or `.tsx` file and not a link;
- resolves through the native realpath to inside the folder. The native realpath gives the true case on macOS and Windows, which the overlap check with the projects folder also uses;
- is at most 256 KiB.

## Tests

`tests/codebase.test.mjs` covers:
- **The links file:** it is owner-only (0600), and a links file others can write is ignored.
- **Folders:** a relative path is refused, as are a missing folder, a file, the projects folder or anything inside it, a folder holding the projects folder, and the root.
- **Files:** `..` in every form, an absolute path, an empty part, the wrong extension, a link to a file outside, and a file over the size limit are all refused.
- **The scan** (it also stops after 20,000 directory entries in all, and says so):
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
- **Keeping the file's changes, and writing only what was previewed:**
  - A run of text is bound.
  - The source's boolean prop gives no spurious note.
  - A file-only change to a field the person did not touch survives the write and every later preview, and that field keeps its base.
  - A run of text is written with its surroundings kept.
  - The file keeps 0664.
  - A layer changed after the preview makes the write refused (`plan-changed`), and nothing is written.
  - An added layer is listed, a moved one is listed, and a copy of a bound layer is a conflict on both.
- **Paths** with a backslash, a drive (`C:`), an alternate stream (`:`) or `./` are refused too.
- **Runs of text** (`<p>Hello <b>x</b>{" "}and more</p>`):
  - A child layer previews for its whole component, with nothing spurious.
  - The `{" "}` expression is left as it is and listed.
  - The other runs are written and read back.
  - The bindings still hold afterwards.
  - A run moved into another element is listed and not written to its old place.
  - A removed run is listed.
