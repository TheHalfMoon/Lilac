# The Lilac desktop app

The desktop app is Lilac in its own window. It runs the same studio host as local web mode (`npm start`) and shows the same editor, with the same projects folder: "Ninerr Projects" in your home folder, or `NINERR_PROJECTS`. A setup from before the rename keeps working: `LILAC_PROJECTS` is read when `NINERR_PROJECTS` is not set, an existing "Lilac Projects" folder is used while there is no "Ninerr Projects", and a project from before the rename is copied into the Ninerr format the first time it is opened, with the original left unchanged. Projects are files on your computer, and Lilac needs no network.

## Running it from a checkout

```
npm ci --ignore-scripts
node scripts/fetch-electron.mjs
<runtime> packages/desktop
```

- **The runtime.** `scripts/fetch-electron.mjs` downloads the pinned Electron runtime (44.7.0) for this computer. It checks the archive against its pinned SHA-256 before unpacking it into `.ninerr-cache/`, and prints where the runtime is.
- **On Linux,** the runtime is `.ninerr-cache/electron/v44.7.0/linux-x64/electron`, and Chromium's sandbox needs unprivileged user namespaces (see below).

## Packages

`node scripts/package-desktop.mjs` packages the app for the computer it runs on: Linux x64, macOS arm64 or Windows x64. The result goes in `dist/desktop/`:
- **The archive:** `Ninerr-linux-x64.tar.gz`, `Ninerr-darwin-arm64.zip` or `Ninerr-win32-x64.zip`.
- **A manifest** (`Ninerr-<target>.json`), also included in the package as `ninerr-package.json`. It records:
  - the commit and the Electron version;
  - the fuses;
  - the license review of the runtime's notice;
  - the packaged workspace packages and dependencies;
  - the SHA-256 of the app and of the archive.

The `Desktop` workflow (`.github/workflows/desktop.yml`) builds each package on its own platform's GitHub-hosted runner and smoke-tests the packaged app (`scripts/smoke-desktop.mjs`).

**What a package holds:**
- The Electron runtime, renamed Lilac, with its `LICENSE` and `LICENSES.chromium.html` unchanged.
- The app as plain files in the runtime's `resources/app`:
  - the workspace packages it uses, as source;
  - its runtime dependencies, with their license texts;
  - `THIRD_PARTY_NOTICES.md` and `SECURITY.md`.

**The fuses.** These are switches compiled into the runtime, set when it is packaged. In a packaged Lilac:
- `ELECTRON_RUN_AS_NODE` has no effect;
- `NODE_OPTIONS` is ignored;
- `--inspect` is refused;
- `file:` pages get no extra privileges.

## Installing a package

A release's archives are in its GitHub Release, each with a Sigstore attestation from the release workflow and a line in `SHA256SUMS`; `docs/RELEASE.md` says how to check one before installing it. Packages are not yet signed by a publisher; signing needs the owner's certificates (#139). Until then:

- **macOS (Apple silicon).** Unzip it and move `Ninerr.app` to Applications. The app has an ad-hoc signature only and is not notarized, so macOS refuses to open a downloaded copy at first.
  - On macOS 15 and later, try to open it once, then choose Open Anyway in System Settings, Privacy & Security.
  - Or remove the download's quarantine flag yourself: `xattr -dr com.apple.quarantine /Applications/Ninerr.app`.
  - The menu bar shows Lilac, but Activity Monitor names the process Electron.
- **Windows (x64).** Unzip it and run `Ninerr.exe`. SmartScreen may warn about an unknown publisher; choose More info, then Run anyway. The file's version details still name Electron.
- **Linux (x64).** Unpack it with `tar -xzf Ninerr-linux-x64.tar.gz` and run `Ninerr-linux-x64/ninerr`.
  - Chromium's sandbox, which Lilac never turns off, needs unprivileged user namespaces.
  - Most distributions allow them. Ubuntu 24.04 and later restrict them through AppArmor. There, either give the app an AppArmor profile that allows `userns`, or make `chrome-sandbox` in the package owned by root and setuid (`sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`).

## How the window is protected

The window is isolated and sandboxed, with no Node, and its preload gives the page only the fact that it is the desktop app.
- **No escape:** it cannot navigate away from Lilac, open other windows or webviews, or download files.
- **No permissions:** it is granted none (camera, microphone, location, notifications, screen capture or clipboard reads).
- **No requests elsewhere:** it can reach nothing but Lilac's own host on 127.0.0.1.

Chromium's own background requests are turned off too. The tests run the app behind a proxy that records every connection the browser side (pages and Chromium itself) makes off the computer, and require that there are none. Lilac's host code, which runs in the app's main process, is the same as in local web mode, where a test (PC7) shows it makes no connection off the computer; the desktop smoke test does not watch the main process's own connections.

**What a local program can still do.** A program running as you can start Lilac with Chromium switches, such as `--remote-debugging-port`, and take control of the editor. No fuse covers these. That program could already act as you, so it is outside what Lilac defends against (see `SECURITY.md`).

**Lifecycle:**
- Closing the window quits Lilac. The host closes first, so every project is closed and its lock released.
- Lilac runs once per user: starting it again brings the open window forward.
- **MCP.** The stdio relay (`npm run mcp`) finds a desktop Lilac exactly as it finds `npm start`, because both write the same discovery file in the projects folder.
