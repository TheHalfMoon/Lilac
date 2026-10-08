import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENT_SCHEMA_VERSION, createDocument } from "../packages/document-model/src/index.mjs";
import { MCP_CONFIRMATION_WINDOW_MS, MCP_TOOL_NAMES, MCP_TRANSPORTS, authorizeMCPToolCall, classifyTool, mcpArgumentsSha256 } from "../packages/mcp-protocol/src/index.mjs";
import { CONFIRMATION_WAIT_MS } from "../packages/studio-host/src/mcp.ts";
import { createAccessPolicy } from "../packages/collaboration/src/index.ts";
import { PROJECT_FILES, PROJECT_MIGRATIONS, PROJECT_SCHEMA_VERSION, createProject, migrateLegacyProject, openProject, projectLayout } from "../packages/persistence/src/index.ts";

// P07a (#140): the release documents must describe the code as it is. Every cited path
// exists, and every number or example they state is checked against the implementation.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DOCS = ["SECURITY.md", "docs/DESKTOP.md", "docs/MCP.md", "docs/MIGRATION.md", "docs/RELEASE.md"];
const read = (path) => readFileSync(join(ROOT, path), "utf8");

function globExists(pattern) {
  if (!pattern.includes("*")) return existsSync(join(ROOT, pattern));
  const slash = pattern.lastIndexOf("/");
  const directory = pattern.slice(0, slash);
  const matcher = new RegExp(`^${pattern.slice(slash + 1).replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
  return existsSync(join(ROOT, directory)) && readdirSync(join(ROOT, directory)).some((name) => matcher.test(name));
}

test("every repository path the release documents cite exists", () => {
  for (const doc of DOCS) {
    const cited = [...read(doc).matchAll(/`((?:packages|tests|docs|scripts)\/[^`\s]*)`/g)].map((match) => match[1]);
    assert.ok(cited.length > 0, `${doc} cites no repository paths`);
    for (const path of cited) assert.ok(globExists(path.replace(/\/$/, "")), `${doc} cites ${path}, which does not exist`);
  }
});

test("the MCP documentation matches the tool surface, classes and confirmation window", () => {
  const doc = read("docs/MCP.md");
  const classes = { read: [], write: [], consequential: [] };
  for (const name of MCP_TOOL_NAMES) classes[classifyTool(name)].push(name);
  assert.match(doc, new RegExp(`the ${MCP_TOOL_NAMES.length} tools the server offers`));
  assert.match(doc, new RegExp(`the ${classes.read.length} read-only tools`));
  assert.equal(CONFIRMATION_WAIT_MS, 50_000);
  assert.match(doc, /up to 50 seconds for an answer \(`CONFIRMATION_WAIT_MS`\)/);
  assert.deepEqual(classes.consequential, ["delete_layers"]);
  assert.match(doc, /\| consequential \| `delete_layers` \|/);
  assert.equal(classifyTool("not_a_tool"), "unknown");
  assert.deepEqual([...MCP_TRANSPORTS], ["stdio", "http"]);
  assert.match(doc, /`stdio` and `http`/);
  assert.equal(MCP_CONFIRMATION_WINDOW_MS, 5 * 60 * 1000);
  assert.match(doc, /`MCP_CONFIRMATION_WINDOW_MS` \(5 minutes\)/);
  // Every tool named in the doc is a real tool, and the class it is listed under is its class.
  // Every tool named in a class row is a real tool of that class, and an authorized call for
  // it reports exactly the capability the row states.
  const AT = "2026-10-07T12:00:00.000Z";
  const user = { actorId: "user-1", kind: "user", accessClass: "member", displayName: "User" };
  const policy = createAccessPolicy("doc-1", [{ principalKind: "actor", principalId: user.actorId, capabilities: ["read", "document-write", "comments"] }]);
  const decide = (toolName) => {
    const args = {};
    const confirmation = classifyTool(toolName) === "consequential"
      ? { confirmation: { documentId: "doc-1", toolName, argumentsSha256: mcpArgumentsSha256(args), actorId: user.actorId, confirmedAt: AT } }
      : {};
    return authorizeMCPToolCall(policy, { actor: user, toolName, arguments: args, at: AT, ...confirmation });
  };
  const listed = [];
  for (const [, label, cell, capabilityCell] of doc.matchAll(/^\| (read|write|consequential) \| ([^|]+) \| ([^|]+) \|$/gm)) {
    const cls = label;
    const capability = /`([a-z-]+)`/.exec(capabilityCell)[1];
    for (const [, name] of cell.matchAll(/`([a-z_]+)`/g)) {
      assert.equal(classifyTool(name), cls, `${name} is listed as ${cls}`);
      const decision = decide(name);
      assert.equal(decision.outcome, "allowed", `${name} with every capability`);
      assert.equal(decision.capability, capability, `${name} needs ${capability}`);
      listed.push(name);
    }
  }
  assert.deepEqual(listed.sort(), [...MCP_TOOL_NAMES].sort(), "the class table names every tool once");
  // The rename table maps each earlier name to a current tool; an earlier name is unknown now.
  const renamed = [...doc.matchAll(/^\| `([a-z_]+)` \| `([a-z_]+)` \|$/gm)];
  assert.equal(renamed.length, MCP_TOOL_NAMES.length);
  assert.deepEqual(renamed.map((row) => row[2]).sort(), [...MCP_TOOL_NAMES].sort());
  for (const [, before] of renamed) assert.equal(decide(before).outcome, "denied", `${before} is no longer a tool`);
  assert.ok(decide("x".repeat(1000)).reason.length <= 100, "an unknown tool's reason is bounded");
  assert.doesNotMatch(doc, /Not implemented/);
});

test("the migration documentation matches the version constants and layout", () => {
  const doc = read("docs/MIGRATION.md");
  assert.match(doc, new RegExp(`\`PROJECT_SCHEMA_VERSION\` = ${PROJECT_SCHEMA_VERSION}\\b`));
  assert.match(doc, new RegExp(`\`DOCUMENT_SCHEMA_VERSION\` = ${DOCUMENT_SCHEMA_VERSION}\\b`));
  assert.deepEqual(Object.keys(PROJECT_MIGRATIONS), ["1"], "the doc states the one built-in step");
  assert.match(doc, /`PROJECT_MIGRATIONS` has one built-in step, from schema 1 to 2/);
  for (const name of [PROJECT_FILES.manifest, PROJECT_FILES.snapshot, PROJECT_FILES.journal, PROJECT_FILES.lock, PROJECT_FILES.objects]) {
    assert.ok(doc.includes(`\`${name}`), `the layout table names ${name}`);
  }
  assert.ok(doc.includes(`\`<root>/${PROJECT_FILES.directory}\``));
  // The "exactly these fields" lists match what createProject writes.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-layout-doc-")));
  try {
    createProject(root, { projectId: "layout", document: createDocument({ id: "doc-1" }), createdAt: "2026-10-07T12:00:00.000Z" });
    for (const [name, label] of [[PROJECT_FILES.manifest, "manifest"], [PROJECT_FILES.snapshot, "snapshot reference"]]) {
      const keys = Object.keys(JSON.parse(readFileSync(join(root, PROJECT_FILES.directory, name), "utf8"))).sort();
      const row = doc.split("\n").find((line) => line.startsWith(`| \`${name}\``));
      const documented = /\{ ([^}]+) \}/.exec(row)[1].split(", ").map((field) => field.split(":")[0].trim()).sort();
      assert.deepEqual(documented, keys, `the ${label} fields`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the migration example runs as written", () => {
  const doc = read("docs/MIGRATION.md");
  const example = /```js\n([\s\S]*?)```/.exec(doc)[1];
  const lines = example.trim().split("\n");
  // The example's calls, run on the legacy corpus as written, give the stated result.
  assert.equal(lines[2], 'if (projectLayout(root) === "legacy") migrateLegacyProject(root, { owner: "my-app", at: new Date().toISOString() });');
  assert.equal(lines[3], 'const store = openProject(root, { owner: "my-app", at: new Date().toISOString() });');
  const stated = /^store\.manifest\.journalGenesis; \/\/ "([a-z-]+)"$/u.exec(lines[4])[1];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-migration-doc-")));
  try {
    cpSync(fileURLToPath(new URL("./fixtures/projects/v1-basic/", import.meta.url)), root, { recursive: true });
    if (projectLayout(root) === "legacy") migrateLegacyProject(root, { owner: "my-app", at: new Date().toISOString() });
    const store = openProject(root, { owner: "my-app", at: new Date().toISOString() });
    assert.equal(store.manifest.journalGenesis, stated, "the example's stated result");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the security policy states the supported version and a private channel", () => {
  const doc = read("SECURITY.md");
  assert.match(doc, /only the current `main` is supported/);
  assert.match(doc, /Report a vulnerability/);
  assert.match(doc, /no technical details/);
});
