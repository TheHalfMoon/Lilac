import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const COPYLEFT_OR_UNKNOWN = /AGPL|GPL|LGPL|SSPL|NONE-|Proprietary/u;

test("every entry is well formed and ids are unique", () => {
  assert.equal(register.targetProjectLicense, "Apache-2.0");
  assert.equal(byId.size, register.entries.length, "ids are unique");
  for (const entry of register.entries) {
    assert.ok(Object.hasOwn(register.kinds, entry.kind), `${entry.id} has a known kind`);
    for (const field of ["license", "evidence", "compatible", "obligations"]) assert.equal(typeof entry[field], "string", `${entry.id}.${field}`);
    assert.ok(["yes", "reference-only", "founder-confirmation-required"].includes(entry.compatible), `${entry.id} has a known conclusion`);
    if (entry.revision !== undefined) assert.match(entry.revision, /^[0-9a-f]{7,40}$/u, `${entry.id} revision`);
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

test("every donor named in package provenance or the donor ledger is registered", () => {
  const named = new Set();
  for (const name of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", name, "src");
    if (!existsSync(src)) continue;
    for (const file of readdirSync(src).filter((entry) => /\.(ts|mjs)$/u.test(entry))) {
      for (const [, repo] of readFileSync(join(src, file), "utf8").matchAll(/(?:repository|donor|guidanceDonor): "([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/gu)) named.add(repo);
    }
  }
  for (const [, repo] of read("docs/DONORS.md").matchAll(/^\| `([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)` \|/gmu)) named.add(repo);
  assert.ok(named.size >= 20, `found ${named.size} donor names`);
  for (const repo of named) assert.ok(byId.has(repo), `${repo} is registered`);
});

test("copyleft, unlicensed and proprietary material is never treated as compatible code", () => {
  for (const entry of register.entries.filter((item) => COPYLEFT_OR_UNKNOWN.test(item.license))) {
    assert.ok(["reference-only", "proprietary-authorized"].includes(entry.kind), `${entry.id} (${entry.license}) is reference-only or proprietary`);
    assert.notEqual(entry.compatible, "yes", `${entry.id} is not declared compatible`);
  }
  // The provenance records of reference-only donors must say no code was imported.
  for (const [repo, file] of [["kgoedecke/doop", "packages/collaboration/src/provenance.ts"], ["firecrawl/firecrawl", "packages/import-stack/src/provenance.ts"]]) {
    const source = read(file);
    const at = source.indexOf(`repository: "${repo}"`);
    assert.ok(at >= 0, `${repo} is in ${file}`);
    assert.match(source.slice(at, at + 600), /importedCode: false/u, `${repo} records importedCode: false`);
  }
  // No Paper source has ever been imported into the repository.
  assert.equal(existsSync(join(ROOT, "imports")), false);
});

test("the Apache-2.0 declaration stays blocked until every entry is resolved", () => {
  const pending = register.entries.filter((entry) => entry.compatible === "founder-confirmation-required").map((entry) => entry.id);
  const pkg = JSON.parse(read("package.json"));
  if (pending.length > 0) {
    assert.equal(pkg.license, undefined, `no project license may be declared while ${pending.join(", ")} await confirmation`);
    assert.equal(existsSync(join(ROOT, "LICENSE")), false);
  } else {
    assert.equal(pkg.license, register.targetProjectLicense);
  }
});

test("vendored third-party files match the register and are named in the notices", () => {
  const notices = read("THIRD_PARTY_NOTICES.md");
  for (const entry of register.entries) {
    for (const [path, digest] of Object.entries(entry.vendored ?? {})) {
      assert.equal(createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex"), digest, path);
    }
    if (entry.notices === "THIRD_PARTY_NOTICES.md") assert.ok(notices.includes(`\`${entry.id}`), `${entry.id} is named in THIRD_PARTY_NOTICES.md`);
  }
  // Every vendored skill directory is covered by a registered license file.
  for (const name of readdirSync(join(ROOT, ".claude", "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
    const covered = name === "jev" ? ".claude/skills/jev/LICENSE.txt" : name.startsWith("ps-") ? ".claude/skills/PSTACK-LICENSE" : null;
    assert.ok(covered && register.entries.some((entry) => Object.hasOwn(entry.vendored ?? {}, covered)), `.claude/skills/${name} has a registered license`);
  }
});
