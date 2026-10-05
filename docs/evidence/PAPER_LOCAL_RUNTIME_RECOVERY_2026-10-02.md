# Paper Local Runtime Recovery — 2026-10-02

## Scope

This record captures an authorized, evidence-first recovery pass against the user's installed Paper Desktop application and its local browser/runtime artifacts. The work used the already-running authorized Remote Desktop Commander fork and public/end-user-shipped Paper surfaces only.

No authentication bypass, credential extraction, private-repository access, UAC bypass, vulnerability exploitation, or hidden infrastructure access was used. Raw proprietary Paper source and shipped bundles remain local and are not committed to this public repository.

## Desktop Commander execution boundary

The authorized host was verified online before work. The active local runtime was proven to be the user's fork at `DesktopCommander-HalfMoon/dist/index.js` on branch `halfmoon/integration-work`; the official `@wonderwhy-er/desktop-commander` package was not installed or used as the runtime.

## Installed Desktop ASAR recovery

The installed Paper 0.5.14 application contains `resources/app.asar` with SHA-256:

`11469b844be7ace5dd8b4bb234f12e8c8f609b172db78c4ef776a3a9890200f1`

A local extractor parsed the ASAR directly and copied the source/config/test surface into the private local recovery corpus. The selected exact shipped surface contains **101 files** totaling **467,976 bytes**, including the Desktop `src/`, tests, scripts, package metadata, TypeScript configuration, build script, ToDesktop configuration, and environment/config files.

This installed ASAR is treated as its own artifact and is not assumed byte-identical to the previously analyzed uploaded installer artifact.

## Live Electron / CDP capture

Paper Desktop was launched with a loopback-only Chrome DevTools Protocol port for authorized local inspection. The live renderer proved a newer public web build than the 2026-09-30 build previously captured.

Observed current build identifiers include:

- `main-DapzG1bW.js`
- `MCPHandlers-9Afu-vcb.js`
- `code-import-C_93ZgW5.js`
- `to-html-T4u8plpD.js`
- `video-element-capture-UrcyWioL.js`
- `video-html-in-canvas-DD2G1lTk.js`
- `pdf-B5dIgjc3.js`
- `resolve-images-CRbv1CW9.js`

The earlier 2026-09-30 build used different hashes for several of these surfaces, including `main-BsW7aFPG.js`, `MCPHandlers-CJrIJGpp.js`, and `code-import-0ValKwcj.js`.

## MCP runtime recovery

The live renderer exposed the Paper MCP handler object. Metadata-only analysis observed **64 functions** totaling **38,948 characters** of JavaScript function source. This includes MCP dispatch/gating, editor-state binding, tool handlers, resource operations, node operations, tokens, comments, export, and agent activity.

This is `RECOVERED_RUNTIME_CLASS_SOURCE`: exact JavaScript source returned by the shipped production runtime, not the original TypeScript module tree.

## Desktop bridge runtime surface

The live context exposed `window.paper.desktop` with the current bridge surface, including tab/resource notifications, navigation/edit callbacks, icon get/set, open-file inspection, PDF export, downloads, update lifecycle, Figma OAuth, GPU diagnostics, CLI status, Claude Desktop extension installation, and MCP configuration updates.

The bridge functions are context-isolated native proxies, so `Function.toString()` reports native wrappers. The callable surface is exact runtime evidence; the original declaration bytes remain unrecovered.

## Public editor workload and EditorState graph

The public Paper playground was used as a non-destructive editor workload so no user document needed to be created. React fiber inspection exposed the live editor state graph.

The central editor object has minified constructor `gk` and approximately **68 named subsystems**, including:

- `fileDataObserver`
- `clientEditSyncState`
- `multiplayerState`
- `cameraState`
- `agentState`
- `commentState`
- `textTool`
- vector/draw/pan/zoom/gradient/targeting tool states
- `treeIndex`, `layerTreeState`, `pageState`, `selectionState`
- `treeUtils`, `hitTester`, `duplicateState`, `snapState`
- `undoManager`, `fontState`, culling/LOD/restyle state
- panel, guides, image, layout/SVG-handle state
- `tailwindState`, `tokenState`, `themePanel`, `libraryState`

## Runtime class and method source

For the current live editor:

- **67 subsystem class bodies** were recovered through V8 `Function.toString()`.
- Those class bodies total **221,324 characters** plus the central EditorState constructor source.
- **870 method bodies** were recovered across those subsystems, totaling **101,651 characters**.
- **71 React component/function types** were captured, totaling **65,017 characters** of runtime function source.

Examples of high-value recovered subsystem surfaces include camera control, selection, tree mutation, undo/redo, comments, tokens, libraries, fonts, image handling, vector editing, hit testing, snapping, collaboration/multiplayer, agent activity, and layout handles.

Again, these are exact shipped production JavaScript bodies, not the original TypeScript/TSX files, comments, source-map filenames, or Git history.

## Node/document model recovery

The public editor workload exposed the current node wrapper class with minified constructor `odt`. Its class body is approximately **27.6 KB** and exposes operations including positioning, visibility/locking, style application, CSS application, property/meta caches, guides/export metadata, text/component mutation, color traversal, and position overrides.

The node property container has constructor `BY` and exposes layout/visual property surfaces including constraints, dimensions, margin, position, rotation, transform, fill, border, corner radius, filters, shadows, blend mode, opacity, and outline.

High-value property handler class bodies recovered from the shipped runtime include the fill, constraints, border, corner-radius, transform, margin, position, rotation, opacity, and shadow-related handlers.

## App-level state recovery

A separate app-level state object exposed **16 state/services** with recoverable class bodies, including authentication state, update state, metering state, team/resources state, authenticated fetch state, user/profile state, navigation progress, Figma connection state, file collection, and socket collection.

Only class/source structure and non-secret field names were retained for evidence. Authentication/session values are not part of the repository evidence.

## Static AST census of the current web build

Using the already-installed Acorn dependency from the authorized Desktop Commander fork, the recovered current JavaScript assets were parsed without installing new packages.

The census extracted **468 unique JavaScript class bodies**, totaling **1,001,676 bytes**, from nine parsed JavaScript assets with **zero parse errors**.

The main current bundle contributed 358 classes. The current MCP bundle contributed seven classes. Other classes came from the media/module/image/Figma support chunks. This count includes third-party library classes and therefore must not be interpreted as 468 Paper-owned classes.

## Historical Chromium disk-cache recovery

Three important 2026-09-30 hashed assets were no longer downloadable from their old CDN URLs:

- `main-BsW7aFPG.js`
- `MCPHandlers-CJrIJGpp.js`
- `appBar-BBzFbwbN.js`

The installed Paper Chromium cache retained the complete Brotli-compressed response bodies and response metadata for all three. After Paper was closed normally to release cache locks, the cache entries were decoded and decompressed locally.

Recovered exact shipped bytes:

- `main-BsW7aFPG.js`: **4,026,586 bytes**, SHA-256 `c83afe159ec44491eeb6884137922b4b045b4355aa1a5ece200121a7f29291b6`
- `MCPHandlers-CJrIJGpp.js`: **189,854 bytes**, SHA-256 `df7d10b1a8c2f2ba2c5d88c2a87b25a91b0508aa6b8103ac13c043b4d7447efb`
- `appBar-BBzFbwbN.js`: **7,832 bytes**, SHA-256 `bb9567766c807a8439de51dd32b6ccde0e4546151f302d4390b9e5609fb942a7`

The cached HTTP metadata independently proves `content-type: application/javascript` and `content-encoding: br` for these responses.

## Historical static AST census

With the recovered cache bodies added, the 2026-09-30 web corpus produced:

- **517 unique class bodies**
- **1,033,400 bytes** of extracted class source
- seven class-bearing assets
- zero parse errors

Exact-source hashing found 100 class bodies byte-identical across the two observed builds. Method-signature comparison found hundreds of strong semantic matches where only minified identifiers changed. For example, the old node wrapper `Nut` maps to current `odt`, the old comment state `gxt` maps to current `Cxt`, and the old camera state `knt` maps to current `Fnt` with matching method surfaces and sizes.

Therefore simple minified class-name churn must not be reported as deleted functionality.

## Local recovery corpus

A private local corpus was created with a top-level SHA-256 manifest and provenance README. At manifest time it contained:

- **2,461 files**
- **57,211,972 bytes**

Sections include exact Desktop ASAR source/config/test material, current web assets, the recovered 2026-09-30 web build, live runtime/class/state evidence, static AST class extracts, and formatting-only readable derivatives.

Readable derivatives were generated with the already-installed Terser package using beautification only (`compress: false`, `mangle: false`). They are explicitly classified `DERIVED_READABLE`, not original source.

## Recovery classification

| Surface | State |
|---|---|
| Current Desktop TypeScript shipped in ASAR | `RECOVERED_ORIGINAL_SHIPPED` |
| Current public web asset bytes | `RECOVERED_SHIPPED_BUNDLE` |
| 2026-09-30 main/MCP/app-bar recovered from Chromium cache | `RECOVERED_SHIPPED_BUNDLE` |
| Live EditorState/subsystem class bodies | `RECOVERED_RUNTIME_CLASS_SOURCE` |
| Live MCP function bodies | `RECOVERED_RUNTIME_CLASS_SOURCE` |
| Current node/property implementation | `RECOVERED_RUNTIME_CLASS_SOURCE` |
| Desktop bridge callable surface | `RECOVERED_PUBLIC_RUNTIME_CONTRACT` |
| Original Web Editor TS/TSX source tree | `NOT_RECOVERED_ORIGINAL` |
| Server-only/backend source | `NOT_RECOVERED_ORIGINAL` |
| Complete private monorepo and Git history | `NOT_RECOVERED_ORIGINAL` |

## Remaining recovery routes

The ordinary public, shipped-artifact, browser-cache, live-runtime, and non-elevated local-host paths have now been pushed substantially further.

Windows Volume Shadow Copy / restore-point / backup and lower-level deleted-file recovery remain possible only under an explicitly elevated administrator/forensic session. The current authorized Remote Desktop Commander process is not elevated; no attempt was made to bypass UAC or Windows access controls.

Other registered devices may provide additional historical artifacts if they come online and are separately authorized/available for inspection.

## Integrity conclusion

The correct claim after this pass is stronger than the previous recovery state but still not equivalent to a private-repository clone:

> Lilac now has exact Desktop TypeScript shipped to end users, two evidence-backed generations of production web bundles including historical CDN-removed assets recovered from local cache, current MCP/runtime contracts, and substantial class-level JavaScript source for the editor architecture, state graph, node model, and application services. Original unshipped TypeScript/TSX, backend-only source, and private Git history remain unrecovered.
