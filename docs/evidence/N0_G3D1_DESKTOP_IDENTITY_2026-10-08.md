# N0-G3d1: the desktop app, packaging and CI carry the Ninerr name

Issue: #190 (N0 umbrella). This is the first half of N0-G3d, split so each half fits the exact-head reviewer's context.

## Renamed
- **Desktop app.**
  - Product name `Ninerr`, bundle identifier `io.github.thehalfmoon.ninerr`.
  - Executables `Ninerr.app`, `Ninerr.exe` and `ninerr`.
  - Archives `Ninerr-<target>.*`, with the manifest `ninerr-package.json`.
  - Window title and dialogs, and the log prefix `ninerr:`.
  - Electron fuse settings: `NINERR_FUSES`.
- **Electron runtime cache.** `.ninerr-cache/`, with the verification marker `.ninerr-verified`. CI's cache paths follow.
- **CI and release.** Artifact names `ninerr-desktop-*` and `ninerr-release-*`, and the draft release title.
- **SBOM.** Property names `ninerr:*`, and the tool name `ninerr-sbom`.
- **The desktop smoke and journey scripts and their tests** follow all of the above.

## Not renamed here
- **N0-G3d2:** the local web mode and MCP relay entry points (`scripts/lilac.mjs`, `scripts/lilac-mcp.mjs`), their environment variables, and the root package name.
- **Not until N0-G10:** the repository URL.

## Effect on existing installs
The desktop app's user-data directory follows the product name, so it is new. It holds no project data, which lives in the projects folder.

The single-instance lock lives in that directory too. A build from before the rename and a Ninerr build therefore do not exclude each other at launch. The per-project locks still keep both from writing the same project. No release was ever tagged, so only development machines can have both builds.

## Docs
`docs/DESKTOP.md` and `docs/RELEASE.md` now give the new file, cache and artifact names. Their prose and the repository URL follow in N0-G8 and N0-G10.
