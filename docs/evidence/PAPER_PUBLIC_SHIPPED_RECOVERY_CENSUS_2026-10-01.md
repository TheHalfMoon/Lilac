# Paper Public/Shipped Recovery Census — 2026-10-01

## Scope

This evidence record inventories Paper artifacts that are publicly downloadable or shipped to end users. It does **not** use authentication bypass, private-repository access, credential extraction, or unpublished infrastructure access.

Per the project owner's authorization attestation, Paper is an authorized donor/source for Lilac. This record intentionally stores metadata, hashes, paths, and architectural findings only. Raw proprietary Paper source recovered from shipped artifacts is **not** committed to the public Lilac repository.

## Result

Private GitHub access is no longer the only useful source-intake path. The shipped/public artifact surface contains substantial first-party material, including exact Desktop TypeScript source, historical source maps with embedded source content, the Snapshot extension, current web-editor bundles, and public Paper repositories.

The complete Paper monorepo is still **not** recovered. In particular, server-only source, unshipped tests/tools, Git history, and private packages that never entered a distributed artifact remain unavailable.

## Current Desktop 0.5.14

The owner-supplied Windows installer was previously recovered and recorded in `PAPER_DESKTOP_0.5.14_RECOVERY.md`.

Cross-platform comparison was extended to the current publicly downloadable Linux and macOS artifacts:

| Artifact | Download bytes | Download SHA-256 | `app.asar` SHA-256 | ASAR entries | First-party `src/*.ts` |
|---|---:|---|---|---:|---:|
| Windows x64 NSIS | 125,534,680 | `44fbf4525608a3d95c8ccc55a4d7d6100dd4e749b50b897c7dcefa00844e42dd` | recovered separately from NSIS payload | recovered separately | 81+ |
| Linux AppImage | 141,858,276 | `e343fdf1e26800399ca40a1248624cb14f4f8d4e4b060169d27b5f479ba8d896` | `3ddfa29a9f58e01a0cd9da687c140ebe29ba6ebf9dcee82a6e55021d62ab2ec3` | 5,798 | 81 |
| Linux DEB | 112,035,180 | `f38915a86b490110888883922fa65119c9229a17492f6b8e048706289e335291` | `3ddfa29a9f58e01a0cd9da687c140ebe29ba6ebf9dcee82a6e55021d62ab2ec3` | 5,798 | 81 |
| Linux RPM | 99,068,960 | `c2ca5b256e1563ad49660b9f865b1a7f9011edc2c30da1a79f9360ca1b557681` | `3ddfa29a9f58e01a0cd9da687c140ebe29ba6ebf9dcee82a6e55021d62ab2ec3` | 5,798 | 81 |
| macOS arm64 DMG | 145,231,619 | `e5d05739deb9e918421c7d19c2d3e6652ef50339581cbf1ec09ac11e390a80f8` | `0cbcad47a4119e675b17804db2058e6f187ec8345ce30a512b0b0626fdcd84e8` | 5,732 | 81 |

Linux packaging formats converge on the same `app.asar`. macOS differs at the archive level but exposes the same first-party Desktop-source count. Current 0.5.14 packages do not ship source maps for the Desktop bundle.

The current Desktop package identifies itself as:

- package: `@paper/desktop`
- version: `0.5.14`
- `private: true`
- license field: `Proprietary`

## Historical Desktop builds

Public ToDesktop release artifacts were enumerated and recovered for nine versions:

| Version | Build ID | ASAR entries | First-party source files | Source maps |
|---|---|---:|---:|---:|
| 0.1.10 | `26031739o5exfj4` | 6,391 | 20 | 897 |
| 0.1.12 | `2604116ylbmu5uc` | 6,321 | 23 | 897 |
| 0.1.14 | `260513c3lncpex8` | 7,580 | 27 | 1,447 |
| 0.2.0 | `2605227oebjghyb` | 7,589 | 29 | 1,448 |
| 0.3.2 | `260529m17bb6bkl` | 7,589 | 29 | 1,448 |
| 0.4.4 | `260706m7lwa680d` | 7,610 | 30 | 1,454 |
| 0.5.0 | `260718w0gs8apen` | 7,167 | 45 | 1,458 |
| 0.5.7 | `260904829lm19ta` | 7,215 | 69 | 1,453 |
| 0.5.14 | `260930cd6gd2j72` | 5,732 | 84 total first-party source paths in the macOS archive, 81 TypeScript | 0 |

Across this lineage:

- 87 unique first-party Desktop source paths were observed.
- 36 source paths changed content across releases.
- 3 source paths were historical-only and are absent from the latest recovered source tree.
- The historical series provides behavior and architecture lineage rather than only a current snapshot.

Examples of recovered first-party Desktop areas include auth, deep links, PDF export, CLI integration, MCP bridge/server, application menus, preload, storage/update/telemetry, window/tab management, render health, and related tests.

## Historical source maps

Historical Desktop packages are materially more informative than 0.5.14 because multiple releases shipped source maps.

A parsed historical map-bearing corpus produced:

- 1,453 source-map files found and parsed in the analyzed build corpus.
- 392 maps with embedded `sourcesContent`.
- 2,171 unique referenced source paths.
- 1,775 referenced source paths with embedded content.
- 719 paths classified as potentially Paper/monorepo-related during automated triage.
- 440 potentially Paper/monorepo-related paths with embedded source content.

The broad `Paper/monorepo-related` classifier is intentionally conservative and can include dependency/example material. It is **not** equivalent to 440 proven Paper-owned files.

### Verified internal monorepo package source embedded in maps

Ten exact internal-package source files were separately verified by package-relative paths and embedded content:

- `models/src/api-address.ts`
- `models/src/auth/session-cookie.ts`
- `models/src/auth/cosmetic-preauth-user-info-cookie.ts`
- `models/src/typebox-helpers.ts`
- `models/src/file/parse-file-id.ts`
- `models/src/file/export-meta-schema.ts`
- `assets/src/colors.ts`
- `assets/src/page-title.ts`
- `cli/paths.ts`
- `client-desktop-types/src/desktop-tabs.ts`

This is direct evidence that historical shipped maps expose exact source from internal packages outside `@paper/desktop` itself.

Public npm registry checks did not expose registry documents for `@paper/models`, `@paper/assets`, `@paper/cli`, `@paper/client-desktop-types`, or `@paper/desktop`; the shipped artifacts remain the evidence source for these package surfaces.

## Snapshot extension

The official Chrome extension was downloaded from Google's CRX distribution endpoint and unpacked successfully.

- extension: Paper Snapshot
- recovered version: `0.4.4`
- CRX kind: CRX3
- bytes: 107,456
- SHA-256: `45fc07bbc9dcd165f01c4497d1696337de6180e40fdbc70ec462293e58605261`
- JavaScript files: 3
- JavaScript bytes: 243,920

Shipped JS files:

- `background.js` — 45,878 bytes
- `offscreen.js` — 1,886 bytes
- `popup.js` — 196,156 bytes

Observed extension capabilities include `chrome.scripting.executeScript`, active-tab access, clipboard write, offscreen document use, context menus, optional `<all_urls>` host permission, runtime messaging, and the public Paper import flow at `https://paper.design/import-anything`.

No source map was found in the unpacked extension.

## Current public web editor

The current public editor/application surface was crawled without authentication bypass. A broad asset census observed 63 public assets, including 20 JavaScript assets and approximately 15 MB of public asset bytes. A normalized editor-only pass identified the current core/lazy modules and verified that `.map` probes return the application HTML shell rather than valid source maps.

Observed first-party editor chunks include:

- `main-BsW7aFPG.js`
- `client-Bz0wzmr7.js`
- `MCPHandlers-CJrIJGpp.js`
- `code-import-0ValKwcj.js`
- `parse-figma-CkaBPLNN.js`
- `to-html-CFNC8Out.js`
- `resolve-images-B5FBS1yL.js`
- `pdf-BqNMom-b.js`
- `video-element-capture-omW4NKmx.js`
- `video-html-in-canvas-U6hqbT7K.js`
- `gradient-handles-BBlU8txW.js`
- `avif-worker-CGHT-6sL.js`
- `index-Bml-9gVJ.js`

Additional dynamically referenced chunk names found in the current main bundle include `heic-to-Dc1KBscf.js` and `module-CkefAiOm.js`; these should remain in the continuing asset-census queue until independently hashed and classified.

Current public web source maps: **0 valid maps recovered**.

## Wayback/public-index history

A public Wayback census observed:

- 206 CDX records
- 143 JavaScript records
- 105 unique bundle URLs
- 86 archived JS records successfully retrieved during the probe
- 0 inline source maps
- 0 external source-map references
- 0 valid archived map source contents recovered

Wayback therefore adds historical bundle coverage but, in the currently observed corpus, does not add source-map recovery.

## Public repositories

The public Paper organization remains useful for independently licensed components and integration contracts. Recovered public repositories include `shaders`, `paper-mono`, `agent-plugins`, `liquid-logo`, and `webmcp-agent-example`. These are tracked independently from proprietary product-source recovery and must retain their own license/NOTICE requirements.

## Recovery classification

| Surface | State | Meaning |
|---|---|---|
| Current Desktop shell/MCP source | `RECOVERED_ORIGINAL_SHIPPED` | Exact first-party TypeScript is present in distributed packages. |
| Historical Desktop source lineage | `RECOVERED_ORIGINAL_SHIPPED` | Exact first-party source across nine public releases is available for comparison. |
| Internal monorepo package fragments from historical maps | `RECOVERED_ORIGINAL_SOURCEMAP` | Exact embedded source verified for at least ten internal-package files. |
| Snapshot extension | `RECOVERED_SHIPPED_BUNDLE` | Complete shipped CRX contents recovered; JS is bundled, no maps found. |
| Current web editor | `RECOVERED_SHIPPED_BUNDLE` | Current production JS/lazy chunks recoverable; source maps not publicly valid. |
| Historical web bundles | `RECOVERED_SHIPPED_BUNDLE` | Public archive history adds behavioral/version evidence. |
| Full web-editor TypeScript/React source tree | `NOT_RECOVERED` | Production bundles are available, original source tree is not. |
| Server-only/backend source | `NOT_RECOVERED` | Not demonstrated to be shipped publicly. |
| Git history/PRs/internal CI | `NOT_RECOVERED` | Requires original repository history; not reconstructed from artifacts. |

## Lilac consequence

Lilac no longer needs to treat private GitHub access as a hard prerequisite for all progress. The recovered material is sufficient to begin a clean, attributable implementation of the Desktop integration layer, internal contracts, document/MCP compatibility surfaces, and observable editor behavior while continuing artifact recovery in parallel.

However, `P00-G03` must not be labeled as a complete import of the Paper monorepo. The honest state is **PARTIAL_RECOVERY_PROVEN**: substantial exact source is recovered, but the full original product repository is not.

## Integrity and publication boundary

- Do not commit raw proprietary Paper source to the public Lilac repository unless publication rights are explicitly established.
- Preserve hashes, provenance, source artifact/version, and extraction lineage for every recovered file.
- Keep independently licensed public repositories under their own license and NOTICE requirements.
- Do not call bundled/minified web code "original TypeScript source".
- Do not call source-map references "Paper-owned" unless ownership is independently established.
- Do not claim complete Paper source recovery while server-only/unshipped/private-repository material remains unavailable.
