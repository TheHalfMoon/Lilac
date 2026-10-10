# P08-G7: cross-platform

Issue: #230 (P08 umbrella), founder section P08.7: Linux, macOS and Windows test evidence in CI; resolve the Windows test gap (#192); state each platform deviation.

**Status: the full suite runs on Windows. Its one failure is a timing budget that it meets when run alone (below, #252). CI now runs the suite on Linux, Windows and macOS. Every test that cannot run on a platform skips and says why, and each case is listed below.**

## Before and after
- **Before:** the full suite failed 28 tests on Windows 11 (#192). CI ran it on Linux only.
- **After, locally on Windows 11 (Node 24):** 861 tests, 852 pass, 1 fail, 8 skipped. Five checks inside passing tests did not run; each says why in the test output.
  - **The failure** is gate 13's end-to-end edit budget for 10,000 nodes: p95 950 ms against 750 ms, late in the full run. Run alone, it passes on this branch (437 ms) and on main (415 ms), so this change does not move it. The margin is the cost #252 describes; the figures are recorded there.
- **CI:** `.github/workflows/ci.yml` gains `Foundation checks (windows-latest)` and `Foundation checks (macos-latest)`, beside the Linux job. Each job:
  - runs `npm run check`;
  - annotates its totals and failing tests;
  - keeps line endings as committed;
  - fetches the pinned Electron runtime.

  The figures from those jobs are in the PR's qualification record.

## What was wrong on Windows
**Defects in Ninerr, fixed:**
- **Git worktree inspection failed outright** (5 tests).
  - **Cause:** it ran Git with `GIT_CONFIG_GLOBAL` set to `os.devNull`, which is `\\.\nul` on Windows. Git for Windows refuses that path ("unable to access '\\.\nul': Invalid argument").
  - **Fix:** it now uses `/dev/null`, which Git for Windows maps to its null device and which is the real path elsewhere (`packages/agent-supervisor/src/local.ts`). `core.hooksPath` keeps the native null device: on Windows, hooks under `/dev/null` would resolve to a folder on the current drive that anyone may create.
- **An object store that is a file was reported as a missing object.**
  - **Cause:** reading through it gives ENOTDIR on POSIX but ENOENT on Windows, so Windows said `object … is missing` (corruption) where POSIX said the path is not a directory.
  - **Fix:** the store now checks itself and its fan-out folder are directories, on every platform (`packages/persistence/src/objects.ts`).
- **No way to stop web mode cleanly where Ctrl+C is not delivered as a signal.** Some Windows terminals, such as Git Bash's, end Node outright, and no program can send a signal to a child process on Windows.
  - **Fix:** `npm start` now also stops cleanly when `stop` is typed. The test helper uses it on Windows, and SIGTERM elsewhere.

**Found by the new CI jobs, on runners unlike this machine** (Windows with file-link rights, a checkout on another drive, macOS's linked temp folder):
- **A symbolic link in place of an import's file was followed on Windows (security).**
  - `readSingleLinkFile` (`packages/import-stack/src/filesystem.ts`) relied on `O_NOFOLLOW` to refuse a link when opening. Windows has no such flag, so a file link in place of Docling's output, for example, was read through.
  - Now, where the flag is missing, the path is checked first, and the file opened must be the one checked (same device and inode), so a swap in between is refused. The Docling test that showed this runs on the Windows runner, which may create file links.
- **An evidence folder that did not exist yet could be placed inside a disposable worktree (all platforms).**
  - To check a folder that does not exist yet, the delivery evidence store resolves it from the nearest folder that does (`packages/delivery-governance/src/evidence.ts`). When that folder was the filesystem root, the next name lost its first letter, so `D:\tmp\disposable-wt\sub` became `D:\mp\disposable-wt\sub`. The check that the evidence folder lies outside a disposable worktree then missed it, and the store was created at the wrong path.
  - On Linux `/tmp` always exists, so the walk never reached the root. On the Windows runner, the checkout's drive has no `\tmp`.
  - The name is now taken whole. A new test reaches the filesystem root on every platform; it fails without the fix.
- **The packaging check missed a file on another drive.** `scripts/package-desktop.mjs` fails packaging when the app would load a file from outside `packages/`, but on Windows `path.relative` across drives gives an absolute path, not one through `..`, which it then read as a package name. It now treats an absolute result as outside.
- **Scripts did not run as programs when started through a link (macOS).** Five scripts and three test helpers compared `process.argv[1]` with `import.meta.url`, which Node resolves through links. Through macOS's linked temp folder, `/var` → `/private/var`, a script never saw itself as the program; `sbom.mjs --check` then exited 0 on a violation. They now compare real paths.
- **Tests used temp folders that are not canonical paths:** `/var/…` on macOS, and Windows' 8.3 short names (`C:\Users\RUNNER~1\…`). Where Ninerr requires a canonical path, or compares with one, those tests now canonicalize their temp folders with `realpathSync.native`, the only form that expands short names.
- **A browser test raced the editor's selection sharing.** It switched projects while the editor's selection update, sent for the first project, was still in flight. The host then refused that update, as #260 requires, and the browser logged the refusal. The test now waits for the update to finish.

**Tests that assumed POSIX, fixed:**
- **A module path built with `URL.pathname`**, which is `/C:/…` on Windows. It now uses `fileURLToPath` (`tests/sandbox-network.test.mjs`).
- **An expected hash taken from the `sha256sum` program.** Git for Windows' version marks a path with a backslash by prefixing the hash with one. The test now uses Node's own hash (`tests/sbom.test.mjs`).
- **A browser losing a killed Ninerr's connections.** Windows also reports `ERR_CONNECTION_RESET`, which is now accepted as a lost connection (`tests/app-crash-recovery.test.mjs`).
- **Links to directories.** `tests/support/links.mjs` creates them as junctions on Windows, which any account may create and which Node, like Ninerr, sees as links. Every test of directory links now runs on Windows, including the legacy-migration test that used to skip without the right to create links.
- **The real-browser scan test** looked for Chrome only at Linux paths, so it skipped on macOS. It now also looks where macOS keeps Chrome.

## Platform deviations (each stated where the test runs)

| Deviation | Platforms | What the tests do |
|---|---|---|
| **No FIFOs.** Windows has no FIFOs; Git for Windows' `mkfifo` only emulates one. | Windows | 3 tests skip, and 1 check inside the Docling test does not run: "Windows has no FIFOs". |
| **Links to files need a right.** Creating a symbolic link to a file needs Developer Mode or administrator rights. | Windows, without that right (CI runners have it) | 1 test skips, and 4 checks inside passing tests do not run. Each names the right (`tests/support/links.mjs`). |
| **No POSIX permission bits.** Windows keeps only a read-only flag, so a writable file reads as `0o666`. Ninerr sets no access control lists, so owner-only access holds only where the projects folder's inherited lists give it, as in the user's profile, the default. | Windows | Checks of `0o600` and `0o664` check only that the file is writable (`tests/support/platform.mjs`). |
| **Trusted host files are not checked for owner or other writers.** Codebase links and the agent registry are trusted only if this user owns them and no one else can write them, but that check needs `process.getuid`, which Windows lacks. | Windows | Not fixed here: filed as #268. The checks in `tests/codebase.test.mjs` run only where the check does. |
| **No signals to child processes.** A clean stop cannot be sent as SIGTERM. | Windows | Web mode is stopped with the typed `stop`. The SIGTERM path is tested on Linux and macOS. |
| **Policy-enforced browser scans are unsupported.** They are refused, fail-closed: the wrapper that forces the policy proxy is a POSIX shell script. | Windows | 3 browser-proxy tests skip, each citing #266. |
| **The desktop app's runtime must be fetched.** | Any machine without `node scripts/fetch-electron.mjs` run | The desktop window test skips locally. CI fetches it. |

## Not covered here
- **The desktop application** on each platform (build, launch, windows, crash recovery): P08-G8. The Desktop package workflow already builds and smoke-tests it on all three platforms.
