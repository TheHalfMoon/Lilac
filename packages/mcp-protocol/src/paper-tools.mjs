// Paper's MCP tool surface and its classification, shared by the contract validators
// (index.mjs) and tool-call authorization (authorization.mjs).
export const PAPER_MCP_OBSERVED_AT = "2026-10-03";
export const PAPER_MCP_PUBLIC_VERSION = 1790902329241;
export const MCP_TRANSPORTS = Object.freeze(["stdio", "http"]);

export const PAPER_MCP_TOOL_NAMES = Object.freeze([
  "open_file",
  "list_resources",
  "create_file",
  "rename_resource",
  "create_page",
  "rename_pages",
  "get_basic_info",
  "get_selection",
  "get_node_info",
  "get_children",
  "get_screenshot",
  "get_jsx",
  "get_tree_summary",
  "get_computed_styles",
  "get_fill_image",
  "find_nodes",
  "list_comment_threads",
  "get_comment_thread",
  "list_comment_thread_authors",
  "set_comment_thread_status",
  "get_font_family_info",
  "get_guide",
  "export",
  "export_combined_pdf",
  "write_html",
  "create_artboard",
  "delete_nodes",
  "set_text_content",
  "rename_nodes",
  "update_styles",
  "duplicate_nodes",
  "move_nodes",
  "finish_working_on_nodes",
  "get_tokens",
  "create_tokens",
  "set_tokens",
]);
const READ_ONLY_TOOLS = new Set([
  "open_file",
  "list_resources",
  "get_basic_info",
  "get_selection",
  "get_node_info",
  "get_children",
  "get_screenshot",
  "get_jsx",
  "get_tree_summary",
  "get_computed_styles",
  "get_fill_image",
  "find_nodes",
  "list_comment_threads",
  "get_comment_thread",
  "list_comment_thread_authors",
  "get_font_family_info",
  "get_guide",
  "export",
  "export_combined_pdf",
  "finish_working_on_nodes",
  "get_tokens",
]);

const CONSEQUENTIAL_TOOLS = new Set(["delete_nodes"]);
export const TOOL_NAME_SET = new Set(PAPER_MCP_TOOL_NAMES);
export class MCPContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "MCPContractError";
  }
}

export function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MCPContractError(`${label} must be a plain object`);
  }
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MCPContractError(`${label} must be a non-empty string`);
  }
}

export function classifyPaperTool(name) {
  assertNonEmptyString(name, "tool name");
  if (!TOOL_NAME_SET.has(name)) return "unknown";
  if (CONSEQUENTIAL_TOOLS.has(name)) return "consequential";
  return READ_ONLY_TOOLS.has(name) ? "read" : "write";
}
