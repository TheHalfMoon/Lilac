# P08-G2a: the session as a state machine

Issue: #230 (P08 umbrella), founder section P08.2 (property and state-machine testing).

## What runs
`tests/session-machine.test.mjs` drives one project through the studio host the way the editor and an MCP agent do, in a generated order. It runs on the real HTTP API, the real MCP endpoint and the real store.

- **Seeds:** each seed is its own subtest. `NINERR_MACHINE_RUNS` sets the number of seeds (default 4), and `NINERR_MACHINE_STEPS` the steps per seed (default 120). `NINERR_PROPERTY_SEED=<seed>` replays one.
- **Cleanup:** every host a seed starts is closed in that seed's `finally`, whatever failed.

The transitions:

| Transition | Who | Expected outcome |
|---|---|---|
| Edit (insert, rename, unname, retext, restyle, move, remove) | person | 200, or 400 when the model refuses it (a move into its own subtree, an index past the end) |
| Undo | person | 200 linked to the change it undoes. 409 `undo-conflict` when another actor's change made it inapplicable. 409 `nothing-to-undo` |
| Redo | person | 200 linked to the change it redoes. 409 `redo-conflict` or 409 `nothing-to-redo` |
| A tool: `create_frame`, `set_text`, `rename_layers`, `set_styles`, `move_layers`, `duplicate_layers` | agent (MCP) | The tool's change, or a tool error exactly when the model refuses the change |
| `delete_layers` | agent; the person approves or declines | Deleted, or "declined" with nothing changed |
| Revert the agent's latest change | person | 200 linked to it, or 409 `revert-conflict`. An earlier change of the agent's is 409 `not-revertible` |
| Edit on an earlier revision | person | 409 `stale-revision`, never rebased |
| Checkpoint | person | Nothing visible changes |
| Close, then reopen in a new host | — | The document and revision persist. Undo, redo and revert start empty (#231) |

## The model
The reference model is in `tests/support/reference-model.mjs`. It shares no code with `@ninerr/history` or the host, and its contents are:
- the document's tree and props;
- the revision;
- the person's undo and redo stacks and the agent's undo stack, 200 deep as in the host.

It computes its own inverse for every operation: insert ↔ remove, remove ↔ restore the subtree, set-props ↔ the previous values, move ↔ move back. It applies a transaction all or nothing. So it predicts both outcomes:
- that an undo, redo or revert succeeds, with the document it leaves;
- that one conflicts because another actor's later change made it inapplicable.

**After every step**, the host must agree with the model on four things:
- the document's tree and props;
- the revision;
- whether the person can undo and redo;
- that the document is valid.

The test also asserts that the default run reaches the transitions that matter: edits accepted and refused, undo, redo, the agent's frames and deletions, a declined deletion, revert, checkpoint and reopen.

The journeys of P08-G1 use the same model and generator; they were moved to `tests/support`, together with the API clients (`tests/support/host-api.mjs`).

## Results
**Locally (Windows 11, Node 24):**
- The default 4 seeds × 120 steps pass in 27 s.
- 12 seeds × 120 steps pass in 75 s, with these transitions:
  - 283 edits accepted and 71 refused;
  - 184 undos, 39 redos and 87 reverts;
  - 4 undo conflicts, 1 redo conflict and 3 revert conflicts;
  - 44 deletions and 11 declined;
  - 35 refused moves by the agent;
  - 67 stale edits refused;
  - 36 checkpoints and 38 reopens.

  Every outcome was the model's.

**Mutation checks** (each change made by hand, the test run, the code restored):
- **When an edit stops clearing the person's redo stack,** every seed fails at "what the person can undo and redo".
- **When a revert leaves the agent's change on the agent's stack,** 3 of 4 seeds fail. The 4th never reverts twice in a row.

**In CI:** the Foundation run at the PR's exact head gives the Linux result with the default seeds.

## Not covered here
- **Write-back and reconciliation as a state machine:** P08-G2b.
- **Hostile input:** P08-G3.
- **Concurrent requests:** the transitions here are sequential, as one editor and one agent issue them. Concurrency is P08-G6.
