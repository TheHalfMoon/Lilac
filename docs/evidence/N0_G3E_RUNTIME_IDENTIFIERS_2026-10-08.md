# N0-G3e: runtime identifiers carry the Ninerr name

Issue: #190 (N0 umbrella). These are the identifiers shared between packages at run time. They move together, so every producer and consumer agrees.

| Identifier | Before | Now | Data from before the rename |
|---|---|---|---|
| Renderer DOM attributes | `data-lilac-id`, `-root`, `-href`, `-type`, `-handle`, `-selection` | `data-ninerr-*`; the matching `dataset.ninerr*` keys and the `__ninerrText` marker | Ephemeral, never stored. The renderer still refuses document attributes in either prefix, so an imported document cannot impersonate its own. |
| Desktop preload bridge | `window.lilacDesktop` | `window.ninerrDesktop` | Ephemeral. |
| Editor credential key (per tab) | `sessionStorage["lilac.token"]` | `sessionStorage["ninerr.token"]` | Per tab only. An open tab asks for a fresh link once. |
| History tool identifiers | `lilac:import`, `:code`, `:codebase`, `:undo`, `:redo`, `:revert` | `ninerr:*` | Journals keep the old values. The history view treats both prefixes as the editor's own tools. |
| Transaction metadata key | `metadata.lilac` | `metadata.ninerr` | Journals keep `lilac`. Nothing reads it back for behaviour today; #179 (showing a reopened project's history) must read both. |
| Editor performance marks | `lilac:render-project`, `:edit`, `:apply-change` | `ninerr:*` | Ephemeral. |
| Method pack and rules | `lilac-mobile-method/*`, `LILAC_MOBILE_METHOD_PACK`, `LILAC_CORE_RULE_PACK` (rule IDs `lilac/*`), `createLilacRulePack`, `LILAC_ARCHITECTURE_MAP` | `ninerr-mobile-method/*`, `NINERR_*` (rule IDs `ninerr/*`), `createRulePack` | Rule IDs appear in review results, which are not persisted. |
| Supervisor task-set lock | `__lilac_supervisor_task_set__` | `__ninerr_supervisor_task_set__` | It serializes worker creation inside one supervisor process and is not shared across releases. |

The first local run of this change failed the canvas and editor browser tests. The canvas set its selection and resize-handle attributes through `dataset.lilac*`, which produces `data-lilac-*`, while the selectors had moved to `data-ninerr-*`. Both sides now use `ninerr`, and those tests pass locally with Edge as the test browser.

**Tool names shown in the history view.** The history view names a change's tool unless it is the editor's own. An import recorded before N0-G3b shows `@lilac/import-stack`, and a later one shows `@ninerr/import-stack`. Both are true records. Journals are append-only, so earlier entries are never rewritten. (Noted by the N0-G3b review panel.)

**Tests for both prefixes.**
- The renderer's hostile-attributes test supplies `data-ninerr-*`, `data-lilac-*` and an upper-case `DATA-LILAC-HREF`, and checks that all of them are dropped.
- The history view's treatment of `lilac:*` tools cannot be reached yet: the view lists only changes made since the project was opened. It gets its test with #179, which shows a reopened project's history.

**Census.** The `persisted-history-tools` rule matched the `lilac:` tool identifiers the host wrote. It no longer writes them, so the rule is removed. (Raised by the N0-G3e review panel.)
