import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOCUMENT_SCHEMA_VERSION, createDocument } from "../packages/document-model/src/index.mjs";
import { MCP_CONFIRMATION_WINDOW_MS, MCP_TRANSPORTS, PAPER_MCP_OBSERVED_AT, PAPER_MCP_TOOL_NAMES, classifyPaperTool } from "../packages/mcp-protocol/src/index.mjs";
import { PROJECT_FILES, PROJECT_MIGRATIONS, PROJECT_SCHEMA_VERSION, createProject, openProject } from "../packages/persistence/src/index.ts";

// P07a (#140): the release documents must describe the code as it is. Every cited path
// exists, and every number or example they state is checked against the implementation.

const ROOT = new URL("../", import.meta.url).pathname;
const DOCS = ["SECURITY.md", "docs/MCP.md", "docs/MIGRATION.md"];
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
  for (const name of PAPER_MCP_TOOL_NAMES) classes[classifyPaperTool(name)].push(name);
  assert.match(doc, new RegExp(`${PAPER_MCP_TOOL_NAMES.length}-tool public surface observed on ${PAPER_MCP_OBSERVED_AT}`));
  assert.match(doc, new RegExp(`the ${classes.read.length} read-only tools`));
  assert.deepEqual(classes.consequential, ["delete_nodes"]);
  assert.match(doc, /\| consequential \| `delete_nodes` \|/);
  assert.equal(classifyPaperTool("not_a_tool"), "unknown");
  assert.deepEqual([...MCP_TRANSPORTS], ["stdio", "http"]);
  assert.match(doc, /`stdio` and `http`/);
  assert.equal(MCP_CONFIRMATION_WINDOW_MS, 5 * 60 * 1000);
  assert.match(doc, /`MCP_CONFIRMATION_WINDOW_MS` \(5 minutes\)/);
  // Every tool named in the doc is a real tool, and the class it is listed under is its class.
  let listed = 0;
  for (const [, cls, cell] of doc.matchAll(/^\| (read|write|consequential) \| ([^|]+) \|/gm)) {
    for (const [, name] of cell.matchAll(/`([a-z_]+)`/g)) {
      assert.equal(classifyPaperTool(name), cls, `${name} is listed as ${cls}`);
      listed += 1;
    }
  }
  assert.ok(listed >= 10, `the class table names ${listed} tools`);
  for (const name of ["open_file", "create_file", "list_resources", "rename_resource"]) assert.ok(doc.includes(`\`${name}\``));
  assert.match(doc, /\*\*Not implemented\*\* \| #82/);
});

test("the migration documentation matches the version constants and layout", () => {
  const doc = read("docs/MIGRATION.md");
  assert.match(doc, new RegExp(`\`PROJECT_SCHEMA_VERSION\` = ${PROJECT_SCHEMA_VERSION}\\b`));
  assert.match(doc, new RegExp(`\`DOCUMENT_SCHEMA_VERSION\` = ${DOCUMENT_SCHEMA_VERSION}\\b`));
  assert.deepEqual(Object.keys(PROJECT_MIGRATIONS), [], "the doc states the built-in registry is empty");
  assert.match(doc, /`PROJECT_MIGRATIONS` is empty/);
  for (const name of [PROJECT_FILES.manifest, PROJECT_FILES.snapshot, PROJECT_FILES.journal, PROJECT_FILES.lock, PROJECT_FILES.objects]) {
    assert.ok(doc.includes(`\`${name}`), `the layout table names ${name}`);
  }
  assert.ok(doc.includes(`\`<root>/${PROJECT_FILES.directory}\``));
});

test("the migration example runs as written", () => {
  const doc = read("docs/MIGRATION.md");
  const example = /```js\n([\s\S]*?)```/.exec(doc)[1];
  const step = /migrations: (\{ 0: .*\}),\n/.exec(example)[1];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-migration-doc-")));
  try {
    createProject(root, { projectId: "doc-example", document: createDocument({ id: "doc-1" }), createdAt: "2026-10-07T12:00:00.000Z" });
    const manifestPath = join(root, PROJECT_FILES.directory, PROJECT_FILES.manifest);
    const current = JSON.parse(readFileSync(manifestPath, "utf8"));
    const { documentId, ...legacy } = current;
    writeFileSync(manifestPath, JSON.stringify({ ...legacy, schemaVersion: 0, legacyRoot: documentId }));
    const migrations = new Function(`return (${step});`)();
    const store = openProject(root, { owner: "my-app", at: new Date().toISOString(), migrations });
    assert.equal(store.recovery.migratedFrom, 0, "the example's stated result");
    store.close();
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), current);
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
