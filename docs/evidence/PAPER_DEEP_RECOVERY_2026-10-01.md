# Paper Deep Recovery — 2026-10-01

## Scope

This record captures the final deep public/end-user-shipped recovery pass performed after the 21-release Desktop census. It uses only public endpoints, official distribution artifacts, public repositories, and the user-supplied/authorized Paper Desktop installer. No authentication bypass, private branch guessing, credential extraction, vulnerability exploitation, or unpublished infrastructure access was used.

Raw proprietary source recovered from shipped artifacts remains outside the public Lilac repository. This record contains only hashes, paths, symbols, contract metadata, and compatibility conclusions.

## Current Go CLI recovered from shipped Desktop artifacts

Paper Desktop 0.5.14 ships a native Go CLI in addition to the recovered TypeScript Desktop application.

### Windows x64

- shipped binary: `dist/cli-bin/win32-x64/paper.exe`
- SHA-256: `4a700c411ef6c7c12e4812c7f1c9737075e4c3e0c0c2e78d81bf0f277d0205bd`
- size: 6,381,016 bytes
- Go version metadata: `go1.26.8`
- module path: `github.com/paper-design/paper/cli`
- command package: `github.com/paper-design/paper/cli/cmd`
- build: `CGO_ENABLED=0`, `GOOS=windows`, `GOARCH=amd64`, trimpath enabled

### Linux x64

The official public AppImage was downloaded and inspected by GitHub Actions run `36788666557` on exact head `c80b3e5e2537e12f5b1b5c53d694ac9aeb881767`; the job completed **SUCCESS**.

- official AppImage SHA-256: `e343fdf1e26800399ca40a1248624cb14f4f8d4e4b060169d27b5f479ba8d896`
- shipped CLI path: `resources/app.asar.unpacked/dist/cli-bin/linux-x64/paper`
- CLI SHA-256: `29b74102ab777c295194a80ba229387afa36aff64e8a614a868729556443cb58`
- CLI size: 6,226,082 bytes
- Go version metadata: `go1.26.8`
- module path: `github.com/paper-design/paper/cli`
- command package: `github.com/paper-design/paper/cli/cmd`
- build: `CGO_ENABLED=0`, `GOOS=linux`, `GOARCH=amd64`, trimpath enabled

### Current CLI source-path union exposed by Go runtime metadata

The shipped Windows/Linux binaries expose these current first-party source paths through Go runtime metadata:

- `github.com/paper-design/paper/cli/cmd/paper.go`
- `github.com/paper-design/paper/cli/internal/config.go`
- `github.com/paper-design/paper/cli/internal/relay.go`
- `github.com/paper-design/paper/cli/internal/conn_reset_windows.go`
- `github.com/paper-design/paper/cli/internal/conn_reset_other.go`

The binaries also expose current first-party function names including configuration resolution, Desktop/remote config fetching, JSON-RPC batch/single-message handling, protocol-version negotiation, client-info propagation, MCP relay, connection failure classification, response shaping, and shutdown behavior. This is architectural/runtime evidence, not the original Go source text.

Important public literals recovered from the current CLI include:

- `https://app.paper.design`
- `/mcp/desktop/config.json`
- `X-Paper-From`
- `PAPER_ORIGIN`

## Public Desktop MCP configuration endpoint

The current Go CLI points to a public configuration endpoint:

`https://app.paper.design/mcp/desktop/config.json`

Lilac added a metadata-only probe in `.github/workflows/paper-public-mcp-config-census.yml`.

The first evidence run, `36788494280`, completed **SUCCESS** on exact head `f3b4842f30fffd71bc82c1d5be5bc858511f2eca`.

Observed response evidence:

- response SHA-256: `b8c13090b96317a540718c752ba681f8999111415e6fd29cc7510cfccd680ae2`
- instructions SHA-256: `bd15953b4e5f32088d56841c7ec9b8bf312eda3a40accedd678d8650238a2a07`
- tool count: **35**

The public endpoint exposes the same 35 tool names independently observed in the shipped production `MCPHandlers` bundle:

1. `open_file`
2. `list_files`
3. `create_file`
4. `create_page`
5. `rename_pages`
6. `get_basic_info`
7. `get_selection`
8. `get_node_info`
9. `get_children`
10. `get_screenshot`
11. `get_jsx`
12. `get_tree_summary`
13. `get_computed_styles`
14. `get_fill_image`
15. `find_nodes`
16. `list_comment_threads`
17. `get_comment_thread`
18. `list_comment_thread_authors`
19. `set_comment_thread_status`
20. `get_font_family_info`
21. `get_guide`
22. `export`
23. `export_combined_pdf`
24. `write_html`
25. `create_artboard`
26. `delete_nodes`
27. `set_text_content`
28. `rename_nodes`
29. `update_styles`
30. `duplicate_nodes`
31. `move_nodes`
32. `finish_working_on_nodes`
33. `get_tokens`
34. `create_tokens`
35. `set_tokens`

For every tool, the census records the annotation object plus SHA-256 hashes of its public description and canonicalized JSON input schema. `delete_nodes` is marked both destructive and consequential; read-only/mutating classifications for all tools are therefore machine-verifiable without committing the raw response.

### Cross-validation

This surface is independently confirmed by three different shipped/public paths:

1. the current Go CLI fetches `/mcp/desktop/config.json`;
2. the public endpoint currently returns 35 tool definitions and server instructions;
3. the public production `MCPHandlers` bundle contains handlers for the exact same 35 tool names and rejects definition/handler mismatches at construction time.

The current Desktop MCP server source also proves that `MCPServerConfig` is used as `{ tools, instructions }`, that `ListTools` returns `config.tools`, and that `CallTool` forwards requests through the Desktop bridge.

This makes the observable current MCP contract **COMPATIBILITY_RECONSTRUCTABLE** with high confidence even though the exact original `models/src/mcp/mcp-types.ts` file has not been recovered.

## Remaining three high-value TypeScript files

The 21-release source-map corpus produced no exact `sourcesContent` hit for these files:

- `assets/src/types.ts`
- `models/src/mcp/mcp-types.ts`
- `client-desktop-types/src/desktop-bridge.ts`

A final public GitHub/web sweep for the exact paths and distinctive exported type names did not locate an independently accessible original copy.

They remain `NOT_RECOVERED_ORIGINAL`, but their material compatibility surfaces are now strongly constrained:

### `assets/src/types.ts`

Current recovered Desktop source uses `AppIcon`, and the exact shipped icon map is exhaustive over:

- `default`
- `dev`
- `halftone`
- `pattern`
- `dots`
- `gooey`

A Lilac compatibility type can therefore reproduce the observable current `AppIcon` value domain without claiming the original file text.

### `models/src/mcp/mcp-types.ts`

The recovered Desktop MCP server/bridge, current Go relay, public MCP configuration endpoint, and production `MCPHandlers` jointly expose the material contract:

- transport distinction: `stdio` vs `http`;
- client identity: required name with optional version/title plus transport at the forwarding boundary;
- server configuration: tools plus instructions;
- tool results: MCP content with optional error flag;
- renderer bridge operations: get server config, handle tool call, remove agent, and log.

The 35 current input schemas are now available from the public endpoint for local compatibility generation/testing.

### `client-desktop-types/src/desktop-bridge.ts`

The exact recovered `src/preload.ts`, `src/app-bar/preload.ts`, main-process IPC handlers, and call sites expose the bridge method surface. This includes Desktop tab state, resource notifications, navigation/edit callbacks, icon get/set, open-file inspection, PDF export, downloads, update lifecycle, Figma OAuth, GPU debug information, CLI status, Claude Desktop extension installation, MCP harness configuration, app-bar tab operations, fullscreen state, context menus, renaming/reloading/moving tabs, multi-tab close modes, and new-window operations.

The original declaration file bytes remain unrecovered; the observable bridge contract is `COMPATIBILITY_RECONSTRUCTABLE`.

## Official public agent-plugin check

`paper-design/agent-plugins` was inspected as an official public source.

Its shipped `paper.mcpb` does **not** contain a hidden CLI implementation. The repository's own pack script explicitly builds a config-only MCPB whose executable entry point is the external `${HOME}/.paper/bin/paper` installed by Paper Desktop. The public plugin configuration confirms the command `~/.paper/bin/paper mcp`.

This closes that artifact as a source-recovery route rather than leaving it unresolved.

## Public mirror/package sweep

A final sweep found no public copy of the three unresolved TypeScript files or their distinctive type names outside Lilac's own evidence records. Public package-registry checks also continue to show no registry documents for the internal packages `@paper/models`, `@paper/assets`, `@paper/cli`, `@paper/client-desktop-types`, or `@paper/desktop`.

No public fork/mirror of the complete `paper-design/paper` monorepo was found in this pass.

## Recovery classification after this pass

| Surface | State |
|---|---|
| Current Desktop TypeScript | `RECOVERED_ORIGINAL_SHIPPED` |
| 21-release Desktop lineage | `RECOVERED_ORIGINAL_SHIPPED` |
| Historical embedded internal TS source | `RECOVERED_ORIGINAL_SOURCEMAP` |
| Current native Go CLI source text | `NOT_RECOVERED_ORIGINAL` |
| Current native Go CLI module/files/functions/runtime contract | `RECOVERED_SHIPPED_BINARY_METADATA` |
| Current public MCP tool definitions/schemas | `RECOVERED_PUBLIC_CONTRACT` |
| Current production MCP handler implementation | `RECOVERED_SHIPPED_BUNDLE` |
| `assets/src/types.ts` observable contract | `COMPATIBILITY_RECONSTRUCTABLE` |
| `models/src/mcp/mcp-types.ts` observable contract | `COMPATIBILITY_RECONSTRUCTABLE` |
| `client-desktop-types/src/desktop-bridge.ts` observable contract | `COMPATIBILITY_RECONSTRUCTABLE` |
| Original Web Editor TS/TSX tree | `NOT_RECOVERED_ORIGINAL` |
| Server-only/backend source | `NOT_RECOVERED_ORIGINAL` |
| Complete private monorepo + Git history | `NOT_RECOVERED_ORIGINAL` |

## Integrity conclusion

The public/end-user-shipped recovery surface has now been pushed substantially beyond the Desktop ASAR and historical source maps: the current native CLI architecture and current public MCP contract are also evidence-backed.

This still does **not** justify claiming that the complete original Paper monorepo has been recovered. The correct statement is:

> Lilac has substantial exact shipped Paper source, exact historical internal-package source fragments, the current shipped web implementation, the current public MCP schemas, and enough independent evidence to reconstruct the remaining client-side compatibility contracts. Original unshipped web/server source and private repository history remain unavailable.
