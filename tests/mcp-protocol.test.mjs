import test from "node:test";
import assert from "node:assert/strict";

import {
  MCPContractError,
  PAPER_MCP_PUBLIC_VERSION,
  PAPER_MCP_TOOL_NAMES,
  assertPaperMCPCompatibility,
  classifyPaperTool,
  diffPaperMCPTools,
  validateMCPClientInfo,
  validateMCPServerConfig,
  validateMCPToolResult,
} from "../packages/mcp-protocol/src/index.mjs";

function makeConfig(names = PAPER_MCP_TOOL_NAMES) {
  return {
    instructions: "Compatibility fixture",
    tools: names.map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} },
    })),
  };
}

test("Paper MCP snapshot is the observed 36-tool surface", () => {
  assert.equal(PAPER_MCP_PUBLIC_VERSION, 1790902329241);
  assert.equal(PAPER_MCP_TOOL_NAMES.length, 36);
  assert.equal(new Set(PAPER_MCP_TOOL_NAMES).size, 36);
  assert.ok(PAPER_MCP_TOOL_NAMES.includes("list_resources"));
  assert.ok(PAPER_MCP_TOOL_NAMES.includes("rename_resource"));
});
test("tool classification follows the observed public annotations", () => {
  assert.equal(classifyPaperTool("get_tree_summary"), "read");
  assert.equal(classifyPaperTool("list_resources"), "read");
  assert.equal(classifyPaperTool("rename_resource"), "write");
  assert.equal(classifyPaperTool("delete_nodes"), "consequential");
  assert.equal(classifyPaperTool("future_tool"), "unknown");
});

test("exact Paper MCP snapshot validates without drift", () => {
  const config = makeConfig();
  assert.equal(validateMCPServerConfig(config), true);
  assert.equal(assertPaperMCPCompatibility(config), true);
  assert.deepEqual(diffPaperMCPTools(PAPER_MCP_TOOL_NAMES), { missing: [], extra: [] });
});

test("drift detector reports missing and extra tools deterministically", () => {
  const changed = PAPER_MCP_TOOL_NAMES.filter((name) => name !== "list_resources");
  changed.push("future_tool");
  assert.deepEqual(diffPaperMCPTools(changed), {
    missing: ["list_resources"],
    extra: ["future_tool"],
  });
  assert.throws(() => assertPaperMCPCompatibility(makeConfig(changed)), MCPContractError);
});
test("client validation requires a supported transport when requested", () => {
  assert.equal(validateMCPClientInfo({ name: "Lilac", transport: "stdio" }, { requireTransport: true }), true);
  assert.throws(
    () => validateMCPClientInfo({ name: "Lilac", transport: "socket" }, { requireTransport: true }),
    MCPContractError,
  );
});

test("tool results require typed content entries", () => {
  assert.equal(validateMCPToolResult({ content: [{ type: "text", text: "ok" }] }), true);
  assert.throws(() => validateMCPToolResult({ content: [{}] }), MCPContractError);
  assert.throws(() => validateMCPToolResult({ content: [], isError: "yes" }), MCPContractError);
});

test("duplicate tool definitions are rejected", () => {
  const config = makeConfig(["get_tokens", "get_tokens"]);
  assert.throws(() => validateMCPServerConfig(config), /Duplicate MCP tool get_tokens/);
});


test("every observed Paper tool has an explicit classification", () => {
  const classes = PAPER_MCP_TOOL_NAMES.map(classifyPaperTool);
  assert.equal(classes.filter((value) => value === "unknown").length, 0);
  assert.equal(classes.filter((value) => value === "read").length, 21);
  assert.equal(classes.filter((value) => value === "write").length, 14);
  assert.equal(classes.filter((value) => value === "consequential").length, 1);
});
