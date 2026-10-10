# P06 G3: performance budgets and document limits (#107)

Part of P06 gate 3 (#100).

## Measurements

Measurements were taken on a 4-vCPU Intel Xeon at 2.1 GHz with Node 22.22. Each fixture is a set of pages of 100 frames, and each frame has 6 props. Times are single runs from the benchmark script; the budget test uses the best of several runs.

| Operation | 10k before | 10k after | 50k before | 50k after |
|---|---:|---:|---:|---:|
| `validateDocument` | 40 ms | 22 ms | 107 ms | 104 ms |
| `serializeDocument` | 107 ms | 80 ms | 313 ms | 305 ms |
| `parseDocument` | 239 ms | 159 ms | 796 ms | 920 ms |
| One-op `set-props` commit | 207 ms | 91 ms | 1,084 ms | 618 ms |
| undo | 147 ms | 78 ms | 1,056 ms | 645 ms |
| redo | 174 ms | 79 ms | 1,404 ms | 530 ms |
| Remove a 100-node subtree | 208 ms | 88 ms | 1,310 ms | 562 ms |
| Persisted `store.commit`, mean of 10 | 300 ms | 156 ms | 2,206 ms | 1,231 ms |
| Reopen and replay 10 entries | 1,548 ms | 944 ms | 11,381 ms | 6,752 ms |

"Before" is base `dc40e9c`. The 50k validate, serialize and parse rows did not change, so their differences are run-to-run noise; that includes the 50k parse after (920 ms) against before (796 ms).

## Hot-path fix

`applyTransaction` used to validate four times and clone twice: once on input, inside `cloneDocument`, inside `normalizeDocument`, and once at the end. It now:
1. validates the input once;
2. takes one private `structuredClone`;
3. orders nodes with the new `withSortedNodes`, a document-model helper that neither clones nor validates and is meant for documents the caller owns;
4. validates the result once.

The output is identical; the G1 and G2 suites, including the 300-seed undo/redo property test, pass unchanged.

## Limits

`DOCUMENT_LIMITS` is now exported:

| Limit | Value | Enforced in |
|---|---|---|
| `maxNodes` | 100,000 | `validateDocument` |
| `maxTreeDepth` | 1,024 | `validateDocument`, during the iterative walk |
| `maxDocumentBytes` | 64 MiB | `parseDocument`, before `JSON.parse`; the same as persistence `maxObjectBytes` |

Documents over a limit fail closed with `DocumentInvariantError`. The UTF-8 byte count does not rely on `Buffer`, so the model stays environment-neutral.

**Hardened in review delta 1:**
- `parseDocument` runs a linear bracket-nesting pre-scan, which ignores brackets inside strings and honours escapes. Text nested deeper than 257 levels is refused before `JSON.parse`. Canonical output never nests deeper: the document object is level 1, and values are capped at 256. Before this change, 60 MB of nested brackets kept `JSON.parse` busy for about 14.5 s before the depth check fired; that figure was measured by the security judge.
- `serializeDocument` refuses output over `maxDocumentBytes`, so an in-memory document cannot produce text that `parseDocument` and persistence would refuse.

## Budgets enforced

`tests/performance-budgets.test.mjs` takes the best of 3 runs (best of 2 for reopen).

**50k nodes:**

| Operation | Budget |
|---|---:|
| validate | 500 ms |
| serialize | 1,500 ms |
| parse | 3,000 ms |
| commit | 2,000 ms |
| undo | 2,000 ms |
| redo | 2,000 ms |

**10k nodes:**

| Operation | Budget |
|---|---:|
| Persisted commit | 1,500 ms |
| Reopen with replay | 3,000 ms |

**Deep trees:**

| Operation | Budget |
|---|---:|
| Validate a chain at the 1,024 depth limit | 200 ms |
| Validate a 64-level spine with 150 leaves per level | 300 ms |

**Scaling guard.** The 50k/10k time ratio must stay at or below 15 for validate, serialize and commit. Each time is the best of five samples of four calls in a row, with a 20 ms floor on a 10k sample so that a GC pause cannot trip it. Linear growth is about 5x; quadratic growth would be about 25x. Local ratios ranged from 5.3 to 7.6. The limit was 10, with single calls, best of 3, until #269: CI runs and full local runs crossed it on linear work (10.3x to 13.0x), and commit scales 7.6x to 9.0x. The reopen budget replays the 3 entries committed by the persisted-commit measurement.

The same file also tests the node limit, the byte limit, nesting refusal and the serialize cap. The byte-limit test also checks that the size check runs before parsing and that 2-, 3- and 4-byte text is measured in UTF-8 bytes.

## Dispositions

- **Renderer and canvas frame budgets:** no renderer exists. `renderer` and `canvas-viewport` are `planned` in `packages/architecture/src/catalog.ts`. The budget belongs to the renderer grain once it exists.
- **Sub-linear edits:** the remaining roughly 0.55 s per edit at 50k nodes needs structural sharing or incremental validation. That changes the contract that returned documents are independent deep copies, so it is tracked as a design decision in #108.
