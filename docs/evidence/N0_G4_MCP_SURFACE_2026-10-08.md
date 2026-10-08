# N0-G4b: the MCP tools carry Ninerr names

Issue: #190 (N0 umbrella). This is the second half of N0-G4. The first half, `N0_G4A_MCP_CATALOG_2026-10-09.md` (#208), replaced the mirrored Paper tool list with Ninerr's own catalog. The tools kept their Paper-style names there; this half gives them Ninerr's.

| Before | Now | Class |
| --- | --- | --- |
| `get_basic_info` | `project_info` | read |
| `get_tree_summary` | `layer_tree` | read |
| `get_node_info` | `layer_details` | read |
| `get_children` | `layer_children` | read |
| `find_nodes` | `find_layers` | read |
| `get_selection` | `selection` | read |
| `get_jsx` | `layer_code` | read |
| `get_guide` | `guide` | read |
| `finish_working_on_nodes` | `finish_task` | read |
| `create_artboard` | `create_frame` | write |
| `set_text_content` | `set_text` | write |
| `rename_nodes` | `rename_layers` | write |
| `update_styles` | `set_styles` | write |
| `move_nodes` | `move_layers` | write |
| `duplicate_nodes` | `duplicate_layers` | write |
| `delete_nodes` | `delete_layers` | consequential |

- **Classes.** The classes are unchanged. The server, the catalog, the editor tests, the stdio relay test, web mode and the desktop journey all use the new names.
- **No aliases.** Nothing was released under the earlier names, so no aliases are kept. An earlier name is now an unknown tool, denied before any policy is consulted. The protocol, server and docs tests check that.
- **History.** Entries recorded before this change keep the tool name they were made with: the journal is append-only.
- **Docs.** `docs/MCP.md` lists the mapping, and `tests/release-docs.test.mjs` checks that table against the catalog.
- **Prose.** "Artboard" in the server's tool title, its description and its history label becomes "frame", the word the editor uses.
