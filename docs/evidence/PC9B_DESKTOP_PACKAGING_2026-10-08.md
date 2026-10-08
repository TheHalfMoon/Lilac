# PC9b: desktop packaging

PC9b closes PC gate 15: "Supported desktop packaging (Windows, macOS and Linux where supported) with a smoke test of the packaged app". In the plan, "supported" means Linux x64, macOS arm64 and Windows x64, each built on its GitHub-hosted runner (issue #174). Code signing and notarization need owner-provided certificates and stay a P07 prerequisite on #139.

## The packages

`scripts/package-desktop.mjs` is a Lilac-owned assembly that uses no packaging tool. It runs on each platform's own runner (`.github/workflows/desktop.yml`).

1. **The runtime.** It takes the pinned Electron 44.7.0 runtime for that platform, verified against its pinned SHA-256 before it was unpacked (PC9a), and renames it Lilac:
   - **Linux:** `lilac`.
   - **Windows:** `Lilac.exe`.
   - **macOS:** `Lilac.app`, with the bundle name and identifier set (`io.github.thehalfmoon.lilac`). The executable and its helpers keep Electron's names, which the runtime looks its helpers up by.
2. **Fuses.** It sets the runtime's fuses, which are compiled into the binary (`scripts/desktop/fuses.mjs`, read back from the binary in the smoke test):
   - **Off:** RunAsNode, NODE_OPTIONS, the Node inspector flags, extra `file:` privileges, and the defaults that were already off.
   - **On:** WebAssembly trap handlers.
3. **The app**, as plain files in `resources/app`:
   - the 16 workspace packages that the shell and the editor reach, found by following their imports, as source;
   - the installed runtime dependencies (parse5, entities, impeccable and that platform's Impeccable binary), with their license texts;
   - `THIRD_PARTY_NOTICES.md` and `SECURITY.md`.

   `packages/desktop/src/bootstrap.mjs` resolves `@lilac/<name>` to `packages/<name>`. A packaged app has no workspace links, archives for Windows cannot hold them, and Node does not strip types under `node_modules`.
4. **The license review.** It classifies the runtime's own `LICENSES.chromium.html` (see below), and stops if a component there has not been reviewed.
5. **Signing.** macOS gets an ad-hoc signature, because patching the fuses invalidates Electron's. Linux and Windows stay unsigned.
6. **The archive and its manifest.** It writes the archive: tar.gz on Linux, zip on macOS and Windows. The manifest records:
   - the commit and the Electron version;
   - the fuses;
   - the license review's digest and families;
   - the packages and dependencies;
   - the SHA-256 of the app tree and of the archive.

## The smoke test

`scripts/smoke-desktop.mjs` takes the archive and works as follows. Every launch runs behind the proxy.
- **Setup.** It unpacks the archive into a temporary folder and runs the packaged app as a person does, with its own home and projects folder. The app runs behind a local proxy that records every connection the browser side makes off the computer: the pages and Chromium itself.
- **Driving the app.** It drives the app over Chromium's remote-debugging protocol, because the fuses refuse Node's inspector. It also runs one launch with `ELECTRON_RUN_AS_NODE` set.

It records eleven checks:
1. the fuses in the binary are Lilac's;
2. the editor runs isolated in the desktop app: no `process`, no `require`, and the desktop bridge is present;
3. it runs as a packaged app, so there are no developer tools in the window, its requests or its menu. The app reports which kind of run it is, because Electron's `app.isPackaged` goes by the executable's name, which a packaged macOS Lilac keeps as Electron's. The shell decides by `process.defaultApp` instead;
4. an edit is committed: a project is created, a layer added and renamed;
5. the project is locked while it is open;
6. closing the window (its page target, as a person closes it) quits Lilac with 0;
7. quitting releases the project: the lock and the discovery file are gone;
8. after a restart the change is there;
9. closing the window quits it with 0 again;
10. with `ELECTRON_RUN_AS_NODE=1` and `-e`, the binary does not run the script; it starts Lilac, which says so, and is stopped;
11. the browser side sent nothing off the computer, across all three launches.

**What check 11 does not cover.** The proxy covers Chromium's network stack only. The host's own Node code in the main process is not behind it. That code is the same as local web mode's, where PC7's preload trap shows no connection leaves the computer.

## Evidence

All results are from CI on head `cdaa854`. Each runner annotates its result as "Desktop package evidence". The app tree's SHA-256 depends only on what ships in the app, so a later commit that changes only this record keeps the same app digests.

| Target | Runner | Archive SHA-256 | App tree SHA-256 | Signature | Smoke |
|---|---|---|---|---|---|
| linux-x64 | ubuntu-latest | `0c0795af2bae495906f3b8f4f45600205bc376527620ffd90919fd4b733cd7f8` | `2ee9c7e5…` | unsigned | 11/11 |
| darwin-arm64 | macos-latest | `2bc0a7f6bcdb29fce7b555811d2ac43f08e8e95ea1a2ca8c9ecf7451af1b68be` | `e8746d73…` | ad-hoc | 11/11 |
| win32-x64 | windows-latest | `4338df91e4295b5edac09f85442c7b11a98cecce7743c2dcd372d99ffd5e530c` | `d555e299…` | unsigned | 11/11 |

The archives differ between builds of the same commit, because tar and zip record file times. The app tree's digest is reproducible: a local Linux build matched CI's.

**Locally,** in this container, the Linux package was built and smoke-tested as an unprivileged user: 11/11.

**One failure on Windows, now fixed.** The first Windows smoke run crashed the app at start (exit `0x80000003`). The smoke test had pointed `APPDATA` and `LOCALAPPDATA` at folders that did not exist. A person's account always has them, so the smoke test now creates them.

## The runtime's component licenses

Electron's `LICENSES.chromium.html` lists every component of the runtime. Electron 44.7.0 for linux-x64 lists 779, sha256 `3375e2a9…`. The file is a superset: it also covers Android-only components. `scripts/desktop/chromium-licenses.mjs` classifies each component by the license texts it carries.

**Linux x64 by license family.** A component can be counted in more than one family.

| Family | Components |
|---|---|
| Apache | 493 |
| MIT-style | 188 |
| BSD-style | 143 |
| LGPL | 42 |
| MPL | 33 |
| EPL | 22 |
| Other | 38 |

**GPL** is named in 60 components and **AGPL** in 4, mostly inside other licenses' texts.

**The rule.** Every component whose text names a non-permissive license (LGPL, GPL, MPL, EPL, CDDL, AGPL) must be on the reviewed list. If one is not, packaging fails, on every platform. The list records why each one is acceptable. Lilac changes the runtime only in Electron's documented fuse bytes, which are recorded in `lilac-package.json`. It also renames the executable, removes the default app and, on macOS, edits the bundle name and re-signs:

- **Statically linked LGPL: WebKit-derived Blink.** Blink's LGPL-2.0+/LGPL-2.1+ files, from WebKit and KHTML, are linked into the binary.
  - Lilac changes the binary only in Electron's fuse bytes.
  - Its corresponding source is Electron v44.7.0, with Chromium at its pinned revision, plus those fuse settings.
  - Lilac's own code is a separate program that the runtime loads, not code linked into it.
- **Separately linked LGPL: FFmpeg.** It is `libffmpeg`, which can be replaced, and its source is Chromium's `third_party/ffmpeg`.
- **MPL file-level copyleft, in files Lilac does not change:**
  - NSS/NSPR, hunspell, Eigen, symphonia and axe-core;
  - tri-licensed Mozilla code, used under MPL.
- **System libraries, loaded dynamically and not shipped:** glibc, GTK, libsecret, libv4l, Speech Dispatcher, BRLTTY.
- **GPL text that is not in the binary:**
  - pkg-config's build macro, in ICU and Node.js;
  - JSZip, which is dual-licensed and used under MIT.
- **Notices for Android-only components** that are not in a desktop binary: Google Play services, Android NDK.

Packaging passed the review on all three runners, so the macOS and Windows notices bring no component that has not been reviewed.

**Obligations the package meets:**
- Electron's `LICENSE` and `LICENSES.chromium.html` ship unchanged.
- The packager refuses an Electron `LICENSE` that is not the reviewed text.
- The MIT text is also kept at `docs/provenance/ELECTRON_LICENSE.txt`. The release bundle's license index and SBOM include the runtime, with the SHA-256 of each pinned archive.

**Obligations left to the release audit (PC-L, #139):**
- the written source offer that LGPL-2.1 asks of a binary release, for statically linked Blink and for FFmpeg;
- whether Lilac's own attribution bundle should ship inside the desktop package. The release evidence bundle (`docs/RELEASE.md`) is published beside each release. The package carries the notices that redistribution needs: Electron's two files, `THIRD_PARTY_NOTICES.md`, and each dependency's own license text.

**How the classifier matches.** It matches license names in full, SPDX-style ids (for example `LGPL-2.1`, `MPL-2.0`) and `GPLv2`-style names. The last of these brought in the LLVM runtime libraries (compiler-rt, libc++, libc++abi, libunwind, llvm-libc) and dragonbox. They are Apache-2.0 with the LLVM exception, which names GPLv2 only to permit combining with it, and they are reviewed as such.

**What this review is not.** It is an engineering review of the notices Electron publishes, not legal advice. The founder's Apache-2.0 audit (PC-L) relies on it.

## Not done here

- **Publisher signatures.** Code signing (Windows Authenticode, Apple Developer ID) and notarization need the owner's certificates and are tracked on #139. Until then, the packages show the expected warnings, as `docs/DESKTOP.md` describes.
- **Version details.** The Windows executable's version resources still name Electron. Changing them needs a resource editor, which is not part of this assembly.
- **Asar integrity.** The fuses for asar integrity (`EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`) stay off: the app ships as plain files. Anyone who can write the install folder can change the app. That is the next hardening step once a release signature exists (#139).
- **The macOS Impeccable binary.** The packaged macOS Impeccable binary keeps its own signature. The smoke test never runs it, so Gatekeeper's handling of it in a downloaded copy is not checked.
- **Linux sandbox.** On Ubuntu 24.04 and later, unprivileged user namespaces are restricted by AppArmor. The package does not install an AppArmor profile or a setuid helper. `docs/DESKTOP.md` gives both options, and CI lifts the restriction for its runner.
