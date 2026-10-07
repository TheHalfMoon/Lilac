import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLED_DIRECTORIES, BUNDLED_DOCUMENTS, buildReleaseBundle, childEnv, verifyReleaseBundle } from "../scripts/release-bundle.mjs";
import { externalPackages, purlFor } from "../scripts/sbom.mjs";

// P07 SBOM and attribution bundle (#139): deterministic, complete, and self-verifying.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

function tree(root) {
  const out = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return out;
}

function withBundles(count, callback) {
  const roots = Array.from({ length: count }, () => realpathSync(mkdtempSync(join(tmpdir(), "lilac-bundle-"))));
  try {
    return callback(roots.map((root) => join(root, "bundle")));
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

test("two builds of the same commit are byte-identical and verify", () => withBundles(2, ([first, second]) => {
  const manifest = buildReleaseBundle(first, { sourceCommit: COMMIT });
  buildReleaseBundle(second, { sourceCommit: COMMIT });
  assert.deepEqual(tree(second), tree(first));
  assert.deepEqual(verifyReleaseBundle(first), []);
  assert.equal(manifest.sourceCommit, COMMIT);
  assert.equal(manifest.projectLicense, "NOASSERTION", "no project license is declared, and none is guessed");
  for (const path of [...BUNDLED_DOCUMENTS, "sbom.cdx.json", "licenses/index.json", "smoke-report.json"]) assert.ok(Object.hasOwn(manifest.files, path), path);
  assert.equal(readFileSync(join(first, "smoke-report.json"), "utf8"), readFileSync(new URL("./fixtures/smoke/expected-report.json", import.meta.url), "utf8"));
}));

test("every external package has its license texts in the bundle", () => withBundles(1, ([out]) => {
  buildReleaseBundle(out, { sourceCommit: COMMIT });
  const index = JSON.parse(readFileSync(join(out, "licenses", "index.json"), "utf8"));
  const expected = [...new Set(externalPackages(lock).map((pkg) => purlFor(pkg.name, pkg.version)))];
  assert.deepEqual(index.map((entry) => entry.purl), expected);
  const sbom = JSON.parse(readFileSync(join(out, "sbom.cdx.json"), "utf8"));
  assert.deepEqual(new Set(sbom.components.map((component) => component.purl).filter(Boolean)), new Set(expected));
  for (const entry of index) {
    assert.ok(entry.files.length > 0, `${entry.purl} has license text`);
    assert.match(entry.license, /^[A-Za-z0-9.-]+$/u, `${entry.purl} resolves to an SPDX id`);
    for (const file of entry.files) assert.ok(readdirSync(join(out, "licenses")).includes(`${file.sha256}.txt`), `${entry.purl} ${file.name}`);
  }
}));

test("tampering, bad inputs, and a non-empty output are refused", () => withBundles(1, ([out]) => {
  assert.throws(() => buildReleaseBundle(out, { sourceCommit: "HEAD" }), /40-character/);
  buildReleaseBundle(out, { sourceCommit: COMMIT });
  assert.throws(() => buildReleaseBundle(out, { sourceCommit: COMMIT }), /not an empty directory/);
  assert.throws(() => buildReleaseBundle("--source-commit", { sourceCommit: COMMIT }), /output directory/);
  writeFileSync(join(out, "SECURITY.md"), "changed");
  writeFileSync(join(out, "extra.txt"), "x");
  assert.deepEqual(verifyReleaseBundle(out).sort(), ["SECURITY.md does not match its sha256", "extra.txt is not in the manifest"]);
}));

test("the bundle does not depend on which platform binary npm installed", () => withBundles(2, ([native, swapped]) => {
  buildReleaseBundle(native, { sourceCommit: COMMIT });
  // A private copy of every external package, each copied from its real location, so no
  // link in it can lead back to a shared install; the copy is checked before it is changed.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lilac-bundle-modules-")));
  try {
    const modules = join(scratch, "node_modules");
    const source = fileURLToPath(new URL("../node_modules", import.meta.url));
    for (const pkg of externalPackages(lock)) {
      const from = join(source, relative("node_modules", pkg.path));
      if (existsSync(from)) cpSync(realpathSync(from), join(modules, relative("node_modules", pkg.path)), { recursive: true });
    }
    const links = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) links.push(join(directory, entry.name));
        else if (entry.isDirectory()) walk(join(directory, entry.name));
      }
    };
    walk(modules);
    assert.deepEqual(links, [], "the private copy holds no symbolic links");
    const binaries = join(modules, "@impeccable");
    const [installed] = readdirSync(binaries).filter((name) => name.startsWith("cli-"));
    const other = installed === "cli-darwin-arm64" ? "cli-linux-x64" : "cli-darwin-arm64";
    renameSync(join(binaries, installed), join(binaries, other));
    const manifest = JSON.parse(readFileSync(join(binaries, other, "package.json"), "utf8"));
    writeFileSync(join(binaries, other, "package.json"), JSON.stringify({ ...manifest, name: `@impeccable/${other}` }));
    // A platform binary that shipped an extra notice must not change the bundle either.
    writeFileSync(join(binaries, other, "NOTICE"), "platform-specific notice\n");
    buildReleaseBundle(swapped, { sourceCommit: COMMIT, nodeModules: modules });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(tree(swapped), tree(native));
}));

test("every provenance record is bundled, and the smoke subprocess gets a minimal environment", () => withBundles(1, ([out]) => {
  const manifest = buildReleaseBundle(out, { sourceCommit: COMMIT });
  for (const directory of BUNDLED_DIRECTORIES) {
    for (const name of readdirSync(new URL(`../${directory}`, import.meta.url))) assert.ok(Object.hasOwn(manifest.files, `${directory}/${name}`), `${directory}/${name}`);
  }
  assert.deepEqual(childEnv({ PATH: "/bin", NODE_OPTIONS: "--require evil", TMPDIR: "/t", HOME: "/h" }), { PATH: "/bin", TMPDIR: "/t" });
}));
