# P08-G7: cross-platform

Issue: #230 (P08 umbrella), founder section P08.7: Linux, macOS and Windows test evidence in CI; resolve the Windows test gap (#192); state each platform deviation.

**Status: the full suite runs on Windows with no failures. CI now runs it on Linux, Windows and macOS. Every test that cannot run on a platform skips and says why, and each case is listed below.**

## Before and after
- **Before:** the full suite failed 28 tests on Windows 11 (#192). CI ran it on Linux only.
- **After, locally on Windows 11 (Node 24):** 855 tests, 846 pass, 0 fail, 9 skipped. Five checks inside passing tests did not run; each says why in the test output.
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
  - **Fix:** it now uses `/dev/null`, which Git for Windows maps to its null device and which is the real path elsewhere (`packages/agent-supervisor/src/local.ts`).
- **An object store that is a file was reported as a missing object.**
  - **Cause:** reading through it gives ENOTDIR on POSIX but ENOENT on Windows, so Windows said `object … is missing` (corruption) where POSIX said the path is not a directory.
  - **Fix:** the store now checks itself and its fan-out folder are directories, on every platform (`packages/persistence/src/objects.ts`).
- **No way to stop web mode cleanly where Ctrl+C is not delivered as a signal.** Some Windows terminals, such as Git Bash's, end Node outright, and no program can send a signal to a child process on Windows.
  - **Fix:** `npm start` now also stops cleanly when `stop` is typed. The test helper uses it on Windows, and SIGTERM elsewhere.

**Tests that assumed POSIX, fixed:**
- **A module path built with `URL.pathname`**, which is `/C:/…` on Windows. It now uses `fileURLToPath` (`tests/sandbox-network.test.mjs`).
- **An expected hash taken from the `sha256sum` program.** Git for Windows' version marks a path with a backslash by prefixing the hash with one. The test now uses Node's own hash (`tests/sbom.test.mjs`).
- **A browser losing a killed Ninerr's connections.** Windows also reports `ERR_CONNECTION_RESET`, which is now accepted as a lost connection (`tests/app-crash-recovery.test.mjs`).
- **Links to directories.** `tests/support/links.mjs` creates them as junctions on Windows, which any account may create and which Node, like Ninerr, sees as links. Every test of directory links now runs on Windows.

## Platform deviations (each stated where the test runs)

| Deviation | Platforms | What the tests do |
|---|---|---|
| **No FIFOs.** Windows has no FIFOs; Git for Windows' `mkfifo` only emulates one. | Windows | 3 tests skip, and 1 check inside the Docling test does not run: "Windows has no FIFOs". |
| **Links to files need a right.** Creating a symbolic link to a file needs Developer Mode or administrator rights. | Windows, without that right (CI runners have it) | 2 tests skip, and 4 checks inside passing tests do not run. Each names the right. |
| **No POSIX permission bits.** Windows keeps only a read-only flag, so a writable file reads as `0o666`. Owner-only access comes from the folder's access control lists (the user's profile). | Windows | Checks of `0o600` and `0o664` check only that the file is writable (`tests/support/platform.mjs`). |
| **No signals to child processes.** A clean stop cannot be sent as SIGTERM. | Windows | Web mode is stopped with the typed `stop`. The SIGTERM path is tested on Linux and macOS. |
| **Policy-enforced browser scans are unsupported.** They are refused, fail-closed: the wrapper that forces the policy proxy is a POSIX shell script. | Windows | 3 browser-proxy tests skip. Filed as #266. |
| **The desktop app's runtime must be fetched.** | Any machine without `node scripts/fetch-electron.mjs` run | The desktop window test skips locally. CI fetches it. |

## Not covered here
- **The desktop application** on each platform (build, launch, windows, crash recovery): P08-G8. The Desktop package workflow already builds and smoke-tests it on all three platforms.
