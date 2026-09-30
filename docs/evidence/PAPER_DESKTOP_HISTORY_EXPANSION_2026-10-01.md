# Paper Desktop Historical Recovery Expansion — 2026-10-01

## Scope

This record expands Lilac's metadata-only recovery census across publicly downloadable Paper Desktop releases. It uses only public/end-user-shipped artifacts and public release metadata. It does not use private-repository access, authentication bypass, credential extraction, unpublished endpoints, or server-side source access.

The Paper source authorization basis remains the project owner's explicit attestation. Because Lilac is public, this record intentionally commits **metadata, hashes, source paths, and architectural evidence only**. Raw proprietary Paper source recovered from shipped artifacts is not committed here.

## Reproducible recovery job

Lilac now contains a reusable metadata-only recovery pipeline:

- workflow: `.github/workflows/paper-public-history-census.yml`
- parser: `scripts/census-paper-asar.py`
- workflow head: `f7763bbbdfa1955e7f3fd3c28dcf63e0739e8134`
- workflow run: `36785630738`
- result: **SUCCESS**
- matrix jobs: **12/12 SUCCESS**

Each matrix job:

1. downloads a public Paper Desktop arm64 DMG from ToDesktop;
2. verifies the exact SHA-256 recorded by Homebrew Cask history;
3. extracts the distributed `app.asar`;
4. inventories first-party source paths and source-map metadata;
5. records source-content hashes when maps embed source;
6. uploads metadata-only JSON evidence;
7. never uploads recovered raw source content.

## Newly filled release gaps

The earlier corpus already covered representative releases. Homebrew Cask history provided exact build identifiers and checksums for the missing 0.5.x releases below.

| Version | Build ID | Official DMG SHA-256 | First-party source paths | Source maps | Maps with `sourcesContent` |
|---|---|---|---:|---:|---:|
| 0.5.1 | `260727g4bj55u42` | `911a4ac3105cd717bfb114a1f06bfecc554b72f76ba8ef55385d4038bb850f4b` | 50 | 1,458 | 395 |
| 0.5.2 | `2607302lnm29wpj` | `b66bce75039406312b487db5b317d06a882f8b3b05178714e77185efdd444d5d` | 53 | 1,457 | 396 |
| 0.5.3 | `260807bfjxxqmpq` | `1470b6ef9dda316cc642e53c25b90c4463aa3f413dad59f00f5c2c47f616fb19` | 55 | 1,455 | 394 |
| 0.5.4 | `2608142b19r2kkj` | `7e6cdca8ad526ea1646f3e9888cf69c0bff44f7e452ff8a73585786d60f745d5` | 56 | 1,451 | 390 |
| 0.5.5 | `2608248vduqftg0` | `e07476fbab53f431b437375e5768db22a388b0e092559d4d582779a73c7dabc5` | 62 | 1,453 | 392 |
| 0.5.6 | `2608278ikbsisiz` | `de9f80928c1340ddbe470e5637b7d26da425de1869ce0d721067df75748a1962` | 64 | 1,453 | 392 |
| 0.5.8 | `260910c6c61cnhq` | `0c91f02366c9dc77a669204bbfe6a52fed4727cfcf69a7f0fffb6437b6256d04` | 68 | 1,453 | 392 |
| 0.5.9 | `260912scb5jfzbk` | `d87988c92d12cac6b549900bd3725a3d8fff958635743c25eeaff81dc804b7fa` | 70 | 1,450 | 389 |
| 0.5.10 | `260915hvvfu9v5u` | `4ade89a5fff673c9d94cf5e508c65be26a6e1e0f4739b320592e956bece016a6` | 71 | 0 | 0 |
| 0.5.11 | `260918wsvtkwn81` | `03a027b2b1bc1df2e54f8db3d4cd5c1c404bf56994926113efe223e0b2a27079` | 71 | 0 | 0 |
| 0.5.12 | `260923mbui5shcl` | `01963c49efd6bf1b5e6f752edb77c5fc4fefc6fae37aa7be6518c58f9b75e4fd` | 79 | 0 | 0 |
| 0.5.13 | `260928cvv9p60wr` | `ae140abcfadad106691653b30bbb965aaab9a0104209a135ca23c5b431b12515` | 80 | 0 | 0 |

### Recovered ASAR hashes

| Version | `app.asar` SHA-256 |
|---|---|
| 0.5.1 | `b04aca1b1ef493b64a87d4cad13e0357337b80d627d3d924dbc3db425d6c0392` |
| 0.5.2 | `14878b48d4eb5c052ee7ac91e9dd47b233aa25306760356336300ba1976fbc20` |
| 0.5.3 | `79bee42d9a75465e600b392f33489cfb018634a9f7e6a0d00eb354f019c15d85` |
| 0.5.4 | `387c25b19e118d63932ee5c13e5a60ab05e6301689da0549147cd3ee0800f7da` |
| 0.5.5 | `6d650eb9d71ff1aacf21fb3b0ffce612ac41995d9687a30bfc002941aeaeda6a` |
| 0.5.6 | `aa670e8f79aa1ec4efe10329514df4210c6c323517e9f4772cf5967e00c0bb90` |
| 0.5.8 | `eab59a6f5fdb263aeb27c14de25b4a01de33675a8758fc7b2860b57a3c1d17bc` |
| 0.5.9 | `57b5dc25ce01a34852d31bb246ad5f94551fe01fe9e7c5b33824945bc59864f6` |
| 0.5.10 | `0e0ab7b5ba8e4f37da7d16bd8f81b82e147a137f112b61b01bdc280619f570d6` |
| 0.5.11 | `3e04f17dc57820787d5b1d27940b093a0d5f5521d455f65ca2e39f5f5825a013` |
| 0.5.12 | `05b680fea7efb6a3cf66c9dda3f1694f20faff1a3d63ccc16f2b9226de75b3d0` |
| 0.5.13 | `baf70ebbd6a280d4af92f1c10a9004cbc8e9d56eaf880aea343509b9a568f42c` |

## Full Desktop lineage now observed

The combined corpus spans 21 public/shipped Desktop builds:

`0.1.10`, `0.1.12`, `0.1.14`, `0.2.0`, `0.3.2`, `0.4.4`, `0.5.0`, and every observed release from `0.5.1` through `0.5.14` with `0.5.7` included from the earlier corpus.

First-party Desktop source counts across the lineage:

| Version | Source paths |
|---|---:|
| 0.1.10 | 20 |
| 0.1.12 | 23 |
| 0.1.14 | 27 |
| 0.2.0 | 29 |
| 0.3.2 | 29 |
| 0.4.4 | 30 |
| 0.5.0 | 45 |
| 0.5.1 | 50 |
| 0.5.2 | 53 |
| 0.5.3 | 55 |
| 0.5.4 | 56 |
| 0.5.5 | 62 |
| 0.5.6 | 64 |
| 0.5.7 | 69 |
| 0.5.8 | 68 |
| 0.5.9 | 70 |
| 0.5.10 | 71 |
| 0.5.11 | 71 |
| 0.5.12 | 79 |
| 0.5.13 | 80 |
| 0.5.14 | 84 |

Across the full observed lineage:

- **87 unique first-party Desktop source paths** are known.
- **46 source paths have at least two distinct content hashes** across releases.
- Filling the intermediate versions did not add new path names beyond the previously observed endpoint union, but it materially improves revision history and architecture evolution evidence.
- Source-map shipping ends at a precise observed boundary: **0.5.9 ships 1,450 maps; 0.5.10 ships none**.

## Source evolution evidence

The intermediate builds expose feature evolution that was invisible when only endpoint releases were compared. Examples include:

- `0.5.9 → 0.5.10`: `src/mcp/server.spec.ts` appears.
- `0.5.11 → 0.5.12`: Linux/Windows Claude resolver implementations and tests, detached-process support, child-process test support, and related MCP tests appear.
- `0.5.12 → 0.5.13`: macOS Claude resolver support appears.
- `0.5.13 → 0.5.14`: tab update availability and offline/waiting HTML templates appear.

Earlier 0.5.x releases also show development of environment/render health, MCP config/relay behavior, CLI installation, Claude extension installation, MCP body schemas, self-capture hold behavior, and harness configuration.

This evidence is useful for reconstructing subsystem boundaries and compatibility requirements without claiming access to Git history.

## Exact embedded internal-package source

Historical source maps with `sourcesContent` expose exact content from internal monorepo packages outside `@paper/desktop`. The expanded corpus verifies the following TypeScript source paths by package-relative path plus embedded-content hash:

### `assets`

- `assets/src/colors.ts`
- `assets/src/page-title.ts`

### `models`

- `models/src/api-address.ts`
- `models/src/auth/cosmetic-preauth-user-info-cookie.ts`
- `models/src/auth/session-cookie.ts`
- `models/src/file/export-meta-schema.ts`
- `models/src/file/parse-file-id.ts`
- `models/src/typebox-helpers.ts`

### `client-desktop-types`

- `client-desktop-types/src/desktop-tabs.ts`

### `cli`

- `cli/paths.ts`
- `cli/src/desktop/mcp-config.ts`
- `cli/src/desktop/mcp-stdio-relay.ts`
- `cli/src/lib/swallow-epipe-errors.ts`
- `cli/src/main.ts`
- `cli/src/mcp/mcp-config.ts`
- `cli/src/mcp/mcp-stdio-relay.ts`

The expanded evidence therefore raises the separately verified exact embedded internal-package source from **10 TypeScript files to 16 TypeScript files**, plus exact `cli/package.json` metadata/source-map content.

Some of these files have multiple distinct hashes across releases, giving real package-level revision history rather than a single snapshot.

## High-value unresolved internal targets

The current Desktop source references several internal package files that have not appeared with embedded source content in the recovered historical map corpus. Three explicit high-value targets remain unresolved:

- `assets/src/types.ts`
- `models/src/mcp/mcp-types.ts`
- `client-desktop-types/src/desktop-bridge.ts`

They produced **zero exact `sourcesContent` hits** in the recovered map-bearing builds through 0.5.9. Source maps stop being shipped beginning with 0.5.10, so later Desktop artifacts cannot fill these targets by the same mechanism.

Their interfaces can still be reconstructed from current Desktop imports, shipped JavaScript behavior, MCP contracts, public editor bundles, tests, and clean-room compatibility work, but they must not be labeled as exact original source until independently recovered.

## Recovery classification update

| Surface | State | Evidence |
|---|---|---|
| Current Desktop source | `RECOVERED_ORIGINAL_SHIPPED` | Exact TypeScript in distributed 0.5.14 packages |
| Desktop historical lineage | `RECOVERED_ORIGINAL_SHIPPED` | 21 observed builds; 87 paths; 46 with multiple content hashes |
| Historical Desktop source maps | `RECOVERED_ORIGINAL_SOURCEMAP` | Map-bearing builds through 0.5.9 with embedded `sourcesContent` |
| Verified internal package source | `RECOVERED_ORIGINAL_SOURCEMAP` | 16 TS files + `cli/package.json` verified by path/content hash |
| Current web editor | `RECOVERED_SHIPPED_BUNDLE` | Public production/lazy chunks; no valid current maps |
| Snapshot extension | `RECOVERED_SHIPPED_BUNDLE` | Official shipped CRX recovered; bundled JS; no maps |
| Full web-editor original source tree | `NOT_RECOVERED` | Original TS/TSX source tree not demonstrated in public/shipped artifacts |
| Server-only/backend source | `NOT_RECOVERED` | Not demonstrated to be shipped publicly |
| Complete private monorepo + Git history | `NOT_RECOVERED` | No private-repository access and no public artifact containing complete history |

## Integrity boundary

- This evidence does **not** claim complete Paper source recovery.
- Bundled/minified web code is not described as original TypeScript source.
- Source-map references are not treated as Paper-owned unless package/path provenance is independently established.
- Raw proprietary recovered source remains outside the public Lilac repository unless public redistribution rights are separately established.
- Public third-party repositories and dependencies retain their own license/NOTICE requirements.

## Consequence for Lilac

The expanded corpus is sufficient to treat Paper Desktop/MCP integration, much of its historical behavior, and several internal contracts as evidence-backed implementation references. Lilac can continue clean, attributable implementation while recovery proceeds in parallel. The correct source-intake state remains **PARTIAL_RECOVERY_PROVEN**, not complete monorepo import.
