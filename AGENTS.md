# Repository Agent Tooling

Existing project governance and canonical evidence remain authoritative.

<!-- graft:start -->
## Graft — repository context layer

Use Graft (https://github.com/trailhq/Graft, `@nanonets/graft`) as the preferred codebase context/navigation layer for coding agents when the CLI is already available locally.

Keep Graft local-first and zero-cost. Telemetry must remain disabled (`graft telemetry` should report `off`; if it is enabled, run `graft telemetry disable` before using Graft). Do not use `--deep`, a paid model/API, or model-backed enrichment unless separately authorized by project governance.

A missing or stale graph is a build concern, not an initialization concern. Run `graft build` to create or refresh the local graph, then `graft check`. Do not run `graft init` merely because `graft/` is absent or stale. `graft init` changes agent wiring/configuration and may write outside the repository; use it only for an intentional wiring change, inspect `graft init --dry-run --no-global` first, and preserve all existing repository instructions.

Before broad source exploration, prefer a fresh Graft graph and the bounded navigation commands that fit the task: `graft map`, `graft ask "<question>" --source`, `graft skeleton <file>`, `graft callers <symbol>`, `graft grep "<pattern>"`, and `graft blast`. After material code changes, refresh with `graft build` and verify with `graft check`.

Treat `graft/` as a local regenerable cache. It is ignored by Git and must never be committed as evidence. If Graft is unavailable, continue with normal repository tools rather than silently installing or wiring it.

Graft is context/navigation, not correctness or qualification evidence. Continue all repository-required tests, Jev review/qualification where applicable, Alibaba Open Code Review, CI, and security checks. Never fabricate Graft output, tool execution, CI, reviews, or evidence.
<!-- graft:end -->
