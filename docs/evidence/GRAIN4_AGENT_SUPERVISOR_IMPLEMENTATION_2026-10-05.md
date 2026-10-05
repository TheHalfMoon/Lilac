# Grain 4 Agent Supervisor implementation evidence ? 2026-10-05

## Scope

This record describes the Grain 4 implementation candidate for Issue #25. It does not claim canonical closure; exact-head review, GitHub CI, merge, and post-merge CI remain governance gates.

Target package: `packages/agent-supervisor`.

## Donor provenance

Primary donor:

- repository: `kunchenguid/firstmate`
- exact revision: `1f3e769616fdf9f31f85f4c3e6a9f71606634238`
- observed license: MIT
- copyright notice: `Copyright (c) 2026 Kun Chen`
- posture: bounded PORT + ADAPT

Studied donor surfaces frozen by Issue #25:

- `.pi/extensions/fm-branch-supervision.ts`
- `.pi/extensions/lib/fm-branch-dispatch.ts`
- `bin/fm-lease-lib.sh`
- `bin/fm-lease.sh`
- `bin/fm-session-lock-lib.sh`
- `bin/fm-spawn.sh`
- `bin/fm-control.sh`
- `bin/fm-supervision-host.sh`
- `bin/fm-wake-lib.sh`
- `bin/fm-teardown.sh`
- `docs/agent-control.md`
- `docs/pi-supervision-branch.md`
- `tests/fm-branch-supervision.test.sh`

The implementation is Lilac-owned TypeScript. It does not import Firstmate branding, nautical UX, its shell distribution, Relay/secondmate hierarchy, SSH topology, provider UX, or hosted dependencies. The package-level MIT notice is preserved in `packages/agent-supervisor/NOTICE.md`.

## Implemented boundaries

The candidate provides:

- deterministic, bounded, versioned durable worker records;
- immutable repository/branch/canonical-worktree identity validation;
- one-owner leases with positive stale-evidence reclamation;
- a process-bound global supervisor owner lock and per-task file locks;
- stable lock ordering for fresh spawn: supervisor owner -> task-set reservation -> task lock -> publication/side effects;
- same-ID and same-worktree spawn-race prevention;
- local process profiles with no raw shell-command authority in task records;
- typed inspect/interrupt/stop/relaunch/detach/retire lifecycle operations;
- journaled relaunch with re-proven mutation authority at side-effect/publication boundaries;
- restart reconciliation that refuses ambiguous endpoint identity;
- durable queue sequencing plus per-task wake cursor replay suppression;
- useful-progress checkpoints, declared waits, wedge detection, and bounded stale escalation;
- Grain 3 typed events for lifecycle, progress, wait, wedge, stale, recovery, and retirement outcomes.

## Safety properties

- `missing` is not `gone` and never licenses duplicate relaunch.
- A live PID seen after adapter restart is `unknown` unless this adapter instance launched and owns that process identity; this avoids guessing across PID reuse/restart.
- Worktree symlinks, non-root paths, repository identity mismatch, branch mismatch, and unreadable Git state fail closed.
- Runtime stop/relaunch preserves tracked edits, untracked bytes, HEAD, and dirty-state fingerprint.
- For locally owned processes, `stop` waits for child-process `close` after termination evidence, including the already-exited-before-stop case, before publishing a durable dead result; timeout remains fail-closed as `unknown`.
- Another live supervisor generation cannot mutate task state, leases, cursors, or endpoints.
- Runtime profiles launch with `shell: false`; environment is explicit rather than implicitly inherited.
- Ordinary stop/relaunch/retire never deletes the worktree.

## Graft structural review

Graft CLI `0.21.1` was run locally with no LLM/API key and an external temporary graph directory. The bounded graph covered `packages/agent-supervisor` and `packages/agent-events`:

- 16 files parsed;
- 267 graph nodes;
- 712 edges;
- 16 file cards.

The highest-ranked risk surfaces for the Grain 4 query were `assertMutationAuthority`, `settleDurableTaskWake`, `normalizeTaskRecord`, and `LocalProcessRuntimeAdapter`. Those surfaces received explicit regression coverage for authority loss, queue crash windows, malformed records, endpoint restart ambiguity, and worktree preservation.

## Local qualification before exact-head review

Focused Grain 4 suite:

- 67 tests passed;
- 0 failed;
- includes spawn races, stale lease reclamation, authority loss across awaits, queue cursor crash recovery, runtime restart ambiguity, dirty worktree preservation, typed lifecycle verbs, progress/wedge logic, and reconciliation.

Repository `npm run check`:

- 145 tests passed;
- 0 failed;
- Node test-file concurrency is fixed at 1 because concurrent repository test files independently launch Git/Impeccable/subprocess workloads and produced reproducible host resource contention while each failing test passed in isolation. No test was removed, skipped, or weakened.

## Remaining qualification gates

Before merge, still required on the exact candidate head:

- Jev qualification with zero blocking findings/tool errors;
- Alibaba Open Code Review where supported plus manual review of unsupported surfaces;
- exact-head GitHub CI;
- normal merge commit only;
- post-merge CI on canonical `main`;
- Issue #25 closeout only after post-merge evidence.

Cubic, CodeRabbit, Qodo, and similar generated reviewer outputs are not qualification evidence.
