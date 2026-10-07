import { MCPContractError, MCP_TRANSPORTS, PAPER_MCP_TOOL_NAMES, TOOL_NAME_SET, assertNonEmptyString, assertPlainObject } from "./paper-tools.mjs";

export { MCPContractError, MCP_TRANSPORTS, PAPER_MCP_OBSERVED_AT, PAPER_MCP_PUBLIC_VERSION, PAPER_MCP_TOOL_NAMES, classifyPaperTool } from "./paper-tools.mjs";
export { MCP_CONFIRMATION_WINDOW_MS, MCPAuthorizationError, authorizeMCPToolCall, mcpArgumentsSha256, requireMCPToolCall } from "./authorization.mjs";

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
