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

## Review delta 1: validation reachable from untrusted text

`parseDocument` gives untrusted text a path into `validateDocument`. The security judge found four pre-existing problems that this makes reachable. All are fixed:
- Recursive traversal overflowed the stack on a 20,000-node parent chain. The walk is now iterative, and a 30,000-node chain passes.
- The per-child `children.filter` check was quadratic: one root with 40,000 children took about 20 s. It is now linear, through a referenced-child set.
- `document.nodes[id]` resolved inherited names, so `parentId: "toString"` threw a `TypeError` instead of `DocumentInvariantError`. Lookups are now own-key only.
- Error messages echoed ids of any length. Ids in messages are now cut to 80 characters, and the unreachable-node list stops after 10.

All four tests fail on the pre-delta validator.

In-memory key order is code-unit order except that JS always lists integer-like keys first. The canonical order is the one written by `serializeDocument`.

Deferred to later gates (#100): an input size cap on `parseDocument`, with document size and depth limits under gate 3, and rejection of unknown top-level and node keys under gate 11's schema work.

Not covered here: locale-dependent ordering in other packages, which is G1b.
