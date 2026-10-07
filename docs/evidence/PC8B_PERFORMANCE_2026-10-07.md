# PC8b: large-document performance through the editor

PC8b closes PC gate 13: large-document canvas and render performance qualification, including the architecture's 10,000-node edit and render benchmark. It also closes the renderer and canvas frame budget that the P06 G3 evidence deferred.

## Budgets (MASTER_PLAN, PC gate 13) and measurements

**How it is measured.** `tests/editor-performance.test.mjs` runs headless Chromium against a real studio host, on a project of 10,000 layers: one page holding 9,999 absolutely positioned cards. The editor records standard User Timing measures, which the test reads through `performance.getEntriesByName`. Every measure ends when the editor's DOM has been updated, before the browser paints.

| Budget | Measure | Limit | Measured in this container (3 runs) |
|---|---|---|---|
| First render of a 10,000-node document | `lilac:render-project`: from requesting the open project's document from the host, through fetch and parse, to the drawn canvas and panels | 2 s | 554, 531 and 501 ms |
| Applying a single-node change: properties | `lilac:apply-change`: from receipt of the change-stream event to the patched canvas and panels, p95 over about 40 changes | 100 ms | 18.5, 26.4 and 22.8 ms |
| Applying a single-node change: a layer added | the same, p95 over 30 inserts | 100 ms | 51.8, 51.6 and 61.6 ms |
| Applying a single-node change: a layer removed | the same, p95 over 30 removals | 100 ms | 50.5, 46.7 and 58.6 ms |
| End-to-end edit on 10,000 nodes: a move | `lilac:edit`: from the request, through the persisted commit, to the patched editor, p95 over 30 Shift+Arrow nudges | 750 ms | 462, 452 and 436 ms |
| End-to-end edit on 10,000 nodes: a delete | the same, p95 over 20 layers deleted from the tree with the Delete key | 750 ms | 533, 557 and 532 ms |

The test asserts each budget, prints the measurements on every run (`# PC8 gate 13: …`), and runs on CI.

**What "first render" does not include.** It excludes the host opening the project from disk (reading and verifying the snapshot and replaying the journal), which happens before the editor asks for the document. For the record, the test also reports the whole open, from the click in the projects dialog to the drawn canvas: 1,861, 1,829 and 1,970 ms in the same runs. That is within 2 s here, but the test does not assert it. Opening cost is O(journal), tracked in #154.

## What had to change to meet them

The first measurement exceeded the budgets. Applying a property change took 527 ms at p95, applying an added or removed layer 394 ms, an edit about 900 ms, and a delete in the editor about 1.5 s.

**Editor: applying a change.**
- **Applying.** The editor's copy of the document followed each change with `applyTransaction`, which clones, re-validates and re-sorts the whole document: 128 ms at p50 on 10,000 nodes.
  - The new `applyCommittedTransaction` in `@lilac/history` applies a transaction that the host has already validated and committed to the caller's own copy, in place. It uses the same operation code, without the clone and revalidation.
  - If an operation does not apply, the editor fetches the document again, as before.
  - Property tests check that it matches `applyTransaction` exactly.
- **The layers tree** was rebuilt on every change, and twice, because the canvas also reported the selection.
  - A change now reconciles the tree only under the parents it touches: rows that exist are kept and moved, missing rows are built, and removed rows are dropped.
  - A property change only relabels the affected rows.
  - While a change is being applied, the canvas's selection report does not redraw anything, and an unchanged selection redraws nothing.

**Host: an edit, 573 ms → about 260 ms (p50, 10,000 nodes).** Each edit validated and cloned the whole document several times.
- **The history base.** Each edit re-derived the history state from a clone of the store's document, a full validation of about 180 ms. The session is the store's only writer, so it now keeps the document it last committed as the next edit's base. The store still validates and applies every transaction itself. The cached base is rebuilt whenever its revision does not match the store's.
- **The store** applied each transaction twice: once to validate it, and once more from its journal form, so that memory always equals replay.
  - When the journal form, read back, is exactly the validated transaction (compared value by value, with `Object.is`, so `-0` read back as `0` counts as different), the second application would give the same document, so the first result is used.
  - Otherwise the store applies the journal form again, as before. The P06 test "values JSON cannot represent are refused, and memory always equals replay" exercises that fallback.
- **What remains** is collaboration's attributed apply and the store's own validated apply (each about 120 ms), plus the durable journal append.

## Tests

**`tests/editor-performance.test.mjs`:** the budgets above.
1. The project is built in batches under the 1 MiB request limit, and opened in the editor. All 10,000 layers are drawn.
2. Forty property changes come from another client, then 30 added layers and 30 removed ones. Each added layer has its row in the tree, in its place, and each removed one's row is gone.
3. Thirty Shift+Arrow nudges are made in the editor.
4. Twenty layers are deleted from the tree. Their rows are gone and the rest stay.

The test waits for each edit's own measure, which is recorded when the edit's response arrives. That can be just after the same change, arriving on the event stream, has updated the revision shown. There are no foreign requests and no page errors.

**`tests/history-committed.test.mjs`:** `applyCommittedTransaction` produces exactly the document and affected ids that `applyTransaction` does, over seeded random sequences:
- of single operations of every type;
- of transactions of up to four operations;
- of undos, whose removals come back as `restore-subtree`.

It throws on an operation that does not apply.

**`tests/studio-web-serving.test.mjs`:** a request body over the limit is answered with 413 promptly. It guards against a hang suspected during this work; the hang turned out to be in the test, not the host.
