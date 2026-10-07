#!/usr/bin/env node
// Release SBOM and attribution bundle (P07, #139).
//
//   node scripts/release-bundle.mjs <empty output dir> --source-commit <40-hex sha>
//
// Writes a deterministic directory: the CycloneDX SBOM, third-party notices, every
// dependency license text (deduplicated by sha256, with an index from package to text),
// donor provenance records, the release documents, the offline smoke report, and
// MANIFEST.json with the sha256 of every other file. The same commit and lockfile always
// produce the same bytes on any host, so the bundle can be attested and re-verified.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSbom, checkPolicy, externalPackages, purlFor } from "./sbom.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const BUNDLE_SCHEMA = 1;

// Repository files copied into the bundle, at the same relative path.
export const BUNDLED_DOCUMENTS = Object.freeze([
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "docs/MCP.md",
  "docs/MIGRATION.md",
  "docs/RELEASE.md",
  "docs/DONORS.md",
  "scripts/license-policy.json",
  "packages/agent-supervisor/NOTICE.md",
]);
// Every git-tracked file in these directories is bundled too, so a new provenance record is
// never left out and an untracked draft never slips in.
export const BUNDLED_DIRECTORIES = Object.freeze(["docs/provenance"]);

// The smoke subprocess gets only what Node needs to find binaries and a temp directory on
// each platform; NODE_OPTIONS and other ambient settings are dropped.
const CHILD_ENV_KEYS = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR"];
export function childEnv(env = process.env) {
  return Object.fromEntries(CHILD_ENV_KEYS.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]));
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-][A-Za-z0-9-]+)?$/iu;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message) {
  throw new Error(`release-bundle: ${message}`);
}

/**
 * Every external package's license texts. Installed packages contribute the license files
 * they ship. A package covered by a policy override (a platform binary npm installs only on
 * its own platform) is always recorded through the override's license file and sha256, so
 * the index does not depend on which platform built the bundle; that text must be present
 * from an installed package (checkPolicy verifies installed overrides match), or the bundle
 * is refused.
 */
function collectLicenses(lock, policy, nodeModules) {
  const texts = new Map();
  const index = [];
  const seen = new Set();
  for (const pkg of externalPackages(lock)) {
    const purl = purlFor(pkg.name, pkg.version);
    if (seen.has(purl)) continue;
    seen.add(purl);
    const override = policy.overrides.find((entry) => entry.name === pkg.name && entry.version === pkg.version) ?? null;
    const directory = join(nodeModules, relative("node_modules", pkg.path));
    const manifest = join(directory, "package.json");
    const installed = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === pkg.version;
    const files = [];
    // An override package is recorded only through its override, so a platform binary's own
    // files never make the bundle depend on which platform built it.
    if (installed && override === null) {
      for (const name of readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name)).map((entry) => entry.name).sort(compare)) {
        const bytes = readFileSync(join(directory, name));
        const digest = sha256(bytes);
        texts.set(digest, bytes);
        files.push({ name, sha256: digest });
      }
      if (files.length === 0) fail(`${purl} is installed but ships no license file`);
    } else if (override === null) {
      fail(`${purl} is not installed and has no license override`);
    }
    index.push({
      purl,
      license: override?.license ?? pkg.license,
      files: override === null ? files : [{ name: override.licenseFile, sha256: override.licenseSha256 }],
    });
  }
  for (const entry of index) {
    for (const file of entry.files) if (!texts.has(file.sha256)) fail(`${entry.purl}: no installed package ships its license text ${file.sha256}`);
  }
  return { texts, index };
}

function writeFile(out, path, data) {
  const target = join(out, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return files.sort(compare);
}

export function buildReleaseBundle(out, { sourceCommit, root = ROOT, nodeModules = join(root, "node_modules") }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) fail("--source-commit must be a 40-character lowercase hex commit SHA");
  if (typeof out !== "string" || out === "" || out.startsWith("-")) fail("the first argument must be the output directory");
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) fail(`output ${out} exists and is not an empty directory`);
  mkdirSync(out, { recursive: true });

  const lockText = readFileSync(join(root, "package-lock.json"), "utf8");
  const policy = JSON.parse(readFileSync(join(root, "scripts", "license-policy.json"), "utf8"));
  const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const problems = checkPolicy(lockText, policy, notices, { nodeModules });
  if (problems.length > 0) fail(`license policy check failed:\n  ${problems.join("\n  ")}`);

  const sbom = buildSbom(lockText, policy);
  writeFile(out, "sbom.cdx.json", `${JSON.stringify(sbom, null, 2)}\n`);

  const { texts, index } = collectLicenses(JSON.parse(lockText), policy, nodeModules);
  for (const [digest, bytes] of [...texts].sort(([a], [b]) => compare(a, b))) writeFile(out, `licenses/${digest}.txt`, bytes);
  writeFile(out, "licenses/index.json", `${JSON.stringify(index, null, 2)}\n`);

  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...BUNDLED_DIRECTORIES], { cwd: root, encoding: "utf8", env: childEnv() }).split("\0").filter(Boolean);
  if (tracked.length === 0) fail(`no tracked files under ${BUNDLED_DIRECTORIES.join(", ")} (is this a git checkout?)`);
  const directoryFiles = tracked.sort(compare);
  for (const path of [...BUNDLED_DOCUMENTS, ...directoryFiles]) {
    if (!existsSync(join(root, path))) fail(`${path} is missing`);
    writeFile(out, path, readFileSync(join(root, path)));
  }

  const smoke = execFileSync(process.execPath, [join(root, "scripts", "smoke.mjs")], { encoding: "utf8", env: childEnv() });
  writeFile(out, "smoke-report.json", smoke);

  const projectPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = {
    schema: BUNDLE_SCHEMA,
    product: "Lilac",
    sourceCommit,
    lockfileSha256: sha256(lockText),
    // No project license has been declared; recorded as such rather than guessed.
    projectLicense: typeof projectPackage.license === "string" ? projectPackage.license : "NOASSERTION",
    files: Object.fromEntries(listFiles(out).map((path) => [path, sha256(readFileSync(join(out, path)))])),
  };
  writeFile(out, "MANIFEST.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Problems with a bundle directory against its MANIFEST.json; empty when it verifies. */
export function verifyReleaseBundle(out) {
  const manifest = JSON.parse(readFileSync(join(out, "MANIFEST.json"), "utf8"));
  const problems = [];
  const present = listFiles(out).filter((path) => path !== "MANIFEST.json");
  for (const path of present) if (!Object.hasOwn(manifest.files, path)) problems.push(`${path} is not in the manifest`);
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (!present.includes(path)) problems.push(`${path} is missing`);
    else if (sha256(readFileSync(join(out, path))) !== digest) problems.push(`${path} does not match its sha256`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--verify") {
      const problems = verifyReleaseBundle(args[1]);
      for (const problem of problems) process.stderr.write(`release-bundle: ${problem}\n`);
      process.exitCode = problems.length === 0 ? 0 : 1;
    } else {
      const at = args.indexOf("--source-commit");
      const manifest = buildReleaseBundle(args[0], { sourceCommit: at < 0 ? undefined : args[at + 1] });
      process.stdout.write(`release bundle for ${manifest.sourceCommit}: ${Object.keys(manifest.files).length} files\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
