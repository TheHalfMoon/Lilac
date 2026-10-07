# PC1: studio host

PC1 adds `@lilac/studio-host`, the single writer of an open project for every product surface. The editor (PC4), the MCP endpoint (PC5), local web mode (PC7) and the desktop shell (PC9) all build on it. It advances PC gate 4, the persistence and reopen workflow. The gate closes in PC4, once the UI reports recovery and locks.

## What it composes
It rebuilds none of these.

| Need | Existing package used |
|---|---|
| The project and the only document authority | `@lilac/persistence`: `createProject`, `openProject`, `ProjectStore.commit`/`checkpoint`/`close` and `RecoveryReport` |
| Edits and their inverses | `@lilac/history`: `createHistoryState`, and the transaction and inverse produced per commit |
| Who may edit, and attribution | `@lilac/collaboration`: `LocalCollaborationRoom.commitTransaction`, which authorizes through the access oracle and stamps `metadata.collaboration` |
| Loopback classification | `@lilac/network-policy`: `isLoopbackAddress` |

## Behaviour

**Projects.** Projects live in one directory per name under a configured projects root. Only plain names (letters, digits, `.`, `_` and `-`, at most 64 characters, never `..`) can be created or opened, so the API grants no other filesystem authority. Opening a locked project answers `409 project-locked`. A stale lock is replaced only when the request gives a non-empty reason, and the override and previous holder appear in the returned `recovery` report. The same applies to a repaired torn journal tail.

**Edits.** An edit names the revision it is based on. A stale base is refused (`409 stale-revision`) rather than rebased. An invalid edit (`400 invalid-edit`) leaves the revision unchanged. Every edit runs through the collaboration room as the session's actor, then through `store.commit`.

**Undo and redo** are new committed transactions:
- undo commits the stored inverse, with `tool: "lilac:undo"` and `metadata.lilac.undoOf`;
- redo re-applies the original operations, with `tool: "lilac:redo"` and `metadata.lilac.redoOf`.

So they are durable, attributed history like any other edit. The undo stack itself lives only for the session, which matches the master plan's in-memory history; after reopen the project is exactly as persisted.

**Change stream.** `GET /api/events` is a server-sent event stream. It sends a `project` event on connect and on every open or close, and a `change` event per commit. A change event carries the revision, transaction id, actor and actor kind, intent, tool, `affectedNodeIds` and any undo/redo link. The renderer (PC2) patches from `affectedNodeIds`, and agent edits (PC5) arrive the same way.

**Security envelope.**
- The host listens on 127.0.0.1 only and verifies the bound address is loopback.
- It serves only loopback peers.
- It requires `Host` to name `127.0.0.1:<port>` or `localhost:<port>`, which defeats DNS rebinding.
- It refuses any foreign `Origin`.
- It requires a 256-bit per-launch token, as `Authorization: Bearer` or `?token=` for `EventSource`, compared in constant time.
- Request bodies must be JSON and at most 1 MiB, so a cross-site form post cannot reach a route. Body-less POSTs are allowed.
- Responses carry `no-store`, `nosniff`, `default-src 'none'` and `no-referrer`.
- Unexpected errors are reported without internals.

## Tests
`tests/studio-host.test.mjs` has 4 tests that drive the real HTTP server:
1. **The security envelope:**
   - a missing, wrong or truncated token;
   - a rebinding `Host`;
   - a foreign `Origin` (refused) and its own origin (allowed);
   - a non-JSON body, an oversize body and invalid JSON;
   - the traversal, absolute, nested, hidden, empty and long project names;
   - an unknown route, and an edit with no project open.
2. **The workflow:**
   - create a project, then edit, and see that same event arrive on the live stream;
   - a stale edit and an invalid edit;
   - rename, undo, redo, undo twice past the redone change, then redo;
   - checkpoint.

   The journal shows every change, including undo and redo, with its link and collaboration attribution. Close and reopen restores the persisted state with an empty undo stack. Re-creating the project is refused. The stream reports the reopen.
3. **Locks and recovery:** a second host is refused with `project-locked`, a blank override reason is refused, and an override with a reason is reported. A torn tail is repaired and reported on the next open.
4. **A projects root that is not a directory** is refused.

## Catalog
`studio-host` is a new subsystem (owner `@lilac/studio-host`, status `stub` for this slice). It depends on persistence, history, collaboration and network-policy, and appears in `IMPLEMENTED_PACKAGES`.

## Review delta 1

Two judges reviewed the first head: a combined correctness judge and a security judge. Their probes are in the session scratchpad. Must-fix findings:

- **Unbounded collaboration log.** The session kept one collaboration room, whose fact log grew with every edit. Each commit re-normalized the whole log (the judge measured 1.2 s and then 8.2 s per 200 edits), and the log would eventually fill at 16,384 facts. Attribution already lives in the persisted transaction, so the room is now built per commit from the session's grants. New test 8 runs 1,800 edits and requires the sixth batch to stay near the first.
- **A failed open or create closed the current project.** The new project is now opened before the current one is closed. The current one is closed first only when it is the same project, whose own lock would otherwise block the reopen.
  - A missing project is now `404 project-not-found`.
  - A corrupt or unreadable project is `422 project-unreadable`.
  - A project from another version is `422 project-version`.
  - New test 5 covers these.
- **Internals in errors.** Edit failures used to forward any error message, including a filesystem error carrying an absolute path, as `400 invalid-edit`. Now only typed, path-free validation errors (history, document-model, collaboration validation and store validation) are echoed. A store that cannot be written, or whose files changed, marks the session `project-needs-reopen` (409). `GET /api/session` reports that state, and no path is shown. Anything else is the generic 500. New test 6 covers this.

Also taken:
- **Project names.** A project directory that is a symbolic link out of the root is refused (`invalid-project`). Windows device names (CON, NUL, COM1 and the like) and names ending in a dot are refused.
- **Locks.** `breakStaleLock` refuses to break a lock whose recorded process is still running (`409 lock-held-by-live-process`). The lock test now overrides a lock left by a process that no longer exists.
- **Event stream.**
  - At most 32 streams can be open.
  - A stream whose client stops reading is dropped once 1 MiB is buffered; the client resynchronizes from `GET /api/document`.
  - Change events carry an SSE `id` (the revision) and the committed `operations`, so a client can apply a change without refetching.
- **Token.** The query token is accepted only on `GET /api/events`.
- **Limits.** An edit may hold at most 5,000 operations (413). Header and request timeouts are 10 s and 30 s, with at most 128 connections.
- **Undo.**
  - Undo and redo stacks are per actor, so an agent's edits (PC5) never enter the user's undo.
  - An undo or redo that history can no longer apply is a `409` conflict and is kept on the stack.
  - New test 7 checks every operation type (insert, remove of a deep subtree, move, set-props with unset, restore-subtree, and several operations per edit). Undo-all restores the start and redo-all the end, both deep-equal, and the persisted state equals the session's after reopen.
- **Create.** A failed create removes the directory it made.

Recorded, not changed:
- The undo stack holds operations and inverses for up to 200 edits per actor, which is bounded by the 5,000-operation cap per edit.
- The pattern for the editor's token is set in PC4: a one-time bootstrap rather than a token in the page URL.
