import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";
import { census, classify, loadPolicy, serialize, summarize } from "../scripts/identity-census.mjs";

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
  const policyWith = (rules) => JSON.stringify({ terms: { a: "a" }, categories: { X: "" }, gated: [], rules });
  const last = { id: "last", category: "X", reason: "r" };
  assert.doesNotThrow(() => loadPolicy(policyWith([{ id: "p", category: "X", path: "^a", reason: "r" }, last])));
  assert.throws(() => loadPolicy(policyWith([{ id: "r", category: "Y", reason: "r" }])), /unknown category/u);
  assert.throws(() => loadPolicy(policyWith([{ id: "r", category: "X", path: "^a", reason: "r" }])), /last rule/u);
  assert.throws(() => loadPolicy(policyWith([{ id: "early", category: "X", reason: "r" }, last])), /last rule/u, "an unconstrained rule cannot shadow later rules");
  assert.throws(() => loadPolicy(policyWith([{ id: "typo", category: "X", paths: "^a", reason: "r" }, last])), /unknown key paths/u, "a mistyped key is not a silent catch-all");
  assert.throws(() => loadPolicy(policyWith([{ id: "p", category: "X", path: "^a" }, last])), /reason is required/u);
  assert.throws(() => loadPolicy(policyWith([{ id: "p", category: "X", terms: ["b"], reason: "r" }, last])), /unknown term b/u);
});

test("rules classify by path, term and line", () => {
  const rule = (path, term, line) => classify(policy, path, term, line).id;
  assert.equal(rule("packages/canvas/src/index.mjs", "lilac", "// Lilac canvas"), "default-lilac");
  assert.equal(rule("tests/fixtures/projects/v1-basic/.lilac/project.json", "lilac", null), "legacy-project-fixture");
  assert.equal(rule("docs/evidence/GRAIN1_CLOSEOUT_2026-10-03.md", "lilac", "Lilac"), "dated-evidence");
  assert.equal(rule("docs/evidence/PAPER_DEEP_RECOVERY_2026-10-01.md", "paper", "Paper"), "paper-recovery-evidence");
  assert.equal(rule("docs/evidence/UNDATED_NOTES.md", "lilac", "Lilac"), "default-lilac", "only date-suffixed evidence is historical");
  assert.equal(rule("THIRD_PARTY_NOTICES.md", "paper", "## Paper.design"), "default-paper", "Paper attribution in the notices stays gated");
  assert.equal(rule("THIRD_PARTY_NOTICES.md", "unreal-agent", "## Unreal Agent"), "default-donor", "donor attribution in the notices stays gated");
  assert.equal(rule("THIRD_PARTY_NOTICES.md", "impeccable", "## Impeccable"), "third-party-notices");
  assert.equal(rule("packages/design-assurance/src/rules.mjs", "impeccable", "impeccable"), "default-donor", "the Impeccable exemption is file-specific");
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
    const summary = summarize(first);
    assert.equal(summary.censusSha256, createHash("sha256").update(serialize(first)).digest("hex"), "the summary pins the full census");
    assert.equal(Object.values(summary.byRule).reduce((a, b) => a + b, 0), Object.values(first.byCategory).reduce((a, b) => a + b, 0), "every finding is counted under its rule");
    assert.deepEqual(summary.byCategory, first.byCategory);
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
    // Moving one finding to another line keeps every count but changes the digest.
    writeFileSync(join(dirty.root, "packages/x/src/index.ts"), "\n// Lilac\nconst a = 'paper';\n");
    const moved = summarize(census(policy, dirty.root, dirty.paths));
    const { censusSha256: before, ...counts } = summarize(record);
    const { censusSha256: after, ...movedCounts } = moved;
    assert.deepEqual(movedCounts, counts);
    assert.notEqual(after, before, "the digest pins line-level detail the counts do not");
  } finally {
    dirty.dispose();
  }
});

test("the command line gate exits 1 on gated findings and 0 without, and never scans its own files", () => {
  const script = fileURLToPath(new URL("../scripts/identity-census.mjs", import.meta.url));
  const repo = tree({ "README.md": "# Ninerr\n", "scripts/identity-policy.json": "lilac paper\n" });
  try {
    const git = (...args) => execFileSync("git", args, { cwd: repo.root, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    const gate = () => spawnSync(process.execPath, [script, "--check", "--root", repo.root], { encoding: "utf8" });
    let result = gate();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no gated findings in 1 files/u);
    writeFileSync(join(repo.root, "app.mjs"), "// Lilac\n");
    git("add", "-A");
    result = gate();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^app\.mjs:1: lilac \(ACTIVE_PRODUCT_IDENTITY, rule default-lilac, 1x\)$/mu);
    assert.match(result.stderr, /identity gate: 1 gated findings/u);

    const verify = () => spawnSync(process.execPath, [script, "--verify", "--root", repo.root], { encoding: "utf8" });
    assert.equal(verify().status, 1, "no committed summary is out of date");
    assert.equal(spawnSync(process.execPath, [script, "--write", "--root", repo.root], { encoding: "utf8" }).status, 0);
    result = verify();
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(repo.root, "app.mjs"), "// Lilac\n// Lilac\n");
    git("add", "-A");
    result = verify();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is out of date; run node scripts\/identity-census\.mjs --write/u);
    result = spawnSync(process.execPath, [script, "--verify", "--check", "--root", repo.root], { encoding: "utf8" });
    assert.equal(result.status, 2, "combined modes are refused rather than running only one");
    assert.match(result.stderr, /give one of --verify, --check per run/u);
  } finally {
    repo.dispose();
  }
});
