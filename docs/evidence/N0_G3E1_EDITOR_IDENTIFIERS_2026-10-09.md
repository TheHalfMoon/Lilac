# N0-G3e1: the editor, renderer and desktop identifiers carry the Ninerr name

Issue: #190 (N0 umbrella). This is the first half of N0-G3e. The whole change exceeded the exact-head reviewer's context, so it is split. The second half, N0-G3e2, renames the host's history tool identifiers, the transaction metadata key, the method and rule packs and the supervisor lock.

| Identifier | Before | Now | Data from before the rename |
|---|---|---|---|
| Renderer DOM attributes | `data-lilac-id`, `-root`, `-href`, `-type`, `-handle`, `-selection` | `data-ninerr-*`, including the canvas capture marker `data-ninerr-capture`; the matching `dataset.ninerr*` keys and the `__ninerrText` marker | Ephemeral, never stored. The renderer still refuses document attributes in either prefix, in any case, so an imported document cannot impersonate the renderer's own. The hostile-attributes test supplies both. |
| Desktop preload bridge | `window.lilacDesktop` | `window.ninerrDesktop` | Ephemeral. |
| Editor credential key (per tab) | `sessionStorage["lilac.token"]` | `sessionStorage["ninerr.token"]` | Per tab only. An open tab asks for a fresh link once. |
| Editor performance marks | `lilac:render-project`, `:edit`, `:apply-change` | `ninerr:*` | Ephemeral. |

**History view.** The view treats tools with either prefix, `ninerr:` or `lilac:`, as the editor's own. So it is ready for the host to write `ninerr:*` (N0-G3e2), and journals keep their `lilac:*` entries. Those older entries cannot reach the view yet: it lists only changes made since the project was opened. They get a test with #179, which shows a reopened project's history.

**Canvas.** The canvas sets its selection and resize-handle attributes through `dataset`, which produces the `data-*` attributes. Both the setters and the selectors use `ninerr`.
