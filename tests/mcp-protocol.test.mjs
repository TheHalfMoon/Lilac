import test from "node:test";
import assert from "node:assert/strict";

import {
  MCPContractError,
  MCP_TOOL_NAMES,
  assertMCPToolSurface,
  classifyTool,
  diffMCPTools,
  validateMCPClientInfo,
  validateMCPServerConfig,
  validateMCPToolResult,
} from "../packages/mcp-protocol/src/index.mjs";

function makeConfig(names = MCP_TOOL_NAMES) {
  return {
    instructions: "Catalog fixture",
    tools: names.map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} },
    })),
  };
}

test("the catalog is Ninerr's 16-tool surface, frozen and without duplicates", () => {
  assert.equal(MCP_TOOL_NAMES.length, 16);
  assert.equal(new Set(MCP_TOOL_NAMES).size, 16);
  assert.ok(Object.isFrozen(MCP_TOOL_NAMES));
  for (const name of MCP_TOOL_NAMES) assert.match(name, /^[a-z]+(?:_[a-z]+)*$/u, name);
});

test("each tool is classified by what it does to the document", () => {
  assert.equal(classifyTool("layer_tree"), "read");
  assert.equal(classifyTool("finish_task"), "read");
  assert.equal(classifyTool("set_styles"), "write");
  assert.equal(classifyTool("delete_layers"), "consequential");
  // A name outside the catalog is unknown, including a name the catalog's own object inherits.
  for (const name of ["future_tool", "get_tree_summary", "toString", "constructor", "__proto__"]) assert.equal(classifyTool(name), "unknown", name);
  assert.throws(() => classifyTool(""), MCPContractError);
  const classes = MCP_TOOL_NAMES.map(classifyTool);
  assert.equal(classes.filter((value) => value === "read").length, 9);
  assert.equal(classes.filter((value) => value === "write").length, 6);
  assert.equal(classes.filter((value) => value === "consequential").length, 1);
});

test("a server offering exactly the catalog passes the surface check", () => {
  const config = makeConfig();
  assert.equal(validateMCPServerConfig(config), true);
  assert.equal(assertMCPToolSurface(config), true);
  assert.deepEqual(diffMCPTools(MCP_TOOL_NAMES), { missing: [], extra: [] });
});

test("the surface check reports missing and extra tools deterministically", () => {
  const changed = MCP_TOOL_NAMES.filter((name) => name !== "selection");
  changed.push("zeta_tool", "alpha_tool");
  assert.deepEqual(diffMCPTools(changed), {
    missing: ["selection"],
    extra: ["alpha_tool", "zeta_tool"],
  });
  assert.throws(() => assertMCPToolSurface(makeConfig(changed)), /missing \[selection\], extra \[alpha_tool, zeta_tool\]/u);
  assert.throws(() => diffMCPTools("selection"), MCPContractError);
});

test("client validation requires a supported transport when requested", () => {
  assert.equal(validateMCPClientInfo({ name: "Ninerr", transport: "stdio" }, { requireTransport: true }), true);
  assert.throws(
    () => validateMCPClientInfo({ name: "Ninerr", transport: "socket" }, { requireTransport: true }),
    MCPContractError,
  );
});

test("tool results require typed content entries", () => {
  assert.equal(validateMCPToolResult({ content: [{ type: "text", text: "ok" }] }), true);
  assert.throws(() => validateMCPToolResult({ content: [{}] }), MCPContractError);
  assert.throws(() => validateMCPToolResult({ content: [], isError: "yes" }), MCPContractError);
});

test("duplicate tool definitions are rejected", () => {
  const config = makeConfig(["layer_tree", "layer_tree"]);
  assert.throws(() => validateMCPServerConfig(config), /Duplicate MCP tool layer_tree/);
  assert.throws(() => assertMCPToolSurface(config), /Duplicate MCP tool layer_tree/);
});
