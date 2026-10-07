# P06 G2: undo/redo property tests (#105)

Part of P06 gate 2 (#100).

## Generator and invariants

`tests/history-properties.test.mjs` runs 300 seeds of 25 actions each through the shared mulberry32 PRNG in `tests/support/prng.mjs`. Set `LILAC_PROPERTY_SEED=<seed>` to replay one seed; failures name the seed and step.

Actions are commit, undo or redo. Commits use transactions of 1 to 3 operations drawn from:
- `insert-node`: random parents, index variants including out-of-range, and occasional reserved-looking ids;
- `remove-node`: subtrees;
- `move-node`: root and child moves, index variants, and invalid moves into the node's own subtree;
- `set-props`: own JSON keys including `__proto__`, `constructor` and `toString`, plus `unset` lists.

Every undo of a removal exercises `restore-subtree`.

Invariants checked:
- Every resulting state validates.
- A commit advances the revision by exactly 1 and clears redo.
- A rejected transaction leaves history deep-equal to before.
- Undo and redo restore the previous or undone content byte for byte. Content is `serializeDocument` with the revision excluded, because every apply advances it.
- Undo-all followed by redo-all restores the initial and final content.
- A single `set-props` stores each `set` key as an own property with its value and removes each `unset` key.

## Defects found and fixed

Both defects are red on base `e3074ac`.

1. **`set-props` dropped own `"__proto__"` keys.** `node.props[key] = value` with key `"__proto__"`, an ordinary own key in parsed JSON, changed the props object's prototype, and cloning then discarded the value without an error. The inverse `set` was built the same way. Both now define own data properties.
2. **Node records used inherited lookups.**
   - `createDocument`, `insert-node` and `restore-subtree` checked for an existing id with `record[id]`, so the node ids `__proto__`, `constructor` and `toString` were refused as "duplicate".
   - `parseDocument` does accept such a node. Removing it and then undoing failed with "Cannot restore existing node id".
   - Checks now use `Object.hasOwn`, and writes define own properties.

Each defect has a named regression test, alongside the property test.
