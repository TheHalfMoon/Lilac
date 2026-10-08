# N0-G3d2: the local web mode and MCP entry points, environment and MCP name

Issue: #190 (N0 umbrella). The second half of N0-G3d; the desktop app, packaging and CI are N0-G3d1 (`N0_G3D1_DESKTOP_IDENTITY_2026-10-08.md`). The list below covers both halves.

## Renamed

- **Entry points.**
  - `scripts/lilac.mjs` is now `scripts/ninerr.mjs` (`npm start`), and `scripts/lilac-mcp.mjs` is now `scripts/ninerr-mcp.mjs` (`npm run mcp`).
  - The test helper module is `tests/support/ninerr-process.mjs`.
  - The root package is `ninerr`.
- **Environment.**
  - `NINERR_MCP_TOKEN`. MCP clients configured before the rename keep working: `LILAC_MCP_TOKEN` is read, with a note, when `NINERR_MCP_TOKEN` is not set. The legacy name lives in `packages/studio-host/src/legacy.ts`.
  - Test and tooling variables: `NINERR_TEST_BROWSER`, `NINERR_PROPERTY_SEED`, `NINERR_STDIN_LINKS` and `NINERR_TEST_SECRET`.
- **Desktop app.**
  - Product name `Ninerr`, bundle identifier `io.github.thehalfmoon.ninerr`.
  - Executables `Ninerr.app`, `Ninerr.exe` and `ninerr`.
  - Archives `Ninerr-<target>.*`, with the package manifest `ninerr-package.json`.
  - Window title and dialogs, and the log prefix `ninerr:`.
- **Build cache and CI.**
  - Electron cache `.ninerr-cache/`, with the verification marker `.ninerr-verified`.
  - CI artifact names `ninerr-desktop-*` and `ninerr-release-*`, and the draft release title.
- **SBOM.** Property names `ninerr:*`, and the tool name `ninerr-sbom`.
- **MCP.** The server identifies itself as `ninerr` (title `Ninerr`).

## Not renamed here

- **The repository URL** (`TheHalfMoon/Lilac`). It changes with the repository rename (N0-G10).
- **Renderer DOM attributes, history tool identifiers, the editor's session-storage key and the desktop preload bridge.** These are runtime identifiers shared between packages, and they move together in N0-G3e.
- **Prose names in code comments, test titles and editor text, elsewhere.** These are N0-G3f. The files this grain renames do get their own prose, test titles and test markers renamed:
  - the entry-point scripts and `scripts/smoke.mjs`;
  - the `web-mode` and `mcp-relay` test titles;
  - the `NINERR-NETWORK-ATTEMPT` marker;
  - the test origin `ninerr.test`.

  The editor text for the relay setup is renamed too. The editor's dialog titles and the browser wrapper's temporary-folder prefix are not, so their tests still expect the old text.
- **The Paper-derived MCP tool catalog.** That is N0-G4.

## Effect on existing installs

- **The desktop app's user-data directory.** It follows the product name, so it is new. It holds no project data, which lives in the projects folder.
- **MCP clients.** They need the new script path, `scripts/ninerr-mcp.mjs`. Their `LILAC_MCP_TOKEN` keeps working, with a note.

## Census
The `public-cli` rule matched the old entry points, which are gone, so it is removed.

## Verification
- Local (Windows, Edge): `mcp-relay`, `legacy-host`, `identity-census`, `smoke`, `web-mode`, `browser-proxy` and `renderer-browser`, recorded in the PR's qualification comment.
- The legacy token test checks that `NINERR_MCP_TOKEN` wins when both variables are set, and that the credential is never printed.
- Exact-head CI and review: the PR's qualification comment.
