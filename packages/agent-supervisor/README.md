# @ninerr/agent-supervisor

`@ninerr/agent-supervisor` is the local worker and worktree supervision boundary. It preserves durable task and source identity across runtime loss while keeping runtime process identity replaceable.

## Identity boundaries

The supervisor keeps four identities separate:

1. `taskId`: durable worker/task identity.
2. `source`: repository identity, immutable branch, canonical worktree root, and creation HEAD.
3. `lease` / supervisor generation: the only generation allowed to mutate durable worker state.
4. `endpoint`: the current local runtime identity; it may be stopped, detached, or replaced without changing task/source identity.

A runtime exit never deletes a worktree. Worktree cleanup is outside this package.

## Lock ordering

Mutation ordering is intentionally broad-to-narrow:

1. global supervisor owner lock (`FileSupervisorLockAdapter`);
2. task-set reservation lock (`__ninerr_supervisor_task_set__`) when creating a fresh worker;
3. per-task mutation lock;
4. durable compare-and-swap publication and allowlisted runtime side effects.

Fresh spawn acquires the task-set reservation lock before the task lock. Ordinary single-task lifecycle operations acquire only the task lock. Code must never acquire a task lock and then reach backward for the task-set reservation lock.

The file-backed supervisor owner lock is process-bound. A second live supervisor generation is read-only. Stale lock reclamation requires positive local process-death evidence; malformed or ambiguous lock state fails closed.

## Durable task records

Task records are versioned, bounded, deterministic JSON. They contain the immutable source binding, checkpoint HEAD/dirty digest, runtime profile, endpoint identity, lease, last progress, declared wait, wake cursor, bounded stale state, and caller-supplied timestamps.

`FileTaskStore` uses hashed task filenames, rejects symlinks/non-regular metadata, verifies filename/task identity, and publishes updates through compare-and-swap under supervisor mutation guards.

## Runtime lifecycle

The typed lifecycle surface is:

- `startTask`: reserve and launch a fresh worker in an already-proven worktree;
- `inspectTask`: read-only task/worktree/runtime inspection;
- `interruptTask`: allowlisted runtime interrupt/cancel request;
- `stopTask`: stop runtime while preserving source/worktree state;
- `relaunchTask`: journaled replacement in the exact recorded worktree;
- `detachTask`: detach only after the endpoint is positively agent-free;
- `retireTask`: explicit durable retirement without worktree cleanup;
- `reconcileTask`: restart-safe reconciliation without speculative respawn.

`missing` and `unknown` are never treated as proof that a worker is gone.

## Local process backend

`LocalProcessRuntimeAdapter` launches only configured runtime profiles with `shell: false`; task records never contain executable shell authority. Environment variables are not inherited unless explicitly placed in the profile environment.

Endpoint metadata is durable. A live PID observed by a fresh adapter instance is classified `unknown` rather than assumed to be the same worker, preventing PID-reuse/restart guessing. Positive local death can be classified as stopped; ambiguous live identity abstains.

## Wake queue and progress

The durable wake queue has a single monotonically increasing acknowledgement cursor and rejects gaps. `settleDurableTaskWake` also publishes the accepted sequence to the task's `wakeCursor` before queue acknowledgement. If the process fails after task-cursor publication but before queue acknowledgement, replay skips the already-applied handler and only finishes the queue acknowledgement.

Useful progress is independent from process liveness. Source HEAD/dirty fingerprints, event sequence, active operations, declared waits, and injected time windows drive deterministic stale/wedge classification. Classification emits bounded `@ninerr/agent-events` events but does not trigger destructive action by itself.

## Provenance

Bounded supervision semantics are ported/adapted from `kunchenguid/firstmate@1f3e769616fdf9f31f85f4c3e6a9f71606634238` under its MIT license. See `NOTICE.md` and `docs/evidence/GRAIN4_AGENT_SUPERVISOR_IMPLEMENTATION_2026-10-05.md`.
