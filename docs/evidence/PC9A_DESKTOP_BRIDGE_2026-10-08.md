# PC9a: the desktop bridge

PC9a closes PC gate 5: "Desktop bridge: a context-isolated shell with a minimal preload and denied navigation and permissions" (issue #174).

## What it is

`@lilac/desktop` (`packages/desktop`) is a thin Electron shell around the same studio host that local web mode runs. Nothing about the host is rebuilt.
- **The host.** It runs in Electron's main process, on 127.0.0.1, with the same projects folder as `npm start`. The projects-folder logic moved from `scripts/lilac.mjs` into `@lilac/studio-host` (`projectsFolder`, `prepareProjectsFolder`), so both entry points share it.
- **The window.** It loads the host's single-use launch link, exactly as a browser does. The editor then talks to the host over HTTP with its token. There is no IPC.
- **MCP.** The host writes its discovery file as usual, so the stdio relay finds a desktop Lilac too.

**The window's web preferences** (`packages/desktop/src/policy.mjs`):
- `contextIsolation`, and `sandbox`, with `app.enableSandbox()` for every renderer;
- no `nodeIntegration` in the page, in subframes or in workers;
- `webSecurity` on, insecure content off, `webviewTag` off, and no navigation by drag and drop.

**The preload** (`preload.cjs`) runs sandboxed and gives the page `window.lilacDesktop = { desktop: true, platform }`, frozen, and nothing else.

**What is denied** (`main.mjs`):
- **Navigation and redirects** outside the host's origin.
- **Windows and webviews:** every `window.open` and every webview attachment.
- **Downloads:** every one.
- **Permissions:**
  - every permission request and check (`setPermissionRequestHandler`, `setPermissionCheckHandler`);
  - device permissions;
  - display capture.
- **Requests** to anything but the host's origin and local schemes (`data:`, `blob:`, `about:`, plus `devtools:` in an unpackaged run only), through `webRequest`. This sits on top of the editor page's own Content-Security-Policy, so it holds for any page.
- **Chromium's own requests.** Chromium's browser process fetches spell-check dictionaries from Google (`redirector.gvt1.com`), outside any page, so `webRequest` never sees the request and `spellcheck: false` does not stop it. Spell checking is turned off, and the dictionary source points at a loopback address that is never contacted.

**Lifecycle:**
- **One instance per user:** a second start focuses the first and exits.
- **Closing:** closing the window quits on every platform, and quitting closes the host first, which closes projects, releases their locks and removes the discovery file.
- **Developer tools** are allowed only when unpackaged: in the window (`devTools`), in the request filter, and in the menu.
- **Bounded quit.** A quit waits at most 10 s for the host to close, then exits with 1. A host that fails to close also exits with 1.
- **Signals.** `SIGINT` and `SIGTERM` quit as the menu does.
- **Renderer crash.** A crashed renderer is reloaded with a fresh link. Nothing is lost, because every change was committed by the host.

## The runtime

**Version.** Electron 44.7.0 (MIT), which bundles Node 24.21 with TypeScript type stripping. Its main process can therefore import the host's `.ts` sources as Node does.

**Pinning.** The runtime is pinned by version and by the SHA-256 of each official release archive (linux-x64, darwin-arm64, win32-x64) in `scripts/desktop/electron.mjs`. The digests were matched across two independent publications: the GitHub release's `SHASUMS256.txt` and the electron@44.7.0 npm package's `checksums.json`.

**Fetching.** `scripts/fetch-electron.mjs` downloads an archive, refuses one whose digest differs, and only then unpacks it into the git-ignored `.lilac-cache/`. Lilac does not depend on the `electron` npm package or its downloader and their dependencies.

**Licensing.** Electron is registered in `docs/provenance/LICENSE_REGISTER.json` (new kind `bundled-runtime`) and in `THIRD_PARTY_NOTICES.md`. Its `LICENSES.chromium.html` lists 779 bundled components, among them LGPL-2.1 FFmpeg as a separately linked library. A per-component review for each packaged platform is a PC9b item, required before any desktop package is released.

## Tests

**`tests/desktop-shell.test.mjs`** has two parts.
- **Unit tests of the policy:** origins, navigation, requests and web preferences.
- **The real shell,** run through playwright-core's Electron driver under a private Xvfb (`tests/support/desktop.mjs`). It checks, in order:
  1. **Isolation.** The window's effective web preferences, read in the main process: one window, `contextIsolation`, `sandbox`, no `nodeIntegration`, no webview tag. In the page there is no `require`, `process`, `module` or `Buffer`, and the bridge is exactly `["desktop", "platform"]`, frozen.
  2. **The editor works:** create a project, insert a box, rename it, all committed through the host.
  3. **No escape.** `window.open` returns null; a webview is inert. Navigation to a remote site, to another loopback port and to `file:` leaves the window on the editor.
  4. **Requests.** `fetch` and image loads to another local server and to the network are refused by the page's CSP. They are also refused by the shell itself: a hidden window that the main process points at the other server fails with `ERR_BLOCKED_BY_CLIENT`. The other server records no hit at all.
  5. **Permissions.** Notifications, camera, geolocation, clipboard reads and screen capture (`NotAllowedError`) are denied, and so are permission queries.
  6. **Downloads.** A download started from the main process is refused by the app's handler, which a listener registered after it observes, and nothing lands in the downloads folder.
  7. **One instance.** A second start exits with 0 and leaves one window.
  8. **Closing the window** quits Lilac with exit code 0, and the project's lock and the discovery file are gone. The console shows only the refused requests.
  9. **Relaunch.** The project reopens with its revision, layers and the renamed layer.
  10. **Egress.** The app runs with `--proxy-server` set to a local proxy that records every connection off this computer. The proxy records none, from any process of the app, over both launches.

**Mutation checks.** Each was run against the real shell, and each made the test fail:
- removing the request filter;
- removing the navigation guard;
- removing the permission handler;
- removing the window-open handler;
- disabling the single-instance lock. This one is now bounded at 15 s, so it fails rather than hangs;
- removing the spell-check settings: the proxy then records `CONNECT redirector.gvt1.com:443`;
- removing the download handler.

**One handler is a second layer that cannot be shown on its own.** The display-media handler is backed by the permission request handler, which denies screen capture too. Without the dedicated handler, screen capture is still denied, so no test can single it out.

**Running as an ordinary user.** Electron's OS sandbox cannot run as root, and the app never turns it off. The desktop tests therefore run as an ordinary user: locally they skip as root or without the runtime, and in CI (`CI=true`) they fail.
- **In this container,** they ran as an unprivileged user, together with the whole gate.
- **In CI,** the Foundation checks job fetches the pinned runtime (with the archive cached) and runs on the non-root runner. Ubuntu's AppArmor restriction on unprivileged user namespaces is lifted for the job, so Chromium's sandbox works and is not disabled.

## Not in this grain

These are PC9b, PC gate 15:
- packaging for Linux, macOS and Windows on their runners;
- the packaged-app smoke test;
- the per-platform review of Chromium's component licenses.

Signing and notarization stay a P07 prerequisite on #139.
