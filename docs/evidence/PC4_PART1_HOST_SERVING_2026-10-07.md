# PC4 part 1: the host serves the editor

**Why the split.** PC4 (#157) is split into two PRs. Its full diff, about 112 KB, exceeds the Jev exact-head qualification's input limit: the model context is about 32K tokens, and two runs of "Jev Exact-Head Qualification" on PR #158 failed without a judgment. Part 1 lands the studio host's editor-serving work and the editor package's static shell and client. PR #158 keeps the application (`app.mjs`) and its browser tests.

**The code** is taken unchanged from the PC4 head `53bde07`, which went through PC4's ps-review: a security and correctness judge, an initial review plus two delta cycles, approved with no must-fix. The changes are listed in `docs/evidence/PC4_EDITOR_2026-10-07.md`, under "Host changes" and review deltas 1 and 2.

**Host (`packages/studio-host`):**
- **Static serving.** It serves the editor's browser packages only (`studio-web`, `document-model`, `history`, `renderer`, `canvas`), confined by `realpath`. The page gets a strict CSP.
- **Launch.** `launchUrl()` issues a single-use launch ticket, which `POST /api/launch` redeems for the token, with this host's Origin required.
- **New routes for the editor:**
  - `GET /api/history`, the session's change log;
  - `GET /api/session` names the user;
  - change events and `GET /api/document` name their project.

**Editor package (`packages/studio-web`):**
- the shell page, `index.html`, which loads `app.mjs` (PC4);
- `styles.css`;
- `client.mjs`: the ticket exchange, the token in per-tab `sessionStorage`, Bearer calls, and the change stream;
- `index.mjs` and `provenance.mjs`.

**Tests, in `tests/studio-web-serving.test.mjs`:**
- **Serving.** Only the editor's files are served, with traversal refused. The ticket is single-use, works only with this host's Origin, and sets no cookie. The API still requires the token.
- **Routes.** The session's user, the history log (without operations), and project-named change events and documents.

**Catalog.** The `editor-shell` entry (`stub`, `@lilac/studio-web`) describes part 1, and PC4 completes it.
