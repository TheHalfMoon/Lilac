# Release evidence

A Lilac release is a tagged commit together with its signed release files: the desktop app for each supported platform, and an evidence bundle. This page describes how they are produced, and how anyone can check them.

## What a release contains

| File | What it is |
| --- | --- |
| `Ninerr-linux-x64.tar.gz`, `Ninerr-darwin-arm64.zip`, `Ninerr-win32-x64.zip` | The desktop app (`docs/DESKTOP.md` says how to install it). Each is packaged on its own platform's runner from the tagged commit, smoke-tested, and taken through the release-candidate journey before it is collected. |
| `Ninerr-<platform>.json` | Each archive's package manifest: its SHA-256, the Electron runtime and its pinned archive, its corresponding-source binding, the fuses, and whether it is publisher-signed (not yet, #139). |
| `ninerr-release-evidence-<sha>.tar.gz` | The evidence bundle below, as one archive. |
| `SHA256SUMS` | The SHA-256 of each file above. |

**Local web mode** is the tagged source itself. Run it with Node 22.18 or later, and no network beyond loopback once the dependencies are installed:

```sh
git clone --branch <tag> https://github.com/TheHalfMoon/Lilac.git && cd Lilac
npm ci --ignore-scripts
npm start
```

The evidence bundle's `MANIFEST.json` names that commit as `sourceCommit`, and its attestation ties it to the tag.

## What the bundle contains

`node scripts/release-bundle.mjs <empty dir> --source-commit <sha>` writes:

| Path | Contents |
| --- | --- |
| `sbom.cdx.json` | CycloneDX 1.5 SBOM generated from `package-lock.json` (P06 gate 9), plus the desktop app's Electron runtime, with the SHA-256 of each pinned release archive. It is produced only if the license policy check passes. |
| `licenses/<sha256>.txt` | Every license text that the dependencies ship, deduplicated by content. |
| `licenses/index.json` | For each dependency, and for the Electron runtime (its MIT text is kept at `docs/provenance/ELECTRON_LICENSE.txt`): its purl, its license, and which license texts belong to it. A package covered by a policy override, such as a platform binary, is recorded through the override's license file and sha256. This keeps the index independent of the platform the bundle was built on. The bundle is refused unless every listed text is present. |
| `THIRD_PARTY_NOTICES.md`, `scripts/license-policy.json` | Notices and the license allowlist with its overrides. |
| `docs/DONORS.md`, `docs/provenance/*` | Donor and authorization provenance (every tracked file under `docs/provenance`). |
| `SECURITY.md`, `docs/DESKTOP.md`, `docs/MCP.md`, `docs/MIGRATION.md`, `docs/RELEASE.md` | The release documents. |
| `smoke-report.json` | The offline smoke-test report for this commit (`npm run smoke`). |
| `MANIFEST.json` | The product, the source commit, the lockfile sha256, the project license, and the sha256 of every other file. |

**Determinism.** Two builds of the same commit and lockfile are byte-identical. Nothing in the bundle depends on host paths, time, or which platform binary npm installed. `tests/release-bundle.test.mjs` checks both, the second by building with another platform's binary in place. The bundled text files are checked out with LF line endings on every platform (`.gitattributes`), so a Windows checkout produces the same bytes.

**Project license.** Ninerr is licensed under Apache-2.0 (`LICENSE`), and `MANIFEST.json` records `projectLicense: "Apache-2.0"` from `package.json`. The bundle and the desktop app ship `LICENSE` with the third-party notices. The source-rights audit behind the declaration is in `docs/evidence/N0_G7A1_SOURCE_CATEGORIES_2026-10-09.md` and `docs/evidence/N0_G7A_LICENSE_2026-10-09.md`.

## The Electron runtime's corresponding source

The desktop app redistributes Electron's official release archive, changed only in its fuse bytes. Electron statically links LGPL components from Chromium (Blink, from WebKit) and ships the LGPL `libffmpeg`. `docs/provenance/ELECTRON_CORRESPONDING_SOURCE.json` binds the runtime to its exact source:
- each shipped archive's SHA-256, as the release publishes it;
- the Electron version, with its git commit and tree, which carries Electron's patches to Chromium;
- the Chromium version Electron pins, with Chromium's commit and tree;
- the ffmpeg revision Chromium pins;
- the licenses.

Git commit and tree ids are content addresses, so they identify the source exactly. Electron publishes no source archive, and no official Chromium source tarball exists for this Chromium release, so the record names repositories and commits.

`node scripts/desktop/corresponding-source.mjs --check` resolves every link live and compares it with the record. The release workflow runs it before it builds anything. Packaging refuses a record that does not match the pinned runtime, and each package manifest names the record's SHA-256 and the commits it binds. The record ships in the bundle with the other provenance records.

How a binary release offers this source to recipients is a release-gate decision. The choices are:
- mirroring the source with the release;
- a written offer in the project owner's name;
- relying on the public repositories at the recorded commits.

It is recorded in `docs/evidence/N0_G7B_ELECTRON_SOURCE_2026-10-09.md`.

## How a release is signed

The `Release Evidence` workflow (`.github/workflows/release.yml`) has five jobs.
- **`build`** runs on every trigger:
  1. installs the dependencies with `npm ci --ignore-scripts` and runs the full `npm run check`;
  2. builds the bundle for that commit and verifies it against its manifest;
  3. uploads it as the artifact `ninerr-release-evidence-<sha>`, kept for 90 days.

  This job cannot request an OIDC token.
- **`desktop`** is the Desktop workflow (`.github/workflows/desktop.yml`) itself, the same one every pull request runs. It packages each archive on its own platform's runner, smoke-tests it, and runs the release-candidate journey through it. It cannot request an OIDC token either.
- **`collect`** runs no repository or dependency code. It:
  1. downloads the bundle and the three archives with their manifests;
  2. checks each archive against the SHA-256 its manifest records;
  3. puts the bundle in one archive and writes `SHA256SUMS`;
  4. uploads the seven files as `ninerr-release-<sha>`, kept for 90 days.
- **`attest`** runs only for a pushed tag matching `v[0-9]*`. It downloads the bundle and the collected files and signs every file with `actions/attest-build-provenance`. These are keyless Sigstore attestations through GitHub OIDC, so no signing key is stored anywhere. It runs no repository or dependency code.
- **`publish`** runs only for a pushed tag, after `attest`. It puts the collected files in a **draft** GitHub Release for that tag. It runs only `gh`. It cannot create a tag, because the release must name an existing one, and it leaves the draft unpublished: publishing it is the owner's decision. Running `publish` again makes another draft, which the owner can delete.

A manual dispatch, or a pull request that changes the release path, runs `build`, `desktop` and `collect` but never signs; a manual dispatch never signs even when it is started on a tag. That shows the whole pipeline working on a pull request's exact head before any tag. Only a pushed `v[0-9]*` tag is ever attested. The workflow never creates tags; pushing one is the release decision.

The attestations are stored with the repository and outlive the artifact. After 90 days, the bundle can be rebuilt from the tag, as in step 4 below, and checked against them.

## How to verify a release

**A desktop archive** (or any other release file). Check that this repository's release workflow signed it, for that tag, then check it against `SHA256SUMS`:

```sh
gh attestation verify Ninerr-linux-x64.tar.gz --repo TheHalfMoon/Lilac \
  --source-ref refs/tags/<tag> \
  --signer-workflow TheHalfMoon/Lilac/.github/workflows/release.yml
sha256sum --check --ignore-missing SHA256SUMS
```

On macOS, `grep Ninerr-darwin-arm64.zip SHA256SUMS | shasum -a 256 --check` does the second step. On Windows, compare `(Get-FileHash Ninerr-win32-x64.zip).Hash` with the file's line in `SHA256SUMS` (it prints in capitals).

**The evidence bundle:**

The trust anchor is the attestation on `MANIFEST.json`. `--verify` only checks that the files match the manifest. Someone who edits a file can edit the manifest to match, so `--verify` on its own proves nothing about origin.

1. Download `ninerr-release-evidence-<sha>.tar.gz` from the release and unpack it, or download the `ninerr-release-evidence-<sha>` artifact from the workflow run for the tag.
2. Check that the manifest was signed by this repository's release workflow, for that tag:

   ```sh
   gh attestation verify <bundle dir>/MANIFEST.json --repo TheHalfMoon/Lilac \
     --source-ref refs/tags/<tag> \
     --signer-workflow TheHalfMoon/Lilac/.github/workflows/release.yml \
     --source-digest "$(git rev-list -n1 <tag>)"
   ```
3. Check that `sourceCommit` in `MANIFEST.json` is that same commit. Then check every file against the manifest:

   ```sh
   node scripts/release-bundle.mjs --verify <bundle dir>
   ```
4. Rebuild from the tagged commit with Node 22 into a directory that does not exist yet, and compare. The two must be identical:

   ```sh
   git checkout <tag> && npm ci --ignore-scripts
   node scripts/release-bundle.mjs /tmp/ninerr-rebuilt --source-commit "$(git rev-parse HEAD)"
   diff -r /tmp/ninerr-rebuilt <bundle dir>
   ```

The same attestation names every file in the bundle as a subject, so any single file can be checked the same way as in step 2.
