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
| A tool: `create_frame`, `set_text`, `rename_layers`, `set_styles`, `move_layers`, `duplicate_layers` | agent (MCP) | The tool's change. A move the model refuses (into its own subtree, past the end) is a tool error that says why; any other refusal fails the test |
| `delete_layers` | agent; the person approves or declines | Deleted, or "declined" with nothing changed |
| Revert the agent's latest change | person | 200 linked to it, or 409 `revert-conflict`. An earlier change of the agent's, or one from before a reopen, is 409 `not-revertible` |
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

**How the actors' changes meet.** The changes have to meet, or conflicts would be rare:
- each actor's next change targets, half the time, a layer the other actor just changed (or undid, or redid);
- the agent's deletions are weighted up;
- with something to redo, the person redoes it a quarter of the time, after whatever the agent did meanwhile.

**Coverage gate.** A full run (at least 4 seeds of at least 120 steps; not a replayed seed) must reach every transition that matters:
- edits accepted and refused;
- undo, redo and revert, and a conflict of each;
- the agent's frames, deletions and refused moves, and a declined deletion;
- a revert of an earlier change and one from before a reopen, both refused;
- a stale edit refused;
- a checkpoint and a reopen.

The journeys of P08-G1 use the same model and generator; they were moved to `tests/support`, together with the API clients (`tests/support/host-api.mjs`).

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 120 steps pass in 22 s.** Every gated transition is reached:
  - 78 edits accepted and 16 refused;
  - 61 undos, 28 redos and 21 reverts;
  - 2 undo conflicts, 1 redo conflict and 1 revert conflict;
  - 12 deletions and 11 declined;
  - 5 refused moves;
  - 5 reverts of an earlier change and 4 from before a reopen, refused;
  - 23 stale edits refused;
  - 15 checkpoints and 15 reopens.
- **12 seeds × 120 steps pass in 70 s:**
  - 248 edits accepted and 45 refused;
  - 192 undos, 91 redos and 76 reverts;
  - 12 undo conflicts, 3 redo conflicts and 2 revert conflicts;
  - 68 deletions and 33 declined;
  - 27 refused moves;
  - 65 stale edits refused;
  - 39 checkpoints and 33 reopens.

  Every outcome was the model's.

**Mutation checks** (each change made by hand, the test run, the code restored):
- **When an edit stops clearing the person's redo stack,** every seed fails at "what the person can undo and redo".
- **When a revert leaves the agent's change on the agent's stack,** 3 of 4 seeds fail. The 4th never reverts twice in a row.

**In CI:** the Foundation run at the PR's exact head gives the Linux result with the default seeds.

**The undo depth limit** (200 per actor) is modelled, but a 120-step session never reaches it. Long sessions belong to the soak grain (P08-G5).

## Not covered here
- **Write-back and reconciliation as a state machine:** P08-G2b.
- **Hostile input:** P08-G3.
- **Concurrent requests:** the transitions here are sequential, as one editor and one agent issue them. Concurrency is P08-G6.
