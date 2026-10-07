#!/usr/bin/env node
// Deterministic CycloneDX 1.5 SBOM from package-lock.json, plus the license and notices
// policy (P06 gate 9, #130). Usage:
//   node scripts/sbom.mjs            write the SBOM JSON to stdout
//   node scripts/sbom.mjs --check    exit 1 and list every policy violation
// The same output for the same lockfile: no clock, sorted components, and a serial
// number derived from the lockfile bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPDX_ID = /^[A-Za-z0-9.+-]+$/u;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function purlFor(name, version) {
  const [scope, bare] = name.startsWith("@") ? name.slice(1).split("/") : [null, name];
  return `pkg:npm/${scope === null ? "" : `%40${scope}/`}${encodeURIComponent(bare)}@${encodeURIComponent(version)}`;
}

// The sha512 an npm integrity string carries, as hex.
function integrityHashes(integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/u.exec(integrity ?? "");
  return match === null ? [] : [{ alg: "SHA-512", content: Buffer.from(match[1], "base64").toString("hex") }];
}

// A deterministic RFC 4122 version-8 style UUID from bytes.
function serialFor(bytes) {
  const hex = sha256(bytes).slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const nameOf = (path, entry) => entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

export function externalPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.startsWith("node_modules/") && entry.link !== true)
    .map(([path, entry]) => ({ path, name: nameOf(path, entry), ...entry }))
    .sort((a, b) => compare(purlFor(a.name, a.version), purlFor(b.name, b.version)));
}

function workspacePackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => path !== "" && !path.startsWith("node_modules/"))
    .map(([path, entry]) => ({ path, name: entry.name, version: entry.version, dependencies: entry.dependencies ?? {} }))
    .sort((a, b) => compare(a.name, b.name));
}

// The license a package is taken to have under the policy, or why it has none.
function resolveLicense(pkg, policy) {
  const override = policy.overrides.find((entry) => entry.name === pkg.name && entry.version === pkg.version);
  if (override !== undefined) return { license: override.license, override };
  return { license: typeof pkg.license === "string" && SPDX_ID.test(pkg.license) ? pkg.license : null };
}

export function buildSbom(lockText, policy) {
  const lock = JSON.parse(lockText);
  const externals = externalPackages(lock);
  const workspaces = workspacePackages(lock);
  const byName = new Map(externals.map((pkg) => [pkg.name, pkg]));
  const workspaceByName = new Map(workspaces.map((pkg) => [pkg.name, pkg]));
  const refOf = (name) => {
    if (byName.has(name)) return purlFor(name, byName.get(name).version);
    if (workspaceByName.has(name)) return `workspace:${name}`;
    return null;
  };
  const root = lock.packages?.[""] ?? {};
  const rootRef = `workspace:${lock.name ?? root.name ?? "root"}`;
  const components = [
    // Lilac declares no license yet (a founder decision); an unknown license is recorded as
    // a property, because CycloneDX license expressions must be SPDX.
    ...workspaces.map((pkg) => ({ type: "library", "bom-ref": `workspace:${pkg.name}`, name: pkg.name, version: pkg.version ?? "0.0.0", properties: [{ name: "lilac:first-party", value: "true" }, { name: "lilac:license", value: "NOASSERTION" }] })),
    ...externals.map((pkg) => {
      const { license } = resolveLicense(pkg, policy);
      const properties = [
        ...(pkg.os ? [{ name: "npm:os", value: pkg.os.join(",") }] : []),
        ...(pkg.cpu ? [{ name: "npm:cpu", value: pkg.cpu.join(",") }] : []),
        ...(pkg.license !== undefined && pkg.license !== license ? [{ name: "npm:declaredLicense", value: pkg.license }] : []),
        ...(license === null ? [{ name: "lilac:license", value: "NOASSERTION" }] : []),
      ];
      return {
        type: "library",
        "bom-ref": purlFor(pkg.name, pkg.version),
        name: pkg.name,
        version: pkg.version,
        purl: purlFor(pkg.name, pkg.version),
        scope: pkg.optional ? "optional" : "required",
        hashes: integrityHashes(pkg.integrity),
        ...(license === null ? {} : { licenses: [{ license: { id: license } }] }),
        ...(pkg.resolved ? { externalReferences: [{ type: "distribution", url: pkg.resolved }] } : {}),
        ...(properties.length > 0 ? { properties } : {}),
      };
    }),
  ].sort((a, b) => compare(a["bom-ref"], b["bom-ref"]));
  const edges = (dependencies) => [...new Set(Object.keys(dependencies ?? {}).map(refOf).filter((ref) => ref !== null))].sort(compare);
  const dependencies = [
    { ref: rootRef, dependsOn: edges({ ...root.dependencies, ...root.devDependencies, ...Object.fromEntries(workspaces.map((pkg) => [pkg.name, pkg.version])) }) },
    ...workspaces.map((pkg) => ({ ref: `workspace:${pkg.name}`, dependsOn: edges(lock.packages[pkg.path]?.dependencies) })),
    ...externals.map((pkg) => ({ ref: purlFor(pkg.name, pkg.version), dependsOn: edges({ ...pkg.dependencies, ...pkg.optionalDependencies }) })),
  ].sort((a, b) => compare(a.ref, b.ref));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: serialFor(Buffer.from(lockText, "utf8")),
    version: 1,
    metadata: {
      component: {
        type: "application", "bom-ref": rootRef, name: lock.name ?? root.name ?? "root", version: lock.version ?? root.version ?? "0.0.0",
        ...(typeof root.license === "string" ? { licenses: [{ expression: root.license }] } : { properties: [{ name: "lilac:license", value: "NOASSERTION" }] }),
      },
      tools: { components: [{ type: "application", name: "lilac-sbom", version: "1" }] },
      properties: [{ name: "lilac:lockfileSha256", value: sha256(Buffer.from(lockText, "utf8")) }],
    },
    components,
    dependencies,
  };
}

// Every policy violation, as readable lines; an empty list means the lockfile passes.
export function checkPolicy(lockText, policy, notices, { nodeModules = join(ROOT, "node_modules") } = {}) {
  const problems = [];
  const allowed = new Set(policy.allowed);
  for (const override of policy.overrides) {
    if (!allowed.has(override.license)) problems.push(`override for ${override.name}@${override.version} resolves to disallowed ${override.license}`);
  }
  for (const pkg of externalPackages(JSON.parse(lockText))) {
    const id = `${pkg.name}@${pkg.version}`;
    const stale = policy.overrides.find((entry) => entry.name === pkg.name && entry.version !== pkg.version);
    const { license, override } = resolveLicense(pkg, policy);
    if (override !== undefined) {
      if (override.declared !== pkg.license) problems.push(`${id}: override expects declared license ${JSON.stringify(override.declared)}, lockfile has ${JSON.stringify(pkg.license)}`);
      const file = join(nodeModules, pkg.name, override.licenseFile);
      if (existsSync(join(nodeModules, pkg.name, "package.json"))) {
        const installed = JSON.parse(readFileSync(join(nodeModules, pkg.name, "package.json"), "utf8")).version;
        if (installed === pkg.version) {
          if (!existsSync(file)) problems.push(`${id}: override names ${override.licenseFile}, which is not installed`);
          else if (sha256(readFileSync(file)) !== override.licenseSha256) problems.push(`${id}: ${override.licenseFile} does not match the override's sha256`);
        }
      }
    } else if (license === null) {
      problems.push(`${id}: license ${JSON.stringify(pkg.license ?? null)} is missing or not an SPDX id, and no override covers it${stale ? ` (an override exists for version ${stale.version})` : ""}`);
    } else if (!allowed.has(license)) {
      problems.push(`${id}: license ${license} is not on the allowlist`);
    }
    if (!notices.includes(`\`${pkg.name}@`) && !notices.includes(`\`${pkg.name}\``)) problems.push(`${id}: not named in THIRD_PARTY_NOTICES.md`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lockText = readFileSync(join(ROOT, "package-lock.json"), "utf8");
  const policy = JSON.parse(readFileSync(join(ROOT, "scripts", "license-policy.json"), "utf8"));
  if (process.argv.includes("--check")) {
    const problems = checkPolicy(lockText, policy, readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8"));
    for (const problem of problems) process.stderr.write(`sbom: ${problem}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else {
    process.stdout.write(`${JSON.stringify(buildSbom(lockText, policy), null, 2)}\n`);
  }
}
