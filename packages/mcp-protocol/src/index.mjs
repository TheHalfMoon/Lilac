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
const TOOL_NAME_SET = new Set(PAPER_MCP_TOOL_NAMES);
export class MCPContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "MCPContractError";
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MCPContractError(`${label} must be a plain object`);
  }
}

function assertNonEmptyString(value, label) {
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
export function validateMCPClientInfo(client, { requireTransport = false } = {}) {
  assertPlainObject(client, "client");
  assertNonEmptyString(client.name, "client.name");
  if (client.version !== undefined) assertNonEmptyString(client.version, "client.version");
  if (client.title !== undefined) assertNonEmptyString(client.title, "client.title");
  if (requireTransport && !MCP_TRANSPORTS.includes(client.transport)) {
    throw new MCPContractError(`Unsupported MCP transport ${String(client.transport)}`);
  }
  if (!requireTransport && client.transport !== undefined && !MCP_TRANSPORTS.includes(client.transport)) {
    throw new MCPContractError(`Unsupported MCP transport ${String(client.transport)}`);
  }
  return true;
}
export function validateMCPToolDefinition(tool) {
  assertPlainObject(tool, "tool");
  assertNonEmptyString(tool.name, "tool.name");
  assertPlainObject(tool.inputSchema, `tool ${tool.name}.inputSchema`);
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw new MCPContractError(`tool ${tool.name}.description must be a string`);
  }
  if (tool.annotations !== undefined) {
    assertPlainObject(tool.annotations, `tool ${tool.name}.annotations`);
  }
  return true;
}
export function validateMCPServerConfig(config) {
  assertPlainObject(config, "config");
  if (!Array.isArray(config.tools)) {
    throw new MCPContractError("config.tools must be an array");
  }
  const seen = new Set();
  for (const tool of config.tools) {
    validateMCPToolDefinition(tool);
    if (seen.has(tool.name)) {
      throw new MCPContractError(`Duplicate MCP tool ${tool.name}`);
    }
    seen.add(tool.name);
  }
  if (config.instructions !== undefined && typeof config.instructions !== "string") {
    throw new MCPContractError("config.instructions must be a string");
  }
  return true;
}

export function diffPaperMCPTools(toolNames) {
  if (!Array.isArray(toolNames)) {
    throw new MCPContractError("toolNames must be an array");
  }
  const actual = new Set(toolNames);
  return {
    missing: PAPER_MCP_TOOL_NAMES.filter((name) => !actual.has(name)),
    extra: [...actual].filter((name) => !TOOL_NAME_SET.has(name)).sort(),
  };
}
export function assertPaperMCPCompatibility(config) {
  validateMCPServerConfig(config);
  const drift = diffPaperMCPTools(config.tools.map((tool) => tool.name));
  if (drift.missing.length || drift.extra.length) {
    throw new MCPContractError("Paper MCP tool surface drift detected");
  }
  return true;
}

export function validateMCPToolResult(result) {
  assertPlainObject(result, "result");
  if (!Array.isArray(result.content)) {
    throw new MCPContractError("result.content must be an array");
  }
  for (const [index, entry] of result.content.entries()) {
    assertPlainObject(entry, `result.content[${index}]`);
    assertNonEmptyString(entry.type, `result.content[${index}].type`);
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new MCPContractError("result.isError must be boolean when present");
  }
  return true;
}
