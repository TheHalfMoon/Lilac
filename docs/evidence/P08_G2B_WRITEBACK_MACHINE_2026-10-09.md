# P08-G2b: source-linked editing as a state machine

Issue: #230 (P08 umbrella), founder section P08.2: source linking, write-back and reconciliation.

## What runs
`tests/writeback-machine.test.mjs` brings one component in from a file through the studio host's API, then drives it in a generated order. It uses the real API, the real planner and patcher, and the real file.

- **Seeds:** each seed is its own subtest. `NINERR_MACHINE_RUNS` sets the number of seeds (default 4), and `NINERR_MACHINE_STEPS` the steps per seed (default 80). `NINERR_PROPERTY_SEED=<seed>` replays one. A seed decides its whole run; two runs of the default seeds give identical transition counts.
- **Cleanup:** every host a seed starts is closed in that seed's `finally`.

The component has five source-linked fields:
- the section's `className` and `style`;
- the heading's text;
- the paragraph's `title` and text.

**The values:**
- they include `&`, `"` and non-ASCII text;
- two Ninerr-only texts, with `<` and `{`, can never be written as JSX text;
- the styles include two declarations, in either order. The component starts with one whose declarations are not in sorted order, so a write must keep the file's own order: the layer keeps its style keys sorted.

The transitions:

| Transition | What is checked |
|---|---|
| The person changes a field in Ninerr | — |
| Someone changes a field in the file | — |
| Preview, then write | The plan lists exactly the predicted changes, matched fields, conflicts and texts not written. There is a diff exactly when there are changes. Previewing writes nothing. Writing changes exactly the predicted fields, or answers 409 `nothing-to-write` when there is nothing to write or mark. |
| Preview, the file changes, write with the old plan | 409 `plan-changed`, and nothing written |
| Preview, a field changes in Ninerr, write with the old plan | 409 `plan-changed` exactly when what the plan would write, or the fields it would mark, changed. Otherwise it writes exactly what was previewed (or answers `nothing-to-write`). |
| Undo, redo | Ninerr's value goes back or forward. Write-back bookkeeping is never undone. |
| Close, then reopen in a new host | Bases persist |

## The model
For every field, the model keeps three values:
- the **base**, the value both sides last agreed on;
- **Ninerr's** value;
- the **file's** value.

It predicts each field of a preview:

| Ninerr's value | The file's value | Prediction |
|---|---|---|
| Unchanged from the base | Any | Nothing to do: a change made only in the file stays and is never undone |
| Changed | Equals Ninerr's | **Matched**: marked as matching, and the base moves (#234) |
| Changed | Changed differently | **Conflict**: never written |
| Changed, text with `{ } < >` | Unchanged | **Not written** |
| Changed | Unchanged | **Change**: written; the base and the file take Ninerr's value. A style is written in the file's own declaration order, with new declarations after |

**Styles** are compared by their declarations, so the same declarations in another order are equal. On a match, the base takes the file's own text.

After every step, three things must hold:
- each layer's value and base are the model's;
- nothing is left pending;
- the file is byte for byte the rendering of the model's file values, with `&` as `&amp;` and `"` as `&quot;` where a write produces them.

A full run (at least 4 seeds of at least 80 steps; not a replayed seed) must reach every outcome:
- a write, a mark as matching, and a write beside a conflict;
- a style written or matched, and one written in the file's own order;
- a refusal with only conflicts, and one with nothing to write;
- a preview with a text not written;
- both kinds of outdated plan, and a plan still current after a Ninerr edit;
- undo, redo and reopen.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 80 steps pass in 13 s, identically on two runs:**
  - 69 Ninerr edits and 61 file edits;
  - 26 writes, 3 marks as matching, and 17 writes beside a conflict;
  - 4 styles written or matched, one of them in the file's own order;
  - 35 refusals with only conflicts and 16 with nothing to write;
  - 45 previews with a text not written;
  - 21 plans outdated by the file and 7 by Ninerr, refused; 4 plans still current after a Ninerr edit;
  - 21 undos, 14 redos and 14 reopens.
- **12 seeds × 80 steps pass in 34 s:**
  - 77 writes and 14 marks as matching;
  - 14 styles written or matched, 4 in the file's own order;
  - 43 writes beside a conflict and 91 refusals with only conflicts;
  - 106 outdated plans refused, and 9 plans still current after a Ninerr edit;
  - 43 reopens.

  Every outcome was the model's, and the file was always byte for byte as predicted.

**Mutation checks** (each change made by hand to `packages/studio-host/src/codebase.ts`, the test run, the code restored):
Each of these mutations makes the default run fail:
- **Without #234's text matching** (no matched entry for a text both sides agree on): the host says there is nothing to write where the model marks the field as matching.
- **When a text changed on both sides is no longer a conflict:** it fails at "the changes".
- **When a style is written in the layer's order instead of the file's** (no `styleInSourceOrder`): it fails at "the base of style". No other test in the suite catches this one.

**In CI:** the Foundation run at the PR's exact head gives the Linux result.

## Not covered here
- **#185 failure injection:** a failed write, rename or confirm. Doing it over HTTP needs a failure hook the host does not have. `tests/writeback-failure.test.mjs` covers each step's failure with an injected store failure.
- **Structure changes:** layers moved, added or removed, and copies. Each is covered by `tests/codebase*.test.mjs`. The machine keeps the structure fixed so that every field stays writable.
- **The editor's view of a conflict:** it shows no values, #236.
