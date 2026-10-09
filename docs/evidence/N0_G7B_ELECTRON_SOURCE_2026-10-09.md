# N0-G7b: the Electron runtime is bound to its exact corresponding source

Issue: #190 (N0 umbrella). The founder required that Ninerr "provide exact corresponding source required for the Electron build distributed by Ninerr", that the Electron version be verified live, and that binary, version, corresponding source, source hash, license and release evidence be bound, and the binding automated.

## Verified live on 2026-10-09
- **The release.** Electron `v44.7.0` is a published release (2026-10-07). Its `SHASUMS256.txt` gives the same SHA-256 for each archive Ninerr ships as `scripts/desktop/electron.mjs` pins:
  - `linux-x64`: `3ae7d5bd…`;
  - `darwin-arm64`: `e04e411b…`;
  - `win32-x64`: `eee30dc8…`.
- **Electron's source.** The tag resolves to commit `61f55c4ce540416b3e43f75f6c0f125d22e5e908`, tree `dbc6c90e0f23db09d7ce49d6bfd8d230a400a8e1`. Its `DEPS` pins Chromium `152.0.7977.130` and Node `v24.21.0`.
- **Chromium's source.** The `152.0.7977.130` tag resolves to commit `2c592105bbcd9490a9894df48d0fe59b2c512651`, tree `c91b573dac0b8675109dcedb2f84ce6e9019c9fb`. Its `DEPS` pins ffmpeg at `2b68d2babae73714846961fb0ee47e3b3d2e39a9`. Electron's `patches/config.json` at its commit applies `patches/chromium` to Chromium and patches to Chromium's third-party components, `patches/ffmpeg` among them.
- **No Chromium tarball.** No official Chromium source tarball exists for `152.0.7977.130`, although there are tarballs for neighbouring builds (`152.0.7977.129` and `152.0.7977.132`). The binding therefore names repositories and commits. Git ids are content addresses, so a commit identifies its source exactly.

## The binding
- **`docs/provenance/ELECTRON_CORRESPONDING_SOURCE.json`** records:
  - the archives and Electron's license digest;
  - the Electron, Chromium and ffmpeg sources;
  - the LGPL components with their linkage: Blink, statically linked; ffmpeg, the separately linked, replaceable `libffmpeg`;
  - Electron's patches. `patches/ffmpeg` changes ffmpeg's build file (the macOS install name of `libffmpeg`). LGPL-2.1 counts the scripts that control compilation and installation as part of the complete source, so the shipped library's corresponding source is Chromium's ffmpeg at the pinned revision plus that patch.

  It ships in the release bundle with the other provenance records.
- **`scripts/desktop/corresponding-source.mjs`** resolves the binding live:
  - `--write` writes the record;
  - `--check` resolves it again and fails on any difference, including a release digest that no longer matches the pin.
- **The release workflow** runs `--check` before it builds anything.
- **Packaging** refuses a record that does not match the pinned runtime. Each package manifest (`ninerr-package.json`) names the record, its SHA-256, the target's archive digest and the three commits.
- **`tests/corresponding-source.test.mjs`** holds the record to the pinned runtime without the network, and checks that mismatched records are refused.
- **References.** The license register's Electron entry and the reviewed-components note for WebKit in `scripts/desktop/chromium-licenses.mjs` now point to the record.

## For the founder's release gate
The binding says exactly which source corresponds to the binary. How a binary release offers that source to recipients is not an engineering decision. LGPL-2.1 section 6 permits these ways:
- **Accompany the binary with the source (6a), or offer equivalent access from the same place the binary is offered (6d).** That means mirroring the Electron, Chromium and ffmpeg source with Electron's patches for each release. Chromium's source is several gigabytes.
- **A written offer, valid for at least three years (6c),** to give the source to any recipient. It would be made in the project owner's name.

Pointing recipients at the public repositories at the recorded commits is not one of section 6's methods. An offer limited to ffmpeg would also leave Blink, which is statically linked LGPL code, uncovered. Either would be a risk only the owner can choose to accept.

One nuance remains for the owner. `libffmpeg` is a copy of an LGPL library itself. If it is distributed on its own, LGPL-2.1 section 4 governs it, and section 4 allows only the accompanying or same-place routes, with no written offer. A written offer rests on reading Electron and its `libffmpeg` as one combined work under section 6. That is the usual reading, but the accompanying or same-place route avoids depending on it. (Raised by the N0-G7b review.)

No release has been made, and `v1.0.0` is not authorized. The founder release gate decides this before any binary is distributed.
