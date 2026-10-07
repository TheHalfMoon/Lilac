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

"Before" is base `dc40e9c`. The 50k validate, serialize and parse rows did not change, so their differences are run-to-run noise.

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

**Scaling guard.** The 50k/10k time ratio must stay at or below 10 for validate, serialize and commit. Linear growth is about 5x; quadratic growth would be about 25x.

The same file tests the node limit and the byte limit. The byte-limit test also checks that the size check runs before parsing and that multi-byte text is measured in UTF-8 bytes.

## Dispositions

- **Renderer and canvas frame budgets:** no renderer exists. `renderer` and `canvas-viewport` are `planned` in `packages/architecture/src/catalog.ts`. The budget belongs to the renderer grain once it exists.
- **Sub-linear edits:** the remaining roughly 0.55 s per edit at 50k nodes needs structural sharing or incremental validation. That changes the contract that returned documents are independent deep copies, so it is tracked as a design decision in #108.
