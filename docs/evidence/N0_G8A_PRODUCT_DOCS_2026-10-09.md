# N0-G8a: the product documentation speaks of Ninerr

Issue: #190 (N0 umbrella).

- **`README.md`** is rewritten.
  - It introduced Lilac as a product with Paper.design as its donor, in a "bootstrap" state with no product code. It now describes Ninerr as it is: the studio host, the editor, persistence, design and code, agents through MCP, and the desktop app.
  - It gives the commands to run Ninerr, verified against `package.json` and `scripts/ninerr.mjs`, and points to the documentation and the Apache-2.0 license.
  - There is no "based on" positioning.
- **`SECURITY.md`** names Ninerr. It also states that GitHub's private vulnerability reporting is enabled for the repository: `GET /repos/TheHalfMoon/Lilac/private-vulnerability-reporting` returned `enabled: true` on 2026-10-09.
- **`docs/DESKTOP.md`, `docs/ARCHITECTURE.md` and `CLAUDE.md`** name Ninerr, and `docs/RELEASE.md` describes a Ninerr release.
  - `docs/DESKTOP.md` keeps the quoted legacy folder name "Lilac Projects" and `LILAC_PROJECTS`, which the migration reads.
  - `docs/ARCHITECTURE.md` no longer refers to a Paper source intake. The intake never received source, and N0-G5 retired it.
- **Kept until N0-G10.** The repository URL in `docs/RELEASE.md` stays `TheHalfMoon/Lilac` until the repository is renamed.
- **Kept on purpose.** `docs/MIGRATION.md` names the legacy format.
- **`docs/DONORS.md`** names Ninerr, points to the A/B register and the founder's authorization, and says that Paper and the other named projects belong to their owners and are provenance only.
- **The Electron source evidence** (`N0_G7B_ELECTRON_SOURCE_2026-10-09.md`) adds the LGPL-2.1 section 4 nuance for `libffmpeg` that the N0-G7b review raised, for the founder's release gate.

The N0-G8a review corrected the README in these places:
- export is JSX only, over bounded JSX/TSX, CSS and Tailwind adapters;
- installing fetches dependencies;
- the studio host owns the codebase connection;
- the projects folder can be overridden.

`docs/ARCHITECTURE.md` also says again that its tree is not one for one with the packages.

The planning and status documents (`docs/PARITY_MATRIX.md`, `docs/MASTER_PLAN.md`, `docs/CURRENT.md`) follow in N0-G8b.
