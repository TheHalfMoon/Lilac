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
  // The notices carry only what Ninerr owes (N0-G7a3), so every name in them is an obligation.
  assert.equal(rule("THIRD_PARTY_NOTICES.md", "unreal-agent", "## Unreal Agent"), "third-party-notices");
  assert.equal(rule("THIRD_PARTY_NOTICES.md", "impeccable", "## Impeccable"), "third-party-notices");
  assert.equal(rule("packages/design-assurance/src/rules.mjs", "impeccable", "impeccable"), "default-donor", "the Impeccable exemption is file-specific");
  assert.equal(rule("package-lock.json", "impeccable", "\"node_modules/impeccable\""), "independent-runtime-impeccable");
  assert.equal(rule("package-lock.json", "lilac", "\"@lilac/canvas\""), "default-lilac");
  assert.equal(rule("packages/persistence/src/legacy.ts", "lilac", "export const LEGACY_PROJECT_FORMAT = \"lilac-project\";"), "legacy-identity-readers");
  assert.equal(rule("packages/persistence/src/types.ts", "lilac", "export const PROJECT_FORMAT = \"lilac-project\";"), "default-lilac", "legacy identity outside the legacy module is gated");
  // The old variables are read only in the legacy modules; the desktop guide names them.
  assert.equal(rule("packages/studio-host/src/legacy.ts", "lilac", "export const LEGACY_MCP_TOKEN_ENV = \"LILAC_MCP_TOKEN\";"), "legacy-identity-readers");
  assert.equal(rule("docs/DESKTOP.md", "lilac", "or an existing \"Lilac Projects\" folder, read through `LILAC_PROJECTS`"), "public-env");
  assert.equal(rule("packages/agent-runtime/src/operation.ts", "unreal-agent", "  repository: \"unreallabsai/unreal-agent\","), "provenance-agent-runtime-unreal-agent");
});

// N0-G9: each rule that admits the old identity or a donor name is narrow. The construct it was
// written for passes; anything else in the same file stays gated.
test("the allowlist is narrow: a new occurrence beside an allowed one is still gated", () => {
  const rule = (path, term, line) => classify(policy, path, term, line).id;
  const gated = (path, term, line) => policy.gated.has(classify(policy, path, term, line).category);
  // The four code constructs that recognize the old identity.
  assert.equal(rule("packages/desktop/src/resolve.mjs", "lilac", "const IN_SCOPE = /^@(?:ninerr|lilac)\\//iu;"), "legacy-refusals-in-code");
  assert.equal(rule("packages/renderer/src/index.mjs", "lilac", "  if (name.startsWith(\"on\") || name.startsWith(\"data-lilac\")) return null;"), "legacy-refusals-in-code");
  assert.equal(rule("packages/studio-web/src/app.mjs", "lilac", "entry.tool && !/^(?:ninerr|lilac):/u.test(entry.tool)"), "legacy-refusals-in-code");
  assert.ok(gated("packages/studio-web/src/app.mjs", "lilac", "showDialog(\"Welcome to Lilac\")"), "new product copy in the same file is gated");
  assert.ok(gated("packages/renderer/src/index.mjs", "lilac", "// the Lilac renderer"), "a comment naming the old product is gated");
  // Legacy tests admit only the legacy constructs.
  assert.equal(rule("tests/desktop-package.test.mjs", "lilac", "  for (const specifier of [\"@lilac/history\"]) {"), "legacy-identity-tests");
  assert.ok(gated("tests/desktop-package.test.mjs", "lilac", "test(\"Lilac packages the app\", () => {"), "a test title naming the old product is gated");
  assert.ok(gated("tests/canvas-browser.test.mjs", "lilac", "test(\"the Lilac canvas\")"), "other tests are gated");
  // Provenance constants admit only their files' donors.
  assert.ok(gated("packages/agent-events/src/index.ts", "firecrawl", "firecrawl"), "another donor in a provenance module is gated");
  assert.ok(gated("packages/canvas/src/index.mjs", "ui-tars", "UI-TARS"), "a donor name outside provenance is gated");
  // The repository is TheHalfMoon/Ninerr (N0-G10): the old URL is no longer admitted anywhere current.
  assert.ok(gated("docs/RELEASE.md", "lilac", "gh attestation verify x --repo TheHalfMoon/Lilac"), "the old repository URL");
  assert.ok(gated("docs/RELEASE.md", "lilac", "A Lilac release is a tagged commit"), "product prose in the same doc is gated");
  // Paper outside a record is gated.
  assert.ok(gated("docs/ARCHITECTURE.md", "paper", "Paper"), "Paper in a current doc is gated");
  // Every mention of the old name on an allowed line must itself be allowed (N0-G9 review).
  assert.ok(gated("packages/studio-web/src/app.mjs", "lilac", "/^(?:ninerr|lilac):/u.test(t); showDialog(\"Welcome to Lilac\");"), "copy on the same line as an allowed construct");
  assert.ok(gated("docs/RELEASE.md", "lilac", "Lilac is the product; clone TheHalfMoon/Lilac"), "prose on the same line as the repository URL");
  assert.ok(gated("tests/desktop-package.test.mjs", "lilac", "test(\"Lilac packages @lilac/history\")"), "a title on the same line as an allowed scope");
  // The old variables are admitted only in the desktop guide's note, and only as their names.
  assert.ok(gated("packages/studio-host/src/index.ts", "lilac", "process.env.LILAC_PROJECTS ?? join(home, \"Lilac Projects\")"), "reading an old variable outside the legacy module");
  assert.ok(gated("tests/web-mode.test.mjs", "lilac", "const LILAC_PROJECTS = \"Lilac\";"), "an old variable in a test fixture");
  assert.ok(gated("docs/DESKTOP.md", "lilac", "Welcome to Lilac, the design tool."), "new prose in the desktop guide");
  assert.ok(gated("docs/MIGRATION.md", "lilac", "Lilac is still supported."), "new prose in the migration guide");
  // The notices, the register and the provenance records name Ninerr as Ninerr.
  assert.ok(gated("THIRD_PARTY_NOTICES.md", "lilac", "Lilac is distributed under Apache-2.0."), "the old name in the notices");
  assert.ok(gated("docs/provenance/LICENSE_REGISTER.json", "lilac", "\"never shipped by Lilac\""), "the old name in the register");
  assert.ok(gated("docs/DONORS.md", "lilac", "Lilac ships with its own product name"), "the old name in the living ledger");
  assert.ok(gated("packages/canvas/src/provenance.mjs", "lilac", "export const NAME = \"Lilac\";"), "the old name in a provenance module");
  assert.equal(rule("docs/provenance/PAPER_AUTHORIZATION.md", "lilac", "for the Lilac project."), "provenance-history", "the owner's dated attestation keeps the name it was given under");
  // A new ledger file is not admitted by a pattern.
  assert.ok(gated("docs/DONOR_NEW_PLAN.md", "paper", "Ninerr will embed Paper."), "a new donor document");
  // The living program pages are not exempt; the record before the rename is dated evidence.
  assert.ok(gated("docs/CURRENT.md", "lilac", "- Lilac is the current product name."), "the old name in the program state");
  assert.ok(gated("docs/MASTER_PLAN.md", "paper", "N0 next: depend on Paper's renderer."), "Paper in the plan");
  assert.equal(rule("docs/evidence/PROGRAM_STATE_2026-10-09.md", "lilac", "Product name: **Lilac**."), "dated-evidence");
  // Former repository-url probes (N0-G9 review, cycles 2 and 3) stay gated after the rule's removal.
  assert.ok(gated("docs/RELEASE.md", "lilac", "gh repo clone TheHalfMoon/Lilac && cd Lilac"), "the old clone command");
  assert.ok(gated("packages/studio-web/src/app.mjs", "lilac", "<h1>Welcome to TheHalfMoon/Lilac</h1>"), "the URL form in product code");
  assert.ok(gated("README.md", "lilac", "TheHalfMoon/Lilac Studio is great"), "the URL in a file that does not cite it");
  assert.ok(gated("docs/RELEASE.md", "lilac", "see TheHalfMoon/Lilac-studio"), "a longer name built on the URL");
  // Edge cases of the removed rule (N0-G9 review, cycle 3) stay gated; the migration and variable forms are still admitted with both ends guarded.
  assert.ok(gated("docs/RELEASE.md", "lilac", "see TheHalfMoon/Lilac.studio"), "a dotted name built on the URL");
  assert.ok(gated("docs/RELEASE.md", "lilac", "abcd Lilac"), "the clone directory inside another word");
  assert.ok(gated("docs/DESKTOP.md", "lilac", "MY_LILAC_PROJECTS"), "an old variable inside a longer name");
  assert.ok(gated("docs/MIGRATION.md", "lilac", "lilac-project-studio"), "a migration term inside a longer name");
  assert.ok(gated("docs/MIGRATION.md", "lilac", ".lilac-studio"), "the project directory inside a longer name");
  // The legacy modules and fixture recognize the old product name only.
  assert.ok(gated("packages/persistence/src/legacy.ts", "paper", "export const BRAND = 'Lilac'; // Paper"), "Paper in a legacy module");
  assert.ok(gated("tests/fixtures/projects/v1-basic/.lilac/project.json", "paper", "{\"name\":\"Paper\"}"), "Paper in the legacy fixture");
  // The provenance records are listed by path; a new file is not admitted.
  assert.ok(gated("docs/provenance/NEW_RECORD.md", "paper", "Ninerr is Paper."), "a new provenance file");
  assert.ok(gated("packages/canvas/src/provenance.ts", "paper", "brand = 'Paper'"), "a new provenance module");
  // Short legacy forms do not match inside another word.
  assert.ok(gated("docs/MIGRATION.md", "lilac", "the.lilac product"), "a legacy form inside another word");
  // Provenance tests admit only their own records' names.
  assert.ok(gated("tests/collaboration.test.mjs", "lilac", "test(\"Lilac collaboration works\")"), "the old name in a provenance test");
  assert.ok(gated("tests/agent-events.test.mjs", "paper", "Paper"), "another source in a provenance test");
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

// N0-G9: the repository itself passes the independence gate. A new old-product, Paper or donor
// name outside the reviewed rules fails here and in CI's identity gate step.
test("the repository passes the identity gate", () => {
  const record = census(policy);
  const gated = record.files.flatMap((file) => file.findings.filter((finding) => policy.gated.has(finding.category)).map((finding) => `${file.path} ${finding.term} (${finding.rule})`));
  assert.deepEqual(gated, []);
  assert.equal(record.gatedFindings, 0);
});
