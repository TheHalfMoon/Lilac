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

`scripts/smoke-desktop.mjs` takes the archive and works as follows.
- **Setup.** It unpacks the archive into a temporary folder and runs the packaged app as a person does, with its own home and projects folder. The app runs behind a local proxy that records any connection off the computer.
- **Driving the app.** It drives the app over Chromium's remote-debugging protocol, because the fuses refuse Node's inspector. It also runs one launch with `ELECTRON_RUN_AS_NODE` set.

It records ten checks:
1. the fuses in the binary are Lilac's;
2. the editor runs isolated in the desktop app: no `process`, no `require`, and the desktop bridge is present;
3. an edit is committed: a project is created, a layer added and renamed;
4. the project is locked while it is open;
5. closing Lilac quits it with 0;
6. quitting releases the project: the lock and the discovery file are gone;
7. after a restart the change is there;
8. closing Lilac quits it with 0 again;
9. `ELECTRON_RUN_AS_NODE=1` with `-e` does not run as Node;
10. nothing left the computer, from any process, across all three launches.

## Evidence

All results are from CI on head `4631be4`. Each runner annotates its result as "Desktop package evidence".

| Target | Runner | Archive SHA-256 | App tree SHA-256 | Signature | Smoke |
|---|---|---|---|---|---|
| linux-x64 | ubuntu-latest | `60c9983dea28a1125c529a8139a017d9bf40306e7dfd831b59fc9524af40c0d4` | `a13bcd39…` | unsigned | 10/10 |
| darwin-arm64 | macos-latest | `e0028a8adf6a552db103bb1262d6393916f2f15c7aa7935fca0e4211e5777809` | `308318a0…` | ad-hoc | 10/10 |
| win32-x64 | windows-latest | `a13cde3519cc43ac12e08bfad5866d8c5578440e85ec138329e46993f0796cbc` | `8a5f612f…` | unsigned | 10/10 |

**Locally,** in this container, the Linux package was built and smoke-tested as an unprivileged user: 10/10.

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

**The rule.** Every component whose text names a non-permissive license (LGPL, GPL, MPL, EPL, CDDL, AGPL) must be on the reviewed list. If one is not, packaging fails, on every platform. The list records why each one is acceptable for a Lilac that redistributes the runtime unmodified:

- **Statically linked LGPL: WebKit-derived Blink.** Blink's LGPL-2.0+/LGPL-2.1+ files, from WebKit and KHTML, are linked into the binary.
  - Lilac redistributes Electron unmodified.
  - Its complete corresponding source is Electron v44.7.0 with Chromium at its pinned revision.
  - Lilac's own code is a separate program that the runtime loads, not code linked into it.
- **Separately linked LGPL: FFmpeg.** It is `libffmpeg`, which can be replaced, and its source is Chromium's `third_party/ffmpeg`.
- **MPL file-level copyleft, unmodified:**
  - NSS/NSPR, hunspell, Eigen, symphonia and axe-core;
  - tri-licensed Mozilla code, used under MPL.
- **System libraries, loaded dynamically and not shipped:** glibc, GTK, libsecret, libv4l, Speech Dispatcher, BRLTTY.
- **GPL text that is not in the binary:**
  - pkg-config's build macro, in ICU and Node.js;
  - JSZip, which is dual-licensed and used under MIT.
- **Notices for Android-only components** that are not in a desktop binary: Google Play services, Android NDK.

Packaging passed the review on all three runners, so the macOS and Windows notices bring no component that has not been reviewed.

**Obligations, all met by the package:**
- Electron's `LICENSE` and `LICENSES.chromium.html` ship unchanged.
- The packager refuses an Electron `LICENSE` that is not the reviewed text.
- The MIT text is also kept at `docs/provenance/ELECTRON_LICENSE.txt`. The release bundle's license index and SBOM include the runtime, with the SHA-256 of each pinned archive.

**What this review is not.** It is an engineering review of the notices Electron publishes, not legal advice. The founder's Apache-2.0 audit (PC-L) relies on it.

## Not done here

- **Publisher signatures.** Code signing (Windows Authenticode, Apple Developer ID) and notarization need the owner's certificates and are tracked on #139. Until then, the packages show the expected warnings, as `docs/DESKTOP.md` describes.
- **Version details.** The Windows executable's version resources still name Electron. Changing them needs a resource editor, which is not part of this assembly.
- **Linux sandbox.** On Ubuntu 24.04 and later, unprivileged user namespaces are restricted by AppArmor. The package does not install an AppArmor profile or a setuid helper. `docs/DESKTOP.md` gives both options, and CI lifts the restriction for its runner.
