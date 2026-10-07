import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSbom, checkPolicy, purlFor } from "../scripts/sbom.mjs";

// P06 gate 9 (#130): a deterministic CycloneDX SBOM from package-lock.json, with a license
// allowlist and a THIRD_PARTY_NOTICES.md check that fail the gate.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "sbom.mjs");
const lockText = readFileSync(join(ROOT, "package-lock.json"), "utf8");
const policy = JSON.parse(readFileSync(join(ROOT, "scripts", "license-policy.json"), "utf8"));
const notices = readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");

test("the repository's lockfile passes the license and notices policy", () => {
  assert.deepEqual(checkPolicy(lockText, policy, notices), []);
  const run = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("the SBOM is deterministic and independent of lockfile key order", () => {
  const first = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" }), first, "byte-identical across runs");
  // Reordering the lockfile's package entries changes its bytes (and so the serial number)
  // but not the components or the graph.
  const lock = JSON.parse(lockText);
  const reversed = JSON.stringify({ ...lock, packages: Object.fromEntries(Object.entries(lock.packages).reverse()) }, null, 2);
  const a = buildSbom(lockText, policy);
  const b = buildSbom(reversed, policy);
  assert.deepEqual(b.components, a.components);
  assert.deepEqual(b.dependencies, a.dependencies);
  assert.doesNotMatch(first, /"timestamp"/u, "no wall-clock time");
});

test("the SBOM has the CycloneDX 1.5 shape, correct purls, hashes, scopes and graph", () => {
  const sbom = buildSbom(lockText, policy);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const refs = new Set(sbom.components.map((component) => component["bom-ref"]));
  assert.equal(refs.size, sbom.components.length, "bom-refs are unique");
  for (const dependency of sbom.dependencies) {
    for (const ref of [dependency.ref, ...dependency.dependsOn]) assert.ok(refs.has(ref) || ref === sbom.metadata.component["bom-ref"], ref);
  }
  const lock = JSON.parse(lockText);
  const externals = Object.entries(lock.packages).filter(([path, entry]) => path.startsWith("node_modules/") && !entry.link);
  for (const [path, entry] of externals) {
    const name = path.slice("node_modules/".length);
    const component = sbom.components.find((item) => item.name === name);
    assert.ok(component, name);
    assert.equal(component.purl, purlFor(name, entry.version));
    assert.equal(component.scope, entry.optional ? "optional" : "required");
    assert.equal(component.hashes[0].content, Buffer.from(entry.integrity.slice("sha512-".length), "base64").toString("hex"));
    assert.ok(component.licenses?.[0]?.license?.id, `${name} has a resolved SPDX license`);
  }
  assert.equal(purlFor("@impeccable/cli-linux-x64", "0.1.5"), "pkg:npm/%40impeccable/cli-linux-x64@0.1.5");
  assert.equal(purlFor("parse5", "8.0.1"), "pkg:npm/parse5@8.0.1");
  const parse5 = sbom.dependencies.find((item) => item.ref === "pkg:npm/parse5@8.0.1");
  assert.deepEqual(parse5.dependsOn, ["pkg:npm/entities@8.0.0"]);
  // Lilac's own license is not asserted until the project chooses one.
  assert.deepEqual(sbom.metadata.component.properties, [{ name: "lilac:license", value: "NOASSERTION" }]);
});

// Synthetic lockfiles for each failure mode.
const lockWith = (packages) => JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" }, ...packages } });
const SHA512 = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const pkg = (license, extra = {}) => ({ version: "1.0.0", resolved: "https://registry.example/x.tgz", integrity: SHA512, ...(license === undefined ? {} : { license }), ...extra });
const NOTICE = "`ok@1.0.0` `gpl@1.0.0` `none@1.0.0` `seelic@1.0.0` `unlicensed@1.0.0` `odd@1.0.0`";

test("each policy violation is reported", () => {
  const problems = (packages, notes = NOTICE, overrides = []) => checkPolicy(lockWith(packages), { ...policy, overrides }, notes, { nodeModules: join(ROOT, "no-such-dir") });
  assert.deepEqual(problems({ "node_modules/ok": pkg("MIT") }), []);
  assert.match(problems({ "node_modules/gpl": pkg("GPL-3.0-only") }).join("\n"), /GPL-3.0-only is not on the allowlist/u);
  assert.match(problems({ "node_modules/unlicensed": pkg("UNLICENSED") }).join("\n"), /UNLICENSED is not on the allowlist/u);
  assert.match(problems({ "node_modules/none": pkg(undefined) }).join("\n"), /missing or not an SPDX id/u);
  assert.match(problems({ "node_modules/seelic": pkg("SEE LICENSE IN LICENSE") }).join("\n"), /no override covers it/u);
  assert.match(problems({ "node_modules/odd": pkg("MIT OR (Apache-2.0") }).join("\n"), /missing or not an SPDX id/u);
  const stale = [{ name: "seelic", version: "0.9.0", declared: "SEE LICENSE IN LICENSE", license: "MIT", licenseFile: "LICENSE", licenseSha256: "0".repeat(64) }];
  assert.match(problems({ "node_modules/seelic": pkg("SEE LICENSE IN LICENSE") }, NOTICE, stale).join("\n"), /an override exists for version 0\.9\.0/u);
  const toGpl = [{ name: "seelic", version: "1.0.0", declared: "SEE LICENSE IN LICENSE", license: "GPL-3.0-only", licenseFile: "LICENSE", licenseSha256: "0".repeat(64) }];
  assert.match(problems({ "node_modules/seelic": pkg("SEE LICENSE IN LICENSE") }, NOTICE, toGpl).join("\n"), /resolves to disallowed GPL-3.0-only/u);
  assert.match(problems({ "node_modules/ok": pkg("MIT") }, "nothing here").join("\n"), /ok@1\.0\.0: not named in THIRD_PARTY_NOTICES\.md/u);
});

test("an override is checked against the installed license file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilac-sbom-"));
  try {
    mkdirSync(join(dir, "seelic"));
    writeFileSync(join(dir, "seelic", "package.json"), JSON.stringify({ name: "seelic", version: "1.0.0" }));
    writeFileSync(join(dir, "seelic", "LICENSE"), "MIT License text");
    const override = (sha) => [{ name: "seelic", version: "1.0.0", declared: "SEE LICENSE IN LICENSE", license: "MIT", licenseFile: "LICENSE", licenseSha256: sha }];
    const run = (sha, declared = "SEE LICENSE IN LICENSE") => checkPolicy(lockWith({ "node_modules/seelic": pkg(declared) }), { ...policy, overrides: override(sha) }, NOTICE, { nodeModules: dir });
    const good = execFileSync("sha256sum", [join(dir, "seelic", "LICENSE")], { encoding: "utf8" }).split(" ")[0];
    assert.deepEqual(run(good), []);
    assert.match(run("f".repeat(64)).join("\n"), /does not match the override's sha256/u);
    assert.match(run(good, "SEE LICENSE IN COPYING").join("\n"), /override expects declared license/u);
    rmSync(join(dir, "seelic", "LICENSE"));
    assert.match(run(good).join("\n"), /not installed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the --check command exits non-zero on a violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilac-sbom-cli-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "sbom.mjs"), readFileSync(SCRIPT));
    writeFileSync(join(dir, "scripts", "license-policy.json"), JSON.stringify(policy));
    writeFileSync(join(dir, "package-lock.json"), lockWith({ "node_modules/gpl": pkg("GPL-3.0-only") }));
    writeFileSync(join(dir, "THIRD_PARTY_NOTICES.md"), NOTICE);
    const run = spawnSync(process.execPath, [join(dir, "scripts", "sbom.mjs"), "--check"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /sbom: gpl@1\.0\.0: license GPL-3\.0-only is not on the allowlist/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockfile shapes beyond today's are handled, and unsafe shapes fail closed", () => {
  // Nested installs resolve by npm's nearest-node_modules rule, and duplicates merge.
  const nested = lockWith({
    "node_modules/a": pkg("MIT", { dependencies: { b: "^1" } }),
    "node_modules/a/node_modules/b": pkg("MIT"),
    "node_modules/b": pkg("MIT", { version: "2.0.0" }),
    "node_modules/c": pkg("MIT", { dependencies: { b: "^2" } }),
    "node_modules/c/node_modules/d": pkg("MIT"),
    "node_modules/e/node_modules/d": pkg("MIT"),
    "node_modules/e": pkg("MIT", { dev: true, dependencies: { d: "^1" } }),
  });
  const sbom = buildSbom(nested, policy);
  const edges = Object.fromEntries(sbom.dependencies.map((entry) => [entry.ref, entry.dependsOn]));
  assert.deepEqual(edges["pkg:npm/a@1.0.0"], ["pkg:npm/b@1.0.0"], "the nested b, not the hoisted one");
  assert.deepEqual(edges["pkg:npm/c@1.0.0"], ["pkg:npm/b@2.0.0"]);
  const refs = sbom.components.map((component) => component["bom-ref"]);
  assert.equal(new Set(refs).size, refs.length, "d@1.0.0 at two paths is one component");
  assert.equal(sbom.components.find((component) => component.name === "e").scope, "excluded", "dev packages are excluded from the runtime");
  // Several hashes in one integrity string.
  const multi = buildSbom(lockWith({ "node_modules/ok": pkg("MIT", { integrity: `sha1-xyz ${SHA512}` }) }), policy);
  assert.equal(multi.components.find((component) => component.name === "ok").hashes[0].content, "07".repeat(64));
  assert.match(checkPolicy(lockWith({ "node_modules/ok": pkg("MIT", { integrity: "sha512-AAAA" }) }), policy, NOTICE, { nodeModules: join(ROOT, "no-such-dir") }).join("\n"), /no sha512 integrity/u, "a truncated digest is not a hash");
  // A license id that is not allowlisted is a name in the SBOM, never a claimed SPDX id.
  const odd = buildSbom(lockWith({ "node_modules/gpl": pkg("mit") }), policy);
  assert.deepEqual(odd.components.find((component) => component.name === "gpl").licenses, [{ license: { name: "mit" } }]);
  const check = (text, overrides = []) => checkPolicy(text, { ...policy, overrides }, NOTICE + " `a@1.0.0` `b@1.0.0` `c@1.0.0` `d@1.0.0` `e@1.0.0`", { nodeModules: join(ROOT, "no-such-dir") });
  assert.match(check(JSON.stringify({ lockfileVersion: 1, dependencies: {} })).join("\n"), /lockfileVersion 2 or later/u);
  assert.match(check(JSON.stringify({ lockfileVersion: 3 })).join("\n"), /lockfileVersion 2 or later/u);
  assert.match(check(lockWith({ "node_modules/ok": pkg("MIT", { integrity: undefined }) })).join("\n"), /no sha512 integrity/u);
  const seelic = { name: "seelic", version: "1.0.0", declared: "SEE LICENSE IN LICENSE", license: "MIT", licenseFile: "LICENSE", licenseSha256: "0".repeat(64) };
  assert.match(check(lockWith({ "node_modules/seelic": pkg("SEE LICENSE IN LICENSE") }), [seelic]).join("\n"), /none of the 1 license overrides could be verified/u);
  assert.match(check(lockWith({ "node_modules/seelic": pkg("SEE LICENSE IN LICENSE") }), [{ ...seelic, licenseFile: "../../etc/passwd" }]).join("\n"), /outside the package/u);
  assert.deepEqual(check(nested), []);
  // A copy that ships makes the component ship, whichever path sorts first.
  const mixed = buildSbom(lockWith({
    "node_modules/a": pkg("MIT", { dependencies: { q: "^2" } }),
    "node_modules/a/node_modules/q": pkg("MIT", { version: "2.0.0", dev: true }),
    "node_modules/b": pkg("MIT", { dependencies: { q: "^2" } }),
    "node_modules/b/node_modules/q": pkg("MIT", { version: "2.0.0" }),
  }), policy);
  assert.equal(mixed.components.find((component) => component.name === "q").scope, "required");
  // Workspace devDependencies are edges; bundled dependencies need no integrity of their own.
  const workspace = JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {
    "": { name: "fixture", version: "1.0.0", workspaces: ["packages/w"] },
    "packages/w": { name: "w", version: "1.0.0", devDependencies: { ok: "^1" } },
    "node_modules/w": { resolved: "packages/w", link: true },
    "node_modules/ok": pkg("MIT", { dependencies: { inner: "^1" } }),
    "node_modules/ok/node_modules/inner": { version: "1.0.0", license: "MIT", inBundle: true },
  } });
  const workspaceEdges = Object.fromEntries(buildSbom(workspace, policy).dependencies.map((entry) => [entry.ref, entry.dependsOn]));
  assert.deepEqual(workspaceEdges["workspace:w"], ["pkg:npm/ok@1.0.0"]);
  assert.deepEqual(checkPolicy(workspace, policy, "`ok@1.0.0` `inner@1.0.0`", { nodeModules: join(ROOT, "no-such-dir") }), []);
  // inBundle does not excuse a missing hash at the top level, or under an unhashed parent.
  const claims = (packages) => checkPolicy(lockWith(packages), policy, "`x@1.0.0` `p@1.0.0`", { nodeModules: join(ROOT, "no-such-dir") }).join("\n");
  assert.match(claims({ "node_modules/x": { version: "1.0.0", license: "MIT", inBundle: true, resolved: "https://evil.test/x.tgz" } }), /marked inBundle, but no enclosing package is hashed/u);
  assert.match(claims({ "node_modules/p": pkg("MIT", { integrity: undefined }), "node_modules/p/node_modules/x": { version: "1.0.0", license: "MIT", inBundle: true } }), /x@1\.0\.0 at node_modules\/p\/node_modules\/x: no sha512/u);
  // A hashed copy gives the component its hash, and it is bundled only if every copy is.
  const copies = buildSbom(lockWith({
    "node_modules/a": pkg("MIT"),
    "node_modules/a/node_modules/x": { version: "1.0.0", license: "MIT", inBundle: true },
    "node_modules/x": pkg("MIT"),
  }), policy).components.find((component) => component.name === "x");
  assert.equal(copies.hashes.length, 1);
  assert.equal((copies.properties ?? []).some((property) => property.name === "npm:inBundle"), false);
});
