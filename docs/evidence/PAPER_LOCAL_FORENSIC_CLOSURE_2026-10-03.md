# Paper Local Forensic Closure — 2026-10-03

## Scope

This record closes the current Windows-device recovery pass after the live-runtime recovery program.
The work was performed on the project owner's authorized device and used read-only inspection wherever possible.
An elevated PowerShell session was used only to read Windows USN/VSS/restore/recycle metadata that the normal session could not access.

No authentication bypass, credential extraction, private-repository access, exploit, destructive disk operation, deleted-file carving, or shadow-copy creation was performed.
Raw recovered Paper source, production bundles, runtime function bodies, and local user data remain outside the public Lilac repository.

## Administrator forensic result

The elevated session was verified as Administrator and completed successfully.

- VSS: no shadow copies exist for the current system volume.
- Shadow storage: configured maximum 4.00 GB; current used and allocated space are 0 bytes.
- System Restore: no restore points were returned.
- Recycle Bin: no Paper/app.asar/MCP/source-map matches were found.
- USN journal: readable under elevation; filtered recovery produced 992 matching records.
- The earliest filtered match was 2026-10-03 03:32:27 local time and was unrelated `hast-util-to-html` activity.
- Before 04:00, no `Paper Setup`, `app.asar`, `Paper.exe`, Paper MCP bundle, or Paper web-chunk record was present.
- Paper bundle names found after 04:07 correspond to the recovery corpus created during this authorized session, not historical deleted artifacts.

## Additional local storage sweep

The device exposes system volume `C:` and secondary volume `D:` plus OneDrive and Box sync roots.

- `D:` filename scan returned only unrelated paper/research documents; no Paper.design product artifact was found.
- No `app.asar` was found on `D:`.
- OneDrive contains the current Paper desktop shortcut and unrelated project documents, but no Paper installer/source archive or `app.asar` backup.
- Box returned no Paper filename matches.
- No additional local Paper updater cache or pending update package was present.

These checks materially reduce the probability that an older Paper application artifact remains on attached/synced storage on this device.

## Internal package publication sweep

The current shipped web client proves workspace package identities including:

- `@paper/client-signals`
- `@paper/svg-parser`
- `@paper/vector-graph`
- `@paper/models`
- `@paper/assets`
- `@paper/client-desktop-types`
- `@paper/desktop`
- `@paperdesign/fonts`

Direct npm registry probes returned HTTP 404 for all eight identities above.
GitHub/public-web searches did not locate an independent source copy of those internal packages.
Standard public Vite/build manifest paths returned the Paper HTML shell rather than build metadata; `version.json` remains the only confirmed public version marker in that probe set.

## Additional runtime reconstruction evidence

The authorized live renderer was inspected through its local Electron DevTools Protocol endpoint without reading credentials or design content.
A React-fiber pass collected component function definitions only, excluding props/state values and document content.

- 4 Paper page targets inspected.
- 99 distinct React component function bodies recovered from the live runtime.
- 98 carried production function names; most names remain minified.
- Readable retained names include runtime components such as `HotkeyZone` and `HotkeyProvider`.
- Function bodies are retained only in the private recovery corpus with SHA-256 provenance.

This augments the previously proven AST/function/runtime corpus but does not recover original TSX file boundaries or original source names.

## Recovery boundary after this pass

No additional original Paper source bytes were recovered from Windows shadow copies, restore points, the Recycle Bin, the accessible USN window, attached `D:` storage, OneDrive, Box, public internal-package registries, or standard Vite manifest paths.

The remaining exact-original gaps therefore require a genuinely new artifact/source location, for example an older device/cache, an authorized archive, or the private monorepo itself.

This does **not** mean the full original Paper monorepo has been recovered.
The correct classification remains:

- shipped Desktop source: exact recovered source;
- shipped web implementation: recovered bundle/runtime source-equivalent corpus;
- observable client contracts: compatibility reconstructed and validated;
- original unshipped Web TS/TSX, server/backend source, and private repository history: not recovered.

For Lilac implementation, the remaining original-source gaps are no longer client-side compatibility blockers.
Future recovery work should be event-driven by genuinely new artifacts rather than repeat the exhausted paths recorded here.

## Local evidence hashes

The underlying private evidence is bound by SHA-256 without publishing raw forensic output:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| Administrator status | 119 | `e07507107ef4999e647bc9a14629cfc966dc4029127d011201989b2ae4c13d1f` |
| VSS result | 666 | `ca81e8dcc7e70ea22135e45470d508bf2622903a9458ceaa6b7767553007062f` |
| Filtered USN evidence | 222,748 | `bdbd75deb872e75c160996c2b96e0dbba4f4c33a005296fb017b62c628eb1e62` |
| React component-function census | 117,188 | `e128fc7c2bc4a7e88902b772b4161a934da1c580433aa6f969bcf9f53190a7de` |
