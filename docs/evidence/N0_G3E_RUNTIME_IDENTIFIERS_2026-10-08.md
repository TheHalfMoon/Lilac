# N0-G3e2: the host's history identifiers, the method and rule packs and the supervisor lock carry the Ninerr name

Issue: #190 (N0 umbrella). This is the second half of N0-G3e. The first half is `N0_G3E1_EDITOR_IDENTIFIERS_2026-10-09.md` (#205): the renderer's DOM attributes, the preload bridge, the editor's credential key and its performance marks. The whole change exceeded the exact-head reviewer's context, so it is split.

| Identifier | Before | Now | Data from before the rename |
|---|---|---|---|
| History tool identifiers | `lilac:import`, `:code`, `:codebase`, `:undo`, `:redo`, `:revert` | `ninerr:*` | Journals keep the old values. The history view (since N0-G3e1) treats both prefixes as the editor's own tools. |
| Transaction metadata key | `metadata.lilac` | `metadata.ninerr` | Journals keep `lilac`. Nothing reads it back for behaviour today. #179, which shows a reopened project's history, must read both. |
| Method pack and rules | `lilac-mobile-method/*`, `LILAC_MOBILE_METHOD_PACK`, `LILAC_CORE_RULE_PACK` (rule IDs `lilac/*`), `createLilacRulePack`, `LILAC_ARCHITECTURE_MAP` | `ninerr-mobile-method/*`, `NINERR_*` (rule IDs `ninerr/*`), `createRulePack` | Rule IDs appear in review results, which are not persisted. |
| Supervisor task-set lock | `__lilac_supervisor_task_set__` | `__ninerr_supervisor_task_set__` | It serializes worker creation inside one supervisor process and is not shared across releases. |

**Tool names shown in the history view.** The history view names a change's tool unless the tool is the editor's own. An import recorded before N0-G3b shows `@lilac/import-stack`; a later one shows `@ninerr/import-stack`. Both are true records. Journals are append-only, so earlier entries are never rewritten. (Noted by the N0-G3b review panel.)

**Census.** The `persisted-history-tools` rule matched the `lilac:` tool identifiers the host wrote. The host no longer writes them, so the rule is removed. (Raised by the N0-G3e review panel.)

**Test fixtures.** `tests/network-policy.test.mjs` used `LILAC_*` as example environment-variable names in provider credential references, and now uses `NINERR_*`. No product code reads either name.
