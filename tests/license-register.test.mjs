import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { externalPackages } from "../scripts/sbom.mjs";

// PC-L (#146): docs/provenance/LICENSE_REGISTER.json is the audited record of every
// dependency, donor, optional runtime component, and vendored tool. This suite keeps it
// complete against the repository and keeps its compatibility conclusions consistent.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const register = JSON.parse(read("docs/provenance/LICENSE_REGISTER.json"));
const byId = new Map(register.entries.map((entry) => [entry.id, entry]));
// Licenses under which material may be used as compatible code: the dependency allowlist plus
// CC0 (public-domain dedication) and OFL (fonts). Anything else must stay reference-only.
const policy = JSON.parse(read("scripts/license-policy.json"));
const PERMISSIVE = new Set([...policy.allowed, "CC0-1.0", "OFL-1.1"]);
// Optional runtime components are never distributed with Ninerr. They may be compatible under
// a permissive license or when explicitly marked NOT-DISTRIBUTED, and under nothing else.
const NOT_DISTRIBUTED = new Set(["optional-runtime"]);
const distributedOrPermissive = (entry) => PERMISSIVE.has(entry.license) || (NOT_DISTRIBUTED.has(entry.kind) && entry.license.startsWith("NOT-DISTRIBUTED"));
// GitHub projects tracked files may link to that are registered under another id, or are
// not incorporated at all (the upstream of an upstream; an optional local dev tool).
const URL_ALIASES = { "inikulin/parse5": "parse5", "fb55/entities": "entities", "microsoft/playwright": "playwright-core" };
const URL_NOT_INCORPORATED = new Set(["ehmo/platform-design-skills", "trailhq/Graft", "owner/repo", "TheHalfMoon/Lilac"]); // owner/repo: the placeholder in docs; TheHalfMoon/Lilac: this repository (its clone URL in docs/RELEASE.md)
// owner/name literals that are not upstream projects: rule ids, MIME types, Ninerr paths, and
// MCP JSON-RPC method names (tools/list).
const NOT_DONORS = /^(a11y|ninerr-mobile-method|application|text|packages|internal|NinerrImportStack|tools|notifications|resources|prompts|completion|logging|sampling|roots)\//u;
const PATH_LIKE = /\.(ts|mts|mjs|js|cjs|json|md|ya?ml|tsx|jsx|css|html?|txt|svg|png|go|py|rs|toml|lock|sh)$/iu;

test("every entry is well formed and ids are unique", () => {
  assert.equal(register.targetProjectLicense, "Apache-2.0");
  assert.equal(byId.size, register.entries.length, "ids are unique");
  for (const entry of register.entries) {
    assert.ok(Object.hasOwn(register.kinds, entry.kind), `${entry.id} has a known kind`);
    for (const field of ["license", "evidence", "compatible", "obligations"]) assert.equal(typeof entry[field], "string", `${entry.id}.${field}`);
    assert.ok(["yes", "reference-only", "founder-confirmation-required"].includes(entry.compatible), `${entry.id} has a known conclusion`);
    if (entry.revision !== undefined) assert.match(entry.revision, /^[0-9a-f]{7,40}$/u, `${entry.id} revision`);
    assert.ok(Object.hasOwn(register.categories, entry.category), `${entry.id} is category A or B`);
  }
});

// Category A is exactly the founder-authorized donor and source projects; everything else is B.
test("category A is exactly the founder-authorized projects, and every other entry is B", () => {
  const authorization = read("docs/provenance/FOUNDER_AUTHORIZATION_2026-10-08.md");
  const expansion = read("docs/provenance/AUTHORIZED_DONOR_EXPANSION_2026-10-03.md");
  const paper = new Set(["paper.design", "paper-design/paper"]);
  // An entry for a runtime Ninerr ships or invokes stays under its own license, even when its
  // upstream project is authorized (the impeccable package, the Docling CLI).
  const RUNTIME_KINDS = new Set(["dependency", "bundled-runtime", "optional-runtime"]);
  // classifier.dev is recorded as a project; its registered upstream is mrmps/classifier-dev.
  const attested = [...expansion.matchAll(/^- `([^`]+)`$/gmu)].map((match) => match[1]);
  const registered = (project) => (project === "classifier.dev" ? "mrmps/classifier-dev" : project);
  assert.ok(expansion.includes("- `classifier.dev`") || expansion.includes("- classifier.dev"), "classifier.dev is attested");
  for (const project of [...attested, "classifier.dev"]) assert.ok(byId.has(registered(project)), `${project} has a register entry`);
  const authorized = new Set([...paper, ...attested.map(registered), "mrmps/classifier-dev"]);
  for (const entry of register.entries) {
    const own = authorized.has(entry.id) && !RUNTIME_KINDS.has(entry.kind);
    assert.equal(entry.category, own ? "A" : "B", `${entry.id} is ${own ? "an authorized project's own source" : "an independent third party"}`);
    if (own && !paper.has(entry.id)) assert.ok(authorization.includes(entry.id) || entry.id === "mrmps/classifier-dev", `${entry.id} is named in the founder record's scope`);
  }
});

test("every lockfile package is registered as a dependency with its lockfile license", () => {
  const lock = JSON.parse(read("package-lock.json"));
  const policy = JSON.parse(read("scripts/license-policy.json"));
  for (const pkg of externalPackages(lock)) {
    const entry = byId.get(pkg.name);
    assert.ok(entry, `${pkg.name} is registered`);
    assert.equal(entry.kind, "dependency", pkg.name);
    assert.equal(entry.version, pkg.version, `${pkg.name} version`);
    const override = policy.overrides.find((item) => item.name === pkg.name && item.version === pkg.version);
    assert.equal(entry.license, override?.license ?? pkg.license, `${pkg.name} license`);
  }
});

test("every upstream project named anywhere in package sources or the donor ledgers is registered", () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(join(ROOT, "packages"));
  files.push(join(ROOT, "docs", "DONORS.md"), join(ROOT, "docs", "DONOR_INTEGRATION_MAP.md"));
  const named = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Any quoted or backticked owner/name literal, under any key, in any file shape.
    for (const [, name] of text.matchAll(/[`"']([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)[`"']/gu)) {
      if (!NOT_DONORS.test(name) && !PATH_LIKE.test(name)) named.add(name);
    }
  }
  // Ledger table rows name projects even when they look like file names (opentype.js).
  for (const [, name] of read("docs/DONORS.md").matchAll(/^\| `([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)` \|/gmu)) named.add(name);
  assert.ok(named.size >= 22, `found ${named.size} upstream names`);
  for (const name of named) assert.ok(byId.has(name), `${name} is registered`);
});

test("every GitHub project linked from any tracked file is registered", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const linked = new Set();
  for (const path of tracked) {
    const full = join(ROOT, path);
    if (!existsSync(full)) continue;
    for (const [, name] of readFileSync(full, "utf8").matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gu)) linked.add(name.replace(/\.git$/u, "").replace(/[.,)]+$/u, ""));
  }
  assert.ok(linked.size >= 8, `found ${linked.size} linked projects`);
  for (const name of linked) {
    if (URL_NOT_INCORPORATED.has(name)) continue;
    assert.ok(byId.has(URL_ALIASES[name] ?? name), `${name} is linked from the repository and must be registered`);
  }
});

test("only permissively licensed material is ever treated as compatible code", () => {
  for (const entry of register.entries) {
    if (entry.compatible !== "yes") continue;
    if (entry.kind === "proprietary-authorized") {
      assert.equal(entry.category, "A", `${entry.id} is compatible only as a founder-authorized source`);
      assert.match(entry.resolution ?? "", /FOUNDER_AUTHORIZATION_2026-10-08\.md/u, `${entry.id} cites the founder authorization`);
      assert.match(entry.obligations, /No Paper material is distributed/u, `${entry.id} distributes nothing`);
      continue;
    }
    assert.ok(distributedOrPermissive(entry), `${entry.id} is compatible only under a permissive license (has ${entry.license})`);
  }
  for (const entry of register.entries.filter((item) => !distributedOrPermissive(item))) {
    assert.ok(["reference-only", "proprietary-authorized"].includes(entry.kind), `${entry.id} (${entry.license}) is reference-only or proprietary`);
    if (entry.kind !== "proprietary-authorized") assert.notEqual(entry.compatible, "yes", `${entry.id} is not declared compatible`);
  }
  // The provenance records of reference-only donors must say no code was imported.
  for (const [repo, file] of [["kgoedecke/doop", "packages/collaboration/src/provenance.ts"], ["firecrawl/firecrawl", "packages/import-stack/src/provenance.ts"]]) {
    const source = read(file);
    const at = source.indexOf(`repository: "${repo}"`);
    assert.ok(at >= 0, `${repo} is in ${file}`);
    assert.match(source.slice(at, at + 600), /importedCode: false/u, `${repo} records importedCode: false`);
  }
  // No Paper source is in the working tree (the full-history check is in the audit evidence).
  assert.equal(existsSync(join(ROOT, "imports")), false);
});

test("Ninerr is declared Apache-2.0 only once every entry is resolved, and then everywhere", () => {
  const pending = register.entries.filter((entry) => entry.compatible === "founder-confirmation-required").map((entry) => entry.id);
  assert.deepEqual(pending, [], "no entry awaits founder confirmation");
  // The canonical text published by the ASF (https://www.apache.org/licenses/LICENSE-2.0.txt).
  assert.equal(createHash("sha256").update(readFileSync(join(ROOT, "LICENSE"))).digest("hex"), "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
  const lock = JSON.parse(read("package-lock.json"));
  for (const dir of ["", ...readdirSync(join(ROOT, "packages")).map((name) => `packages/${name}`)]) {
    const pkg = JSON.parse(read(join(dir, "package.json")));
    assert.equal(pkg.license, register.targetProjectLicense, `${pkg.name} declares the project license`);
    assert.equal(lock.packages[dir].license, register.targetProjectLicense, `the lockfile records ${pkg.name}'s license`);
  }
});

test("vendored third-party files match the register and are named in the notices", () => {
  const notices = read("THIRD_PARTY_NOTICES.md");
  for (const entry of register.entries) {
    for (const [path, digest] of Object.entries(entry.vendored ?? {})) {
      assert.equal(createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex"), digest, path);
    }
    assert.ok(notices.includes(`\`${entry.id}`), `${entry.id} is named in THIRD_PARTY_NOTICES.md`);
  }
  // Every vendored skill directory is covered by a registered license file.
  for (const name of readdirSync(join(ROOT, ".claude", "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    const covered = name === "jev" ? ".claude/skills/jev/LICENSE.txt" : name.startsWith("ps-") ? ".claude/skills/PSTACK-LICENSE" : null;
    assert.ok(covered && register.entries.some((entry) => Object.hasOwn(entry.vendored ?? {}, covered)), `.claude/skills/${name} has a registered license`);
  }
});
