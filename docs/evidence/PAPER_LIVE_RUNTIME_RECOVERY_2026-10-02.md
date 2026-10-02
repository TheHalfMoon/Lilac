# Paper Live Runtime Recovery — 2026-10-02

## Scope

This record captures a deep recovery pass against Paper Desktop 0.5.14 and the current publicly served Paper web editor. The work used the project owner's authorized Windows device, the installed end-user Paper application, public Paper endpoints, a separate temporary Electron profile, Chrome DevTools Protocol bound to localhost, and the public Paper playground.

No authentication bypass, credential extraction, private repository guessing, vulnerability exploitation, or access to unpublished infrastructure was used. The temporary debugging session was terminated after capture and localhost debugging port 9333 was verified closed.

Raw recovered proprietary Paper source and production bundles are not committed to the public Lilac repository. This document records counts, hashes, contracts, and reconstruction boundaries only.

## Authorized local runtime

The Remote Desktop Commander device used for this pass was `Abdulaziz`. Connectivity was verified before work. The connected runtime was the owner's authorized fork at `C:\Users\Shehr\DesktopCommander-HalfMoon`, branch `halfmoon/integration-work`, observed HEAD `11b6c406e5f267d7c4c9382883beafd1c5435478`.

## Current public web build

The live Paper editor served a newer asset generation than the previous 2026-10-01 census. Representative current chunks included:

- `main-DapzG1bW.js` — 4,033,425 bytes
- `MCPHandlers-9Afu-vcb.js` — 191,547 bytes
- `code-import-C_93ZgW5.js` — 32,791 bytes
- `to-html-T4u8plpD.js` — 43,844 bytes
- `resolve-images-CRbv1CW9.js`
- `pdf-B5dIgjc3.js`
- `video-element-capture-UrcyWioL.js`
- `video-html-in-canvas-DD2G1lTk.js`

The local recursive capture recorded **36 resources totaling 15,463,061 bytes**. Conventional source-map probes against the current Paper asset set yielded **zero valid Paper source maps**.

Current bundle literals expose first-party package references including:

- `@paper/assets`
- `@paper/client-signals`
- `@paper/models`
- `@paper/svg-parser`
- `@paper/vector-graph`

`client-signals`, `svg-parser`, and `vector-graph` are newly identified recovery/reimplementation targets relative to the earlier source-intake ledger.

## Current MCP contract: 36 tools

The public endpoint `https://app.paper.design/mcp/desktop/config.json` currently exposes **36 tool definitions**. A live runtime read of `mcpHandlers.toolHandlers` produced the exact same sorted set of 36 names, so the public configuration and shipped implementation agree one-for-one.

The current tool set is:

1. `create_artboard`
2. `create_file`
3. `create_page`
4. `create_tokens`
5. `delete_nodes`
6. `duplicate_nodes`
7. `export`
8. `export_combined_pdf`
9. `find_nodes`
10. `finish_working_on_nodes`
11. `get_basic_info`
12. `get_children`
13. `get_comment_thread`
14. `get_computed_styles`
15. `get_fill_image`
16. `get_font_family_info`
17. `get_guide`
18. `get_jsx`
19. `get_node_info`
20. `get_screenshot`
21. `get_selection`
22. `get_tokens`
23. `get_tree_summary`
24. `list_comment_thread_authors`
25. `list_comment_threads`
26. `list_resources`
27. `move_nodes`
28. `open_file`
29. `rename_nodes`
30. `rename_pages`
31. `rename_resource`
32. `set_comment_thread_status`
33. `set_text_content`
34. `set_tokens`
35. `update_styles`
36. `write_html`

This supersedes the previous 35-tool snapshot as a statement about the current live contract.

## Live MCP implementation recovery

The current editor exposes `window.mcpHandlers`, `window.resolveMCPHandlers`, and `window.paper`. V8 function-source inspection recovered executable function bodies from the shipped client runtime, including:

- configuration/definition validation
- tool dispatch and timeouts
- argument validation
- editor-state synchronization
- edit/usage/connectivity gates
- transactions executed without polluting user undo history
- agent read/write attribution
- tree-summary and node serialization
- HTML-to-design import behavior
- style application behavior
- comment serialization helpers
- resource refresh/rename behavior

The current `mcpHandlers` class source recovered from V8 is approximately **42.7 KB**. This is shipped runtime implementation, not the original unminified TypeScript module.

## Public-playground editor-state recovery

To avoid reading a user's design content, the recovery session navigated an isolated renderer to the public Paper playground. The resulting editor state exposed the current subsystem graph without relying on a private document.

Observed editor subsystems include `treeUtils`, `undoManager`, `cssParser`, `tailwindState`, `tokenState`, `selectionState`, `snapState`, `agentState`, `multiplayerState`, `vectorEditingState`, `pageState`, `commentState`, `fontState`, `imageState`, `libraryState`, `cameraState`, `layerTreeState`, `textTool`, `themePanel`, and many others.

V8 constructor/prototype/own-function capture produced **66 editor subsystem records totaling 628,676 bytes** of serialized function/class source evidence. Representative subsystem source volumes include:

| Subsystem | Approx. captured bytes |
|---|---:|
| `commentState` | 52,177 |
| `fontState` | 32,380 |
| `tokenState` | 29,237 |
| `cameraState` | 26,564 |
| `themePanel` | 25,648 |
| `selectionState` | 25,079 |
| `imageState` | 24,434 |
| `libraryState` | 22,002 |
| `treeUtils` | 20,008 |
| `undoManager` | 17,314 |
| `cssParser` | 17,275 |
| `agentState` | 15,101 |
| `vectorEditingState` | 14,711 |
| `pageState` | 13,985 |
| `snapState` | 13,108 |
| `multiplayerState` | 9,513 |

These records are local recovery material and are not committed here.

## AST recovery

Paper Desktop ships the TypeScript compiler in its ASAR. That shipped compiler was used locally to parse and format the current production JavaScript without downloading a parser.

The current captured JavaScript corpus produced:

- **27 JavaScript chunks parsed**
- **536 classes**
- **23,031 functions**
- **48,929 variable declarations**
- **0 parse diagnostics**

The current main bundle alone contained 7,284 top-level statements, 358 classes, 17,067 functions, and 36,245 variable declarations in the parser inventory.

Runtime constructor names were then mapped back into the parsed AST. **60 editor subsystem classes** were isolated into readable class-level files, totaling approximately **262,812 bytes**. Runtime capture remains available for the small set that could not be uniquely mapped by class name.

## React runtime recovery

The public playground's React Fiber graph was inspected without recording component props or design content. The capture traversed **651 fibers** and recovered **68 component function sources totaling 51,189 bytes**. Most production names remain minified, but the function bodies are available locally for compatibility reconstruction.

## Exact current Desktop TypeScript

A local ASAR parser extracted the current shipped Desktop source. The recovery set contains **95 Desktop source/test/script/metadata files totaling 463,901 bytes**. Key exact first-party TypeScript files include:

- `src/preload.ts`
- `src/app-bar/preload.ts`
- `src/mcp/server.ts`
- `src/mcp/bridge.ts`
- `src/mcp/index.ts`
- `src/main.ts`

This exact shipped source independently constrains the missing desktop bridge declarations through their call sites and `satisfies` checks.

## Three previously unresolved client-side contracts

The original text of these files remains unrecovered:

- `assets/src/types.ts`
- `models/src/mcp/mcp-types.ts`
- `client-desktop-types/src/desktop-bridge.ts`

However, this pass produced usable local compatibility TypeScript implementations for all three. They are explicitly labeled reconstruction rather than original source and passed TypeScript syntax parsing with zero diagnostics.

### `assets/src/types.ts`

The exact current `AppIcon` value domain is independently constrained by the shipped Desktop icon map:

`default | dev | halftone | pattern | dots | gooey`

### `models/src/mcp/mcp-types.ts`

The current Desktop source and public contract constrain at least:

- `MCPTransport = 'stdio' | 'http'`
- `MCPClientInfo = { name: string; version?: string; title?: string }`
- server configuration as tools plus instructions
- tool-result content plus optional error state
- renderer bridge methods `getMCPServerConfig`, `handleToolCall`, `removeAgent`, and `mcpLog`

The current 36 public tool schemas are retained locally for compatibility generation/testing.

### `client-desktop-types/src/desktop-bridge.ts`

Current exact `src/preload.ts`, app-bar preload, main-process handlers, window code, and MCP-config code constrain the bridge surface and related types. Confirmed domains/shapes include:

- `DesktopMCPHarness`: `claude-code | github-copilot | opencode | chatgpt | codex-cli | antigravity`
- `UpdateAvailability`: `client | client-chunk-error | desktop | null`
- `CloseTabsMode`: `others | right | all`
- `DesktopOpenFile`: `{ id: string; name: string; active: boolean }`
- Desktop callbacks for resources, navigation, edit commands, downloads, updates, Figma OAuth, CLI status, Claude extension installation, and MCP-config updates
- app-bar operations for tab state, fullscreen state, context menus, activation, reload, rename, move, and multi-tab close

Local reconstructed-file evidence hashes:

| File | Bytes | SHA-256 |
|---|---:|---|
| `mcp-types.ts` | 1,047 | `f4e0425c9159a5441bc2c2038ede1fbd567bb59d7cdcf33d2f14a2617a3d0ba1` |
| `desktop-bridge.ts` | 3,421 | `87a208359f7e181a9ad82d27c0634a0d919ee0aa750bdd768fee8edc81ca3b23` |
| `assets-types.ts` | 155 | `d46dba17e5f6f377ec388df478fa04505412e917d47a34e910028af616aeee9d` |

## Local verification snapshot

The local recovery verification reported:

| Metric | Result |
|---|---:|
| Exact current Desktop files | 95 |
| Exact current Desktop bytes | 463,901 |
| Captured current public resources | 36 |
| Captured public-resource bytes | 15,463,061 |
| Parsed JS chunks | 27 |
| AST classes | 536 |
| AST functions | 23,031 |
| Editor subsystems with runtime source evidence | 66 |
| Editor subsystem serialized source bytes | 628,676 |
| AST-mapped editor subsystem classes | 60 |
| React component functions | 68 |
| React component source bytes | 51,189 |
| Current public MCP tools | 36 |
| Current runtime MCP handlers | 36 |
| Public/runtime MCP name-set match | PASS |

## Remaining original-source boundary

This pass materially reduces the client-side reconstruction gap, but it still does **not** justify claiming complete recovery of the original Paper repository.

The following remain `NOT_RECOVERED_ORIGINAL` as original authoring-time source/history:

- the exact original text of the three declaration files listed above, despite usable compatibility implementations
- the original unbundled Web Editor TS/TSX module tree and authoring-time filenames where they were not shipped
- server-only/backend source that never reached an end user or public endpoint
- private monorepo Git history, internal commits, PRs, and unshipped tests/tools

## Conclusion

The correct post-pass statement is:

> Lilac now has exact shipped Paper Desktop TypeScript, historical embedded internal-package source fragments, the current public web implementation, a live current 36-tool MCP contract, substantial runtime-recovered editor implementation across state classes and UI components, and usable compatibility implementations for the three previously unresolved client-side declaration contracts. The original unshipped web/server source tree and private repository history remain unavailable and must not be described as recovered.
