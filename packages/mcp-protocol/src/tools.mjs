// Ninerr's MCP tool surface and its classification, shared by the contract validators
// (index.mjs), tool-call authorization (authorization.mjs) and the studio host's server.
export const MCP_TRANSPORTS = Object.freeze(["stdio", "http"]);

// Every tool the server offers, with the class it is authorized by: `read` needs the `read`
// capability, `write` needs `document-write`, and `consequential` needs `document-write`
// plus the person's confirmation of that exact call. A name not listed here is unknown and
// is denied without consulting a policy.
const CLASSES = Object.freeze({
  project_info: "read",
  layer_tree: "read",
  layer_details: "read",
  layer_children: "read",
  find_layers: "read",
  selection: "read",
  layer_code: "read",
  guide: "read",
  finish_task: "read",
  create_frame: "write",
  set_text: "write",
  rename_layers: "write",
  set_styles: "write",
  move_layers: "write",
  duplicate_layers: "write",
  delete_layers: "consequential",
});

export const MCP_TOOL_NAMES = Object.freeze(Object.keys(CLASSES));
export const TOOL_NAME_SET = new Set(MCP_TOOL_NAMES);

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

/** The class a tool is authorized by: read, write, consequential, or unknown. */
export function classifyTool(name) {
  assertNonEmptyString(name, "tool name");
  return Object.hasOwn(CLASSES, name) ? CLASSES[name] : "unknown";
}
