# Paper Live Runtime Recovery — 2026-10-03

## Scope

This record captures a local, user-authorized recovery pass against Paper Desktop 0.5.14 running on the project owner's Windows device. The work used the already-installed Paper application, its local Electron DevTools Protocol endpoint, the exact shipped `resources/app.asar`, and Paper's public Desktop MCP configuration endpoint.

No authentication bypass, credential extraction, private-repository access, vulnerability exploitation, or unpublished infrastructure access was used. Raw proprietary Paper source and production bundles remain local and are **not** committed to the public Lilac repository.

## Local provenance boundary

The local recovery corpus is stored outside the public repository under:

`C:\Users\Shehr\Paper-Recovery`

Public Lilac evidence records only hashes, counts, names, compatibility conclusions, and architecture metadata.

## Live Electron renderer capture

Paper Desktop exposed its local Electron DevTools Protocol endpoint on `127.0.0.1:9229` for the authorized session. Runtime metadata identified:

- Paper Desktop: `0.5.14`
- Electron: `44.4.5`
- Chrome: `152.0.7977.130`
- V8: `15.2.124.28`

The current renderer build differed from the previously captured production build. Current first-party asset names included:

- `main-DapzG1bW.js`
- `client-DISTLwy7.js`
- `MCPHandlers-9Afu-vcb.js`
- `code-import-C_93ZgW5.js`
- `to-html-CfuejDzV.js`
- `parse-figma-TFGCWhXV.js`
- `number-D_yLpAzk.js`
- `video-html-in-canvas-CKFuwEsE.js`
- `pdf-K70mj8R1.js`
- `rain-indicator-Cv4Ty850.js`
- `gradient-handles-DZeyUuES.js`
- `resolve-images-BP9bbl-2.js`
- `video-element-capture-DJVxSApS.js`
- `module-CkefAiOm.js`
- `reader-DTlNDWnu.js`
- `index-GolVoWLx.js`

Sixteen exact shipped JavaScript assets were captured through `Debugger.getScriptSource`, totaling 4,971,280 bytes. Current scripts expose no valid `sourceMapURL`.

Selected local artifact hashes:

| Local artifact | Bytes | SHA-256 |
|---|---:|---|
| `main-DapzG1bW.js` | 4,036,910 | `b63d725bae5b38df0b1407c0c6812fb3dc3a0b1047406c62be229e7671213e45` |
| `MCPHandlers-9Afu-vcb.js` | 191,754 | `5f1d2d9a50d0297b832f777138cbe7ac98600170014ea2169b7754a45137b257` |
| live capture manifest | 7,375 | `8590cef1c3d68d3975c7f08f49008329e60a26975aabdee2fe5ad4ae1a60b43e` |
| runtime state schema | 19,692 | `fffa1840c2504b271afea278b1a1dba2036af6c4db135df1229df7a2d61214b4` |
| current MCP config | 67,875 | `8e530d443b18955fcdb0f7a8861761c85d84016a481591de077a51baedb78ab1` |

## Current web architecture evidence

AST analysis of the exact current main bundle produced:

- 343 class declarations
- 5,296 function declarations
- 445 filtered semantic strings
- 1,200 retained semantic property signals

The current web build directly references internal package identities including:

- `@paper/assets`
- `@paper/client-desktop-types`
- `@paper/client-signals`
- `@paper/models`
- `@paper/svg-parser`
- `@paper/vector-graph`
- `@paper-design/shaders`
- `@paper-design/shaders-react`
- `@paperdesign/fonts`

Observed application surfaces include auth, files/resources, teams, presence, metering, comments, tokens, code import/export, Figma import, SVG/vector handling, PDF export, Tailwind processing, and MCP.

## Live editor state blueprint

Runtime inspection exposed state and method surfaces without reading or publishing design content. Confirmed state subsystems include:

- `cameraState`: zoom, camera positioning, canvas/artboard fitting, pan
- `selectionState`: click/shift/marquee selection, traversal, selected IDs/bounds/center
- `editorState`: editing element, subtree/context roots, text editing
- `fileState`: resources, resource map, merge/rename/update operations
- `pageState`: add/delete/rename/select/move pages and page properties
- `layerTreeState`: expansion, collapse, hover, rename
- `undoManager`: transact, undo, redo, stacks, hydration, origins
- `tokenState`: token collections and variable change state
- `multiplayerState`: connection, collaborators, editor map, Yjs document, awareness
- `commentThreadState`: create/reply/delete/read/resolve/update thread behavior
- `vectorEditingState`: vector graph, node, and edge operations
- `tailwindStylesState`
- additional DOM, gradient, image, navigation, typography, and UI state surfaces

The shipped MCP implementation also exposes transaction and agent-attribution primitives such as `transactionWithoutUndo`, `recordAgentRead`, `recordAgentWrite`, `getAgentActionSnapshot`, `getAffectedNodeAndAncestorsSnapshot`, `setEditorState`, `waitForEditorState`, serialization helpers, tree traversal helpers, and client connect/disconnect behavior.

## MCP contract drift and current surface

The earlier 2026-10-01 census recorded 35 tools. The 2026-10-03 public configuration now exposes **36** tools, proving live contract drift.

New/current resource-oriented tools include `list_resources` and `rename_resource`; the complete current tool set is preserved in the local validation artifact. The runtime handler surface and public configuration were cross-checked during this pass.

## Exact Desktop source and compatibility reconstruction

The installed Paper 0.5.14 `resources/app.asar` was extracted locally. It contains exact current Desktop TypeScript including `src/preload.ts`, `src/app-bar/preload.ts`, MCP server/bridge code, window/tab code, export code, and tests.

That exact source plus the live runtime and public MCP schema was used to independently reconstruct the three previously missing client-side contracts. The reconstructed files remain local and are explicitly labeled `COMPATIBILITY_RECONSTRUCTED`, not original monorepo source text.

Validated reconstructed surfaces:

- `assets/src/types.ts` observable `AppIcon` contract
- `models/src/mcp/mcp-types.ts` observable MCP contract
- `client-desktop-types/src/desktop-bridge.ts` observable Desktop bridge contract
- supporting Desktop tab types required by the bridge

Reconstruction validation result:

- TypeScript strict check: **PASS**
- Desktop bridge top-level keys: **27 exact / 27 reconstructed**, 0 missing, 0 extra
- AppIcon values: **6 exact / 6 reconstructed**, 0 missing, 0 extra
- MCP bridge methods: **4 exact / 4 reconstructed**, 0 missing, 0 extra
- Current MCP public tool count: **36**
- Overall structural validator: **PASS**

Local validation artifact SHA-256:

`9c3d606afe5de94367c47445d77f3fe55cfb1ac8f2ec60b08b869e53e553a0be`

## Temporary editor session cleanup

A temporary blank Paper file was created only to force editor-only runtime loading. It was subsequently archived through Paper's visible Files context menu, and its Files card was verified absent afterward. No existing user design was modified.

## Classification after this pass

| Surface | State |
|---|---|
| Current Paper Desktop TypeScript | `RECOVERED_ORIGINAL_SHIPPED` |
| Current Paper web JavaScript implementation | `RECOVERED_SHIPPED_BUNDLE` |
| Current renderer/runtime architecture | `RECOVERED_RUNTIME_CONTRACT` |
| Current MCP public schemas | `RECOVERED_PUBLIC_CONTRACT` |
| Current MCP handler implementation | `RECOVERED_SHIPPED_BUNDLE` |
| `assets/src/types.ts` original text | `NOT_RECOVERED_ORIGINAL` |
| `assets/src/types.ts` material compatibility contract | `COMPATIBILITY_RECONSTRUCTED_VALIDATED` |
| `models/src/mcp/mcp-types.ts` original text | `NOT_RECOVERED_ORIGINAL` |
| `models/src/mcp/mcp-types.ts` material compatibility contract | `COMPATIBILITY_RECONSTRUCTED_VALIDATED` |
| `client-desktop-types/src/desktop-bridge.ts` original text | `NOT_RECOVERED_ORIGINAL` |
| `client-desktop-types/src/desktop-bridge.ts` material compatibility contract | `COMPATIBILITY_RECONSTRUCTED_VALIDATED` |
| Original Web Editor TS/TSX source tree | `NOT_RECOVERED_ORIGINAL` |
| Server/backend-only source | `NOT_RECOVERED_ORIGINAL` |
| Complete private monorepo and Git history | `NOT_RECOVERED_ORIGINAL` |

## Remaining recovery avenues

This pass materially closes the client-side contract gaps, but it does not create bytes that were never shipped. Remaining original-source recovery avenues are limited to genuinely new artifacts, another device/cache carrying older builds, or elevated read-only forensic access to Windows restore/shadow/deleted-file metadata. Those avenues must not be confused with recovered original source until exact bytes are found.

For product implementation, the validated client-side compatibility contracts are no longer blockers. Lilac can proceed with independent implementation while retaining the provenance distinction between exact recovered source, shipped bundles, runtime contracts, and reconstructed compatibility source.
