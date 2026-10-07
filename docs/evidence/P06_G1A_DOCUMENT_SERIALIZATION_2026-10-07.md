# P06 G1a: canonical document serialization (#101)

Part of P06 gate 1 (deterministic document serialization, #100).

## Finding

`sortNodeRecord` in `@lilac/document-model` ordered node keys with `localeCompare`, so the in-memory key order of a document depended on the process locale. On the base `550baae`, the ids `a aa B z ä å` came out as `a å ä aa B z` under `en_US.UTF-8` and as `a aa B z å ä` under `sv_SE.UTF-8`. Persistence was not affected on disk, because it re-sorts keys by code unit in its own `canonicalJson`.

## Delivered

- `sortNodeRecord` uses code-unit order.
- `serializeDocument(document)` validates the document, then emits canonical JSON: code-unit key order at every depth, no whitespace, `-0` as `0`. It refuses `undefined`, non-finite numbers, sparse arrays, non-plain objects, functions, symbols, bigints and nesting deeper than 256, all with `DocumentInvariantError`.
- `parseDocument(text)` accepts only the exact canonical form, so a document has one byte representation, and returns a validated, normalized document.

## Evidence

`tests/document-serialization.test.mjs` (8 tests):
- Byte stability under seeded key permutations (40 seeds; replay one with `LILAC_PROPERTY_SEED`).
- Parse/serialize inverse.
- Identical bytes and key order under `LC_ALL` = `C`, `en_US.UTF-8`, `sv_SE.UTF-8` and `tr_TR.UTF-8`, in child processes.
- Persistence's stored document object equals `serializeDocument` byte for byte.
- A golden fixture `tests/fixtures/documents/golden-v1.json`, pinned by sha256.
- Refusal classes.
- Rejection of non-canonical text.

The seeded PRNG is `tests/support/prng.mjs` (mulberry32, no dependency).

Not covered here: locale-dependent ordering in other packages, which is G1b.
