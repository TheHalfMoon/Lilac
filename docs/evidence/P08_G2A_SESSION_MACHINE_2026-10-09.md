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

**How the actors' changes meet.** The changes have to meet, or conflicts would be rare. The scheduler steers toward where conflicts come from:
- each actor's next change targets, half the time, a layer the other actor just changed (or undid, or redid);
- the agent's deletions are weighted up; right after the person undoes, the agent often deletes a layer that undo changed;
- right after the agent changed what the person just changed, the person often redoes or undoes;
- now and then the person removes a layer the agent's latest change made or changed, and right after the person changed what the agent just changed, the person often reverts the agent's change;
- with something to redo, the person sometimes redoes it after whatever the agent did meanwhile.

**Deterministic.** A seed decides its whole run: the test picks layers in the model's order, not the host's, because the host sorts layers by id and the agent's ids are random. Two runs of the default seeds give identical transition counts.

**Coverage gate.** A full run (at least 4 seeds of at least 120 steps; not a replayed seed) must reach every transition that matters:
- edits accepted and refused, and an edit that clears the person's redo stack;
- undo, redo and revert, and a conflict of each;
- the agent's frames, deletions and refused moves, and a declined deletion;
- a revert of an earlier change and one from before a reopen, both refused;
- a stale edit refused;
- a checkpoint and a reopen.

The journeys of P08-G1 use the same model and generator; they were moved to `tests/support`, together with the API clients (`tests/support/host-api.mjs`).

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 120 steps pass in 22 s, identically on two runs.** Every gated transition is reached:
  - 47 edits accepted and 19 refused;
  - 47 undos, 24 redos and 32 reverts;
  - 13 undo conflicts, 8 redo conflicts and 6 revert conflicts;
  - 25 deletions and 11 declined;
  - 6 refused moves;
  - 9 reverts of an earlier change and 2 from before a reopen, refused;
  - 30 stale edits refused;
  - 18 checkpoints and 12 reopens.
- **12 seeds × 120 steps pass in 66 s:**
  - 144 edits accepted and 62 refused;
  - 165 undos, 82 redos and 95 reverts;
  - 45 undo conflicts, 26 redo conflicts and 10 revert conflicts;
  - 92 deletions and 42 declined;
  - 33 refused moves;
  - 81 stale edits refused;
  - 43 checkpoints and 29 reopens.

  Every outcome was the model's.

**Mutation checks** (each change made by hand, the test run, the code restored):
- **When an edit stops clearing the person's redo stack,** the default run fails (1 of 4 seeds, at "what the person can undo and redo").
- **When a revert leaves the agent's change on the agent's stack,** all 4 seeds fail.

**In CI:** the Foundation run at the PR's exact head gives the Linux result with the default seeds.

**The undo depth limit** (200 per actor) is modelled, but a 120-step session never reaches it. Long sessions belong to the soak grain (P08-G5).

## Not covered here
- **Write-back and reconciliation as a state machine:** P08-G2b.
- **Hostile input:** P08-G3.
- **Concurrent requests:** the transitions here are sequential, as one editor and one agent issue them. Concurrency is P08-G6.
