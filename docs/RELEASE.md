# Release evidence

A Lilac release is a tagged commit together with a signed evidence bundle. This page describes how the bundle is produced, and how anyone can check it.

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

**Project license.** No project license has been declared yet, so `MANIFEST.json` records `projectLicense: "NOASSERTION"` (see #139).

## How a release is signed

The `Release Evidence` workflow (`.github/workflows/release.yml`) has two jobs.
- **`build`** runs on every trigger:
  1. installs the dependencies with `npm ci --ignore-scripts` and runs the full `npm run check`;
  2. builds the bundle for that commit and verifies it against its manifest;
  3. uploads it as the artifact `lilac-release-evidence-<sha>`, kept for 90 days.

  This job cannot request an OIDC token.
- **`attest`** runs only for a pushed tag matching `v[0-9]*`. It downloads the finished bundle and signs every file with `actions/attest-build-provenance`. These are keyless Sigstore attestations through GitHub OIDC, so no signing key is stored anywhere. It runs no repository or dependency code.

A manual dispatch builds the bundle but never signs it, even when it is started on a tag. Only a pushed `v[0-9]*` tag is ever attested. The workflow never creates tags; pushing one is the release decision.

The attestations are stored with the repository and outlive the artifact. After 90 days, the bundle can be rebuilt from the tag, as in step 4 below, and checked against them.

## How to verify a release

The trust anchor is the attestation on `MANIFEST.json`. `--verify` only checks that the files match the manifest. Someone who edits a file can edit the manifest to match, so `--verify` on its own proves nothing about origin.

1. Download the `lilac-release-evidence-<sha>` artifact from the workflow run for the tag.
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
   node scripts/release-bundle.mjs /tmp/lilac-rebuilt --source-commit "$(git rev-parse HEAD)"
   diff -r /tmp/lilac-rebuilt <bundle dir>
   ```

The same attestation names every file in the bundle as a subject, so any single file can be checked the same way as in step 2.
