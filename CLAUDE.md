# Claude Project Instructions

Ninerr repository governance and canonical evidence are authoritative. Read `AGENTS.md` and `docs/MASTER_PLAN.md` before changing product code. Do not restart completed phases or rewrite accepted architecture unless live evidence requires it.

## Cloud-ready project tooling

This repository vendors its Claude-facing tooling under `.claude/skills/`. Do not look for these tools only in a developer home directory, Windows path, npm, or PyPI.

Project-local skills:
- `.claude/skills/ps-start`
- `.claude/skills/ps-build`
- `.claude/skills/ps-review`
- `.claude/skills/ps-doctor`
- `.claude/skills/ps-close`
- `.claude/skills/ps-spec`
- `.claude/skills/ps-resume`
- `.claude/skills/ps-checkpoint`
- `.claude/skills/ps-init`
- `.claude/skills/ps-dormammu`
- `.claude/skills/jev`

The existing project is already planned and implemented through the current canonical frontier. Do not run `ps-start` or use `ps-init` to replace established project documents merely because pstack was added. Use the relevant review/build/doctor/resume skills against the existing plan.

## Capabilities

- repository context: Graft when already available, with the constraints in `AGENTS.md`; otherwise normal repository tools
- pstack review/build workflow: project-local `ps-*` skills in `.claude/skills/`
- Jev CLI: `python .claude/skills/jev/scripts/jev`
- Jev provider: TypeSafe when `TYPESAFE_API_KEY` is present
- cloud Jev qualification: `.github/workflows/jev-exact-head.yml`, using the repository Actions secret `TYPESAFE_API_KEY`
- Alibaba Open Code Review evidence: `.github/workflows/open-code-review-delegate.yml`
- mechanical gate: repository `npm run check` and required targeted tests
- product plan: `docs/MASTER_PLAN.md`

A cloud container is not expected to have the developer's Windows paths or local Jev config. That is not a blocker. If `TYPESAFE_API_KEY` is not available inside the interactive cloud container, do not ask the user to paste the key and do not waive Jev. Push the candidate branch and use the GitHub Actions `Jev Exact-Head Qualification` check, which receives the secret securely from repository Actions secrets.

When the key is available directly in the environment, Jev may also be run interactively:

    export PYTHONIOENCODING=utf-8
    python .claude/skills/jev/scripts/jev --version
    python .claude/skills/jev/scripts/jev auth status
    python .claude/skills/jev/scripts/jev provider list
    git diff --no-ext-diff --binary origin/main...HEAD > /tmp/jev-candidate.diff
    python .claude/skills/jev/scripts/jev run commit -s @/tmp/jev-candidate.diff --json

Never print, echo, commit, or request `TYPESAFE_API_KEY`.

## Change workflow

For each implementation grain:

1. Verify live GitHub state and current canonical `main`; do not trust stale SHAs.
2. Read the applicable acceptance criteria in `docs/MASTER_PLAN.md` and issue/PR evidence.
3. Keep the branch scoped and reviewable.
4. Run repository mechanical tests and targeted tests.
5. Use `ps-review` for the diff. A missing optional review provider must degrade visibly according to the skill rather than silently skipping a review bar.
6. Run Alibaba Open Code Review evidence.
7. Obtain genuine Jev evidence for the exact candidate head. In cloud sessions without the API secret, use the GitHub `Jev Exact-Head Qualification` workflow.
8. Repair findings and rerun affected qualification after any code-changing repair.
9. Merge only after required exact-head checks pass.
10. After merge, verify canonical `main` and post-merge CI before declaring the grain closed.

Use normal merge commits. Do not squash, rebase, force-push, or rewrite history. Never fabricate tests, review output, CI, tool execution, or release evidence.

## Current program direction

Continue from the live canonical frontier in `docs/CURRENT.md`. The current program is N0 (Ninerr independence and migration), then P08, P09, P10 and the founder release gate, as `docs/MASTER_PLAN.md` sets out. v1.0.0 is not authorized. Do not redo already closed work unless live evidence proves a regression.
