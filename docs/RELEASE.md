# Release evidence

A Lilac release is a tagged commit together with a signed evidence bundle. This page describes how the bundle is produced, and how anyone can check it.

## What the bundle contains

`node scripts/release-bundle.mjs <empty dir> --source-commit <sha>` writes:

| Path | Contents |
| --- | --- |
| `sbom.cdx.json` | CycloneDX 1.5 SBOM generated from `package-lock.json` (P06 gate 9). It is produced only if the license policy check passes. |
| `licenses/<sha256>.txt` | Every license text that the dependencies ship, deduplicated by content. |
| `licenses/index.json` | For each dependency: its purl, its license, and which license texts belong to it. A package covered by a policy override, such as a platform binary, is recorded through the override's license file and sha256. This keeps the index independent of the platform the bundle was built on. The bundle is refused unless every listed text is present. |
| `THIRD_PARTY_NOTICES.md`, `scripts/license-policy.json` | Notices and the license allowlist with its overrides. |
| `docs/DONORS.md`, `docs/provenance/*` | Donor and authorization provenance. |
| `SECURITY.md`, `docs/MCP.md`, `docs/MIGRATION.md`, `docs/RELEASE.md` | The release documents. |
| `smoke-report.json` | The offline smoke-test report for this commit (`npm run smoke`). |
| `MANIFEST.json` | The product, the source commit, the lockfile sha256, the project license, and the sha256 of every other file. |

**Determinism.** Two builds of the same commit and lockfile are byte-identical, which `tests/release-bundle.test.mjs` checks. Nothing in the bundle depends on host paths, time, or which platform binary npm installed.

**Project license.** No project license has been declared yet, so `MANIFEST.json` records `projectLicense: "NOASSERTION"` (see #139).

## How a release is signed

The `Release Evidence` workflow (`.github/workflows/release.yml`) runs when a `v*` tag is pushed, or when it is started manually. In order, it:
1. installs the dependencies with `npm ci --ignore-scripts` and runs the full `npm run check`;
2. builds the bundle for that commit and verifies it against its manifest;
3. signs every file with `actions/attest-build-provenance`.

The signatures are keyless Sigstore attestations issued through GitHub OIDC, so no signing key is stored anywhere. The bundle is uploaded as a workflow artifact.

The workflow never creates tags. Pushing a tag is the release decision.

## How to verify a release

1. Download the `lilac-release-evidence-<sha>` artifact from the workflow run for the tag.
2. Check the files against the manifest:

   ```sh
   node scripts/release-bundle.mjs --verify <bundle dir>
   ```
3. Check each file's signature and provenance with the GitHub CLI:

   ```sh
   gh attestation verify <bundle dir>/MANIFEST.json --repo TheHalfMoon/Lilac
   ```
4. Rebuild from the tagged commit and compare. The two bundles must be identical:

   ```sh
   git checkout <tag> && npm ci --ignore-scripts
   node scripts/release-bundle.mjs /tmp/rebuilt --source-commit "$(git rev-parse HEAD)"
   diff -r /tmp/rebuilt <bundle dir>
   ```
