# PC10: the release-candidate journey

PC10 closes PC gate 17: "A release-candidate end-to-end test covering the whole user journey" (issue #178).

The journey is MASTER_PLAN's definition of genuinely complete: a fresh user can install, create and edit, use an agent, connect a codebase, round-trip a component, and export, without hidden paid infrastructure.

## The test

`scripts/journey-desktop.mjs` runs the journey against the packaged desktop app, the release candidate. It uses the archive that `scripts/package-desktop.mjs` built in the same job, on each supported platform's runner: Linux x64, macOS arm64 and Windows x64 (`.github/workflows/desktop.yml`).
- **A person's run.** The packaged app runs as a person runs it (`scripts/desktop/drive.mjs`, shared with the smoke test). It starts with a fresh home and projects folder, behind a local proxy that records every connection the browser side makes off the computer, and is driven over Chromium's remote-debugging protocol.
- **The agent** is an MCP client. It talks to Lilac's own endpoint on 127.0.0.1, using the credential the editor showed.

Its 17 steps:

| Step | What a person does | What must hold |
|---|---|---|
| 1 | Unpacks and starts Lilac | The packaged app runs as packaged and shows the projects dialog |
| 2a | Creates a project; imports an HTML page | The review reports the page's 2 linked resources as not fetched. Nothing is committed while it is shown (still revision 0), then it is committed |
| 2b | Renames the page; inserts a box; moves it with "Move right 10 pixels"; makes it Wider; sets its fill | The box is 10 px further right and 10 px wider, and the canvas draws the fill |
| 2c | Edits the heading's text layer in the inspector | The canvas shows the new text |
| 2d | Undo, then Redo | The text goes back, then forward again |
| 3a | Connects an agent in the editor | The credential (`lilac_agent_…`) and Lilac's MCP URL (`http://127.0.0.1:<port>/mcp`) are shown. Reopening the agents dialog lists the agent but never shows its credential again |
| 3b | The agent: `initialize`, `tools/list` | Lilac's tools are listed, including `create_artboard` and `delete_nodes` |
| 3c | The agent: `create_artboard`, `update_styles` | The artboard appears live in the tree, and the history attributes the change to "Journey agent · agent · update_styles" |
| 3d | The agent: `delete_nodes` | While the approval dialog waits, nothing is deleted: still revision 11, artboard present. After the person approves, the artboard is gone |
| 4 | Brings a JSX component in through the Code dialog | It becomes layers: a `section.card` with its heading |
| 5 | Exports the component, brings the export in, exports the copy | The copy's code is the same as the original's, with its styles, heading and paragraph |
| 6 | Exports the imported page, and brings that export in | It is JSX (`export function LaunchPage()`) with the edited heading, and it reads back as layers |
| 7a | Saves and closes the window | Lilac quits with 0 and releases the project |
| 7b | Starts Lilac again and opens the project | The same revision. The same layers, in tree order and at the same levels. The page and the component export the same code as before. The box keeps its fill |
| 7c | Closes the window | Lilac quits with 0 |
| 7d | (after the run) | The project's journal records the agent's three changes as the agent's (`actorKind: agent`) |
| 8 | Throughout | Nothing left the computer from the browser side in any launch, and no account or key was asked for |

**Locally.** In this container, the Linux x64 package passed every step as an unprivileged user. The evidence for each platform is in the Desktop workflow's annotations ("Release-candidate journey evidence"), which give the head, the target and the steps passed.

## How the journey reads "connect a codebase" and "export"

The frozen spec (#178) reads these two words narrowly, and so does this test:
- **"Connect a codebase"** is shown as bringing a component's JSX source into the design through the Code dialog, which is what the product does today (PC6b). There is no repository or folder binding: Lilac does not open a source folder, watch files or link a layer to its file. MASTER_PLAN D2's "bind real repository components" asks for more. That is tracked on #181.
- **"Export"** is the component or page as JSX in the Code dialog, for the person to copy. No file is written, and the desktop app refuses downloads.

Whether the release needs the wider reading is a scope decision for the founder (#181).

## Where the test differs from the frozen spec

**Spec item 7** says "the history still names the agent" after the reopen. It does not.
- **What the editor shows.** Its history panel lists the changes made since the project was opened. After a reopen it says "No changes since this project was opened."
- **What is kept.** Who made each earlier change is still in the project's journal: every transaction carries its actor and how it arrived. The editor just does not show it after a reopen.
- **What the test checks instead.** The attribution while the agent works (step 3c), the journal's record of it (step 7d), and the reopened state (step 7b).
- **Tracked on #179.** Showing a reopened project's earlier history is a product change.

**Style order.** The round trip compares the original and the copy, which are identical. The check is written so that it does not depend on the order of style entries in the code: the store keeps style keys in sorted order (see #172).

## Also in this grain

- **Shared driver.** `scripts/desktop/drive.mjs` holds the packaged-app driver, and the smoke test now uses it too.
- **The catalog.** The architecture catalog marks the desktop bridge implemented, with its boundary. The catalog's drift check (`tests/architecture.test.mjs`) only looked at packages with a `src/index.*`, so it had missed `@lilac/desktop`. It now checks every workspace package.
