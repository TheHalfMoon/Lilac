import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { census, classify, loadPolicy, serialize } from "../scripts/identity-census.mjs";

// N0.1/N0.9 (#190): the identity census classifies every finding by the reviewed policy, and
// the gate fails on gated categories only.

const policy = loadPolicy();

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "identity-census-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, paths: Object.keys(files).sort(), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("the policy is well formed: known categories and terms, unique ids, a catch-all last rule", () => {
  assert.ok(policy.rules.length > 0);
  assert.ok(policy.gated.has("ACTIVE_PRODUCT_IDENTITY"));
  assert.ok(!policy.gated.has("LEGACY_COMPATIBILITY"));
  assert.ok(!policy.gated.has("THIRD_PARTY_INDEPENDENT_OBLIGATION"));
  assert.ok(!policy.gated.has("IMMUTABLE_HISTORICAL_FACT"));
  assert.throws(() => loadPolicy(JSON.stringify({ terms: { a: "a" }, categories: { X: "" }, gated: [], rules: [{ id: "r", category: "Y" }] })), /unknown category/u);
  assert.throws(() => loadPolicy(JSON.stringify({ terms: { a: "a" }, categories: { X: "" }, gated: [], rules: [{ id: "r", category: "X", path: "^a" }] })), /last rule/u);
});

test("rules classify by path, term and line", () => {
  const rule = (path, term, line) => classify(policy, path, term, line).id;
  assert.equal(rule("packages/canvas/src/index.mjs", "lilac", "// Lilac canvas"), "default-lilac");
  assert.equal(rule("tests/fixtures/projects/v1-basic/.lilac/project.json", "lilac", null), "legacy-project-fixture");
  assert.equal(rule("docs/evidence/GRAIN1_CLOSEOUT_2026-10-03.md", "lilac", "Lilac"), "dated-evidence");
  assert.equal(rule("docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md", "paper", "Paper"), "paper-recovery-evidence");
  assert.equal(rule("package-lock.json", "impeccable", "\"node_modules/impeccable\""), "independent-runtime-impeccable");
  assert.equal(rule("package-lock.json", "lilac", "\"@lilac/canvas\""), "default-lilac");
  assert.equal(rule("packages/persistence/src/types.ts", "lilac", "export const PROJECT_FORMAT = \"lilac-project\";"), "persisted-project-format");
  assert.equal(rule("packages/persistence/src/types.ts", "lilac", "// a Lilac comment"), "default-lilac");
  assert.equal(rule("scripts/lilac-mcp.mjs", "lilac", "const token = process.env.LILAC_MCP_TOKEN;"), "public-env");
  assert.equal(rule("packages/agent-runtime/src/operation.ts", "unreal-agent", "unreal-agent"), "default-donor");
});

test("the census is deterministic and the gate counts gated categories only", () => {
  const clean = tree({
    "docs/evidence/OLD_2026-01-01.md": "Lilac shipped this.\n",
    "tests/fixtures/projects/v1-basic/.lilac/project.json": "{\"format\":\"lilac-project\"}\n",
    "package-lock.json": "\"node_modules/impeccable\"\n",
    "README.md": "# Ninerr\n",
    "image.bin": Buffer.from([0, 1, 2, 0x6c, 0x69, 0x6c, 0x61, 0x63]),
  });
  try {
    const first = census(policy, clean.root, clean.paths);
    assert.equal(serialize(first), serialize(census(policy, clean.root, clean.paths)));
    assert.equal(first.gatedFindings, 0);
    assert.equal(first.byCategory.IMMUTABLE_HISTORICAL_FACT, 1);
    assert.equal(first.byCategory.LEGACY_COMPATIBILITY, 2, "one path and one line finding in the legacy fixture");
    assert.equal(first.byCategory.THIRD_PARTY_INDEPENDENT_OBLIGATION, 1);
    assert.ok(!first.files.some((file) => file.path === "image.bin"), "binary content is not scanned as text");
  } finally {
    clean.dispose();
  }
  const dirty = tree({ "packages/x/src/index.ts": "// Lilac\nconst a = 'paper';\n", "packages/x/src/lilac.ts": "" });
  try {
    const record = census(policy, dirty.root, dirty.paths);
    assert.equal(record.gatedFindings, 3);
    const lines = record.files.find((file) => file.path === "packages/x/src/index.ts").findings.map((finding) => [finding.term, finding.lines]);
    assert.deepEqual(lines, [["lilac", [1]], ["paper", [2]]]);
    assert.equal(record.files.find((file) => file.path === "packages/x/src/lilac.ts").findings[0].lines.length, 0, "a path finding has no line");
  } finally {
    dirty.dispose();
  }
});
