# The Lilac desktop app

The desktop app is Lilac in its own window. It runs the same studio host as local web mode (`npm start`) and shows the same editor, with the same projects folder: "Lilac Projects" in your home folder, or `LILAC_PROJECTS`. Projects are files on your computer, and Lilac needs no network.

## Running it from a checkout

```
npm ci --ignore-scripts
node scripts/fetch-electron.mjs
<runtime> packages/desktop
```

- **The runtime.** `scripts/fetch-electron.mjs` downloads the pinned Electron runtime (44.7.0) for this computer. It checks the archive against its pinned SHA-256 before unpacking it into `.lilac-cache/`, and prints where the runtime is.
- **On Linux,** the runtime is `.lilac-cache/electron/v44.7.0/linux-x64/electron`, and Chromium's sandbox needs unprivileged user namespaces (see below).

## Packages

`node scripts/package-desktop.mjs` packages the app for the computer it runs on: Linux x64, macOS arm64 or Windows x64. The result goes in `dist/desktop/`:
- **The archive:** `Lilac-linux-x64.tar.gz`, `Lilac-darwin-arm64.zip` or `Lilac-win32-x64.zip`.
- **A manifest** (`Lilac-<target>.json`), also included in the package as `lilac-package.json`. It records:
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

Packages are not yet signed by a publisher; signing needs the owner's certificates (#139). Until then:

- **macOS (Apple silicon).** Unzip it and move `Lilac.app` to Applications. The app has an ad-hoc signature only, so the first time, open it with Control-click, then Open. The menu bar shows Lilac, but Activity Monitor names the process Electron.
- **Windows (x64).** Unzip it and run `Lilac.exe`. SmartScreen may warn about an unknown publisher; choose More info, then Run anyway. The file's version details still name Electron.
- **Linux (x64).** Unpack it with `tar -xzf Lilac-linux-x64.tar.gz` and run `Lilac-linux-x64/lilac`.
  - Chromium's sandbox, which Lilac never turns off, needs unprivileged user namespaces.
  - Most distributions allow them. Ubuntu 24.04 and later restrict them through AppArmor. There, either give the app an AppArmor profile that allows `userns`, or make `chrome-sandbox` in the package owned by root and setuid (`sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`).

## How the window is protected

The window is isolated and sandboxed, with no Node, and its preload gives the page only the fact that it is the desktop app.
- **No escape:** it cannot navigate away from Lilac, open other windows or webviews, or download files.
- **No permissions:** it is granted none (camera, microphone, location, notifications, screen capture or clipboard reads).
- **No requests elsewhere:** it can reach nothing but Lilac's own host on 127.0.0.1.

Chromium's own background requests are turned off too. The tests run the app behind a proxy that records any connection off the computer, and require that there are none.

**Lifecycle:**
- Closing the window quits Lilac. The host closes first, so every project is closed and its lock released.
- Lilac runs once per user: starting it again brings the open window forward.
- **MCP.** The stdio relay (`npm run mcp`) finds a desktop Lilac exactly as it finds `npm start`, because both write the same discovery file in the projects folder.
