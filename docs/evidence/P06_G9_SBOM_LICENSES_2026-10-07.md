# P06 G9: SBOM, license allowlist and notices check (#130)

This is P06 gate 9 (#100). Its criterion: a deterministic script produces a CycloneDX SBOM from `package-lock.json`, with a license allowlist. CI fails on a disallowed or unknown license, or on a dependency missing from `THIRD_PARTY_NOTICES.md`.

## Changes

### `scripts/sbom.mjs`

`npm run sbom` writes the SBOM, and `node scripts/sbom.mjs --check` enforces the policy.

**SBOM.** The output is CycloneDX 1.5 JSON:
- Components are sorted by bom-ref. Each carries its purl, a SHA-512 taken from the lockfile `integrity`, its resolved SPDX license, its scope (`optional` for optional dependencies), the npm `os`/`cpu` constraints and its distribution URL.
- Workspace packages appear as first-party components, and the dependency graph comes from the lockfile.
- The output has no wall-clock timestamp. Its serial number is derived from the lockfile's sha256, which is also recorded as a property.

**Policy check (`--check`).** The run exits 1 and lists every problem:
- a license not on the allowlist;
- a license that is missing or not an SPDX id, with no override;
- an override that resolves to a disallowed license;
- an override whose declared license no longer matches the lockfile;
- an override whose license file is not installed, or whose sha256 does not match;
- an external package not named in `THIRD_PARTY_NOTICES.md`.

### `scripts/license-policy.json`

**Allowlist:** 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC and MIT.

**Overrides.** The five `@impeccable/cli-*@0.1.5` platform binaries declare `SEE LICENSE IN LICENSE`. Each override resolves them to Apache-2.0 and pins the license file's sha256 (`02bb8c3b…6d1812`). That file is byte-identical to the Apache License 2.0 text shipped in `impeccable@4.1.0`. The sha256 is verified wherever the package is installed; on linux-x64 CI that is `@impeccable/cli-linux-x64`.

### `THIRD_PARTY_NOTICES.md`

The notices now name the five platform binaries.

### Enforcement

CI is enforced through `tests/sbom.test.mjs`, which is part of `npm run check`. It runs `--check` against the repository's own lockfile, so any violation fails the gate. The spec's "`npm run check` runs `--check`" is met through the test, without editing the shared `check` script line.

## Inventory

| Package | License | Scope |
|---|---|---|
| `parse5@8.0.1` | MIT | required |
| `entities@8.0.0` | BSD-2-Clause | required |
| `impeccable@4.1.0` | Apache-2.0 | required |
| `@impeccable/cli-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,windows-x64}@0.1.5` | Apache-2.0, by override | optional, one per platform |

## Founder decision recorded, not made

Lilac declares no license for itself: there is no `license` field and no `LICENSE` file. The SBOM therefore records `lilac:license=NOASSERTION` as a property; CycloneDX license expressions must be SPDX, so it cannot be a license entry. Choosing the project license is a governance decision and a prerequisite for the P07 release.

## Tests

`tests/sbom.test.mjs` has 6 tests:

1. The repository's lockfile passes the policy, and `--check` exits 0.
2. The SBOM is byte-identical across runs, has no timestamp, and its components and graph do not depend on lockfile key order.
3. The SBOM has the CycloneDX 1.5 shape:
   - a v8-style UUID serial;
   - unique bom-refs, with every dependency edge resolving;
   - every external package present with the right purl, scope, SHA-512 and resolved SPDX license;
   - the `parse5 -> entities` edge;
   - Lilac's license unasserted.
4. Each violation in a synthetic lockfile is reported: GPL, UNLICENSED, missing, invalid SPDX, `SEE LICENSE` without an override, a stale override version, an override that resolves to GPL, and a missing notice.
5. An override is checked against an installed license file: a matching hash passes, while a wrong hash, a changed declaration and a missing file each fail.
6. `--check` exits 1, naming the problem, when run against a copy of the repository layout with a GPL dependency.
