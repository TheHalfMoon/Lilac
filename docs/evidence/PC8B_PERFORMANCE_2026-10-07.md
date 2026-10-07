# PC8b: large-document performance through the editor

PC8b closes PC gate 13: large-document canvas and render performance qualification, including the architecture's 10,000-node edit and render benchmark. It also closes the renderer and canvas frame budget that the P06 G3 evidence deferred.

## Budgets (MASTER_PLAN, PC gate 13) and measurements

**How it is measured.** `tests/editor-performance.test.mjs` runs headless Chromium against a real studio host, on a project of 10,000 layers: one page holding 9,999 absolutely positioned cards. The editor records standard User Timing measures, which the test reads through `performance.getEntriesByName`.

| Budget | Measure | Limit | Measured in this container (3 runs) |
|---|---|---|---|
| First render of a 10,000-node document | `lilac:render-project`: from requesting the project to the drawn canvas, including fetch and parse | 2 s | 526, 552 and 558 ms |
| Applying a single-node change | `lilac:apply-change`: from receipt of the change-stream event to the patched canvas and panels, p95 over about 40 changes | 100 ms | 20.5, 20.0 and 19.6 ms |
| End-to-end edit on 10,000 nodes | `lilac:edit`: from the request through the persisted commit and the patch, p95 over 30 edits | 750 ms | 622, 621 and 612 ms |

The test asserts each budget, prints the measurements on every run (`# PC8 gate 13: …`), and runs on CI.

## What had to change to meet them

The first measurement exceeded two of the three budgets. Applying a change took 527 ms at p95, and an edit about 900 ms.

**Editor: applying a change, 527 ms → 20 ms.**
- **Applying.** The editor's copy of the document followed each change with `applyTransaction`, which clones, re-validates and re-sorts the whole document: 128 ms at p50 on 10,000 nodes. The new `applyCommittedTransaction` in `@lilac/history` applies a transaction that the host has already validated and committed to the caller's own copy, in place. It uses the same operation code, without the clone and revalidation. If an operation does not apply, the editor fetches the document again, as before. A property test checks that it matches `applyTransaction` exactly.
- **The layers tree** was rebuilt on every change, and twice, because the canvas also reported the unchanged selection. A change to layer properties now only relabels the affected rows, and an unchanged selection redraws nothing. A change that adds, removes or moves layers still redraws the tree. That is measured as part of the first render and is not separately budgeted.

**Host: an edit, 573 ms → 393 ms (p50, 10,000 nodes).**
- Each edit re-derived the history state from a clone of the store's document, which meant a full validation, about 180 ms. The session is the store's only writer, so it now keeps the document it last committed as the next edit's base. The store still validates and applies every transaction itself. The cached base is rebuilt whenever its revision does not match the store's.
- The remainder is collaboration's attributed apply (about 120 ms) and persistence's validated, durable commit (about 240 ms). This is consistent with the about 156 ms P06 G3 measured for the commit alone, plus #154's O(journal) cost.

## Tests

**`tests/editor-performance.test.mjs`:** the three budgets, as above.
1. The project is built in batches under the 1 MiB request limit, and opened in the editor; all 10,000 layers are drawn.
2. Forty single-node changes come from another client.
3. Thirty Shift+Arrow nudges are made in the editor.

There are no foreign requests and no page errors.

**`tests/history-committed.test.mjs`:** `applyCommittedTransaction` produces exactly the document and affected ids that `applyTransaction` does, over seeded random sequences of every operation type. It throws on an operation that does not apply.

**`tests/studio-web-serving.test.mjs`:** a request body over the limit is answered with 413 promptly. It guards a hang suspected during this work; the hang turned out to be in the test, not the host.
