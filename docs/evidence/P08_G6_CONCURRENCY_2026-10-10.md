# P08-G6: concurrency and races

Issue: #230 (P08 umbrella), founder section P08.6: concurrency and races on the supported surfaces; prove every claimed semantic, and promise no others.

**Status: the claimed semantics are pinned by tests. Two races found and fixed: #260 (#263) and #261 (#264).**

## What Ninerr supports at the same time
- **The studio host** is the single writer of one open project. The editor, other tabs and agents send it requests that may arrive at the same time. Node handles each request's change in one turn, so changes never interleave inside one another. The order in which they arrive decides which is applied.
- **One host per projects folder** (#261, #264). A second host on the same folder refuses to start, so the folder-wide files have one keeper. These are the connected agents, the codebase links and the discovery file.
- **Out of scope, and not promised:**
  - several people editing one project together (`packages/collaboration` has no shared editing yet; see `docs/ARCHITECTURE.md`);
  - merging concurrent edits;
  - one project open in two hosts.

## The semantics, and the test that pins each

| Semantic | Test |
|---|---|
| An edit carries the revision it was made at. One made at a stale revision is refused (`409 stale-revision`), never rebased or merged. Of 25 edits made at one revision and sent at once, exactly one is applied, and only its change is in the project. | `tests/concurrency.test.mjs` |
| 25 edits sent at once, each at the revision the previous one makes, form one unbroken chain of revisions, with no gap and no repeat. The project holds exactly the applied edits. | `tests/concurrency.test.mjs` |
| A single-use import review commits once, however many times it is sent at once. The others get `404 import-not-found`. | `tests/concurrency.test.mjs` |
| A single-use write-back preview writes once, however many times it is sent at once. The others get `409 plan-changed`, and the file holds the one change. | `tests/concurrency.test.mjs` |
| A person's edits, undos and redos and an agent's MCP changes, all at once over 12 rounds, end in a result or a typed refusal, never a server error. Every change reaches the editor's event stream once, in revision order. The project reopened in a new host is exactly the one shown. | `tests/concurrency.test.mjs` |
| A change made for one project is never applied to another. Another tab opening a project, or one opened while a change's body is still arriving, leads to a refusal (`409 project-changed`). An agent changes only the project it last connected to or read. | `tests/project-scope.test.mjs` (#260, #263) |
| A second host on a projects folder is refused (`409 projects-folder-in-use`), naming the first. A claim left by a crashed host is taken over. | `tests/folder-lock.test.mjs` (#261, #264) |
| A project open in one writer is refused to another (`project-locked`). A lock held by a live process is never broken. A lock left by a process that is gone is broken only with a stated reason. | `tests/studio-host.test.mjs` |
| An agent's deletion waits for the person. One approval serves every identical waiting call, and the number waiting is capped. | `tests/mcp-server.test.mjs` |

**Run on Windows 11 (Node 24) five times in a row:** all pass, with the same outcomes each time. Over the 12 mixed rounds that was 48 applied and 23 refused as stale. CI runs the same tests on Linux.

## What the probes found
- **#260, data integrity, fixed by #263.** After a project switch, an editor tab's edit, or an agent's write, was applied to the other project. Edits named no project, and every new project starts at revision 0. Now:
  - the editor names its project in every request, and each dialog names the one it was opened for;
  - the host refuses a change made for another project;
  - an agent must have read the project it changes.
- **#261, data loss, fixed by #264.** Two hosts on one projects folder silently lost each other's connected agents and codebase links. A third host saw only the agents the last writer had kept. The desktop app and `npm start` use the same default folder. Now a host claims the folder while it runs.

## Not covered here
- **Concurrency inside the desktop application's process tree** (the window, its renderer and the host): P08-G8.
- **Several people at once:** not supported, and not promised.
