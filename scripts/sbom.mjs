#!/usr/bin/env node
// Deterministic CycloneDX 1.5 SBOM from package-lock.json, plus the license and notices
// policy (P06 gate 9, #130). Usage:
//   node scripts/sbom.mjs            write the SBOM JSON to stdout
//   node scripts/sbom.mjs --check    exit 1 and list every policy violation
// The same output for the same lockfile: no clock, sorted components, and a serial
// number derived from the lockfile bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ELECTRON_ARCHIVES, ELECTRON_VERSION, archiveName } from "./desktop/electron.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPDX_ID = /^[A-Za-z0-9.+-]+$/u;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function purlFor(name, version) {
  const [scope, bare] = name.startsWith("@") ? name.slice(1).split("/") : [null, name];
  return `pkg:npm/${scope === null ? "" : `%40${scope}/`}${encodeURIComponent(bare)}@${encodeURIComponent(version)}`;
}

// The sha512 an npm integrity string carries, as hex (the string may list several hashes).
function integrityHashes(integrity) {
  // Only a well-formed 64-byte digest counts; anything else is a missing hash.
  for (const entry of String(integrity ?? "").split(/\s+/u)) {
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry)) continue;
    return [{ alg: "SHA-512", content: Buffer.from(entry.slice("sha512-".length), "base64").toString("hex") }];
  }
  return [];
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

// Paths are lockfile keys (node_modules/a/node_modules/b); the same name and version can
// sit at several paths, and the same name at several versions.
export function externalPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => /(^|\/)node_modules\//u.test(path) && entry.link !== true)
    .map(([path, entry]) => ({ ...entry, path, name: nameOf(path, entry) }))
    .sort((a, b) => compare(purlFor(a.name, a.version), purlFor(b.name, b.version)) || compare(a.path, b.path));
}

// A bundled entry needs no integrity of its own only if it sits inside a package whose
// tarball is hashed (directly, or through a chain of bundled parents).
function hashedByEnclosingPackage(packages, path) {
  for (let current = path; ;) {
    const cut = current.lastIndexOf("/node_modules/");
    if (cut < 0) return false;
    current = current.slice(0, cut);
    const parent = packages[current];
    if (parent === undefined) return false;
    if (integrityHashes(parent.integrity).length > 0) return true;
    if (!parent.inBundle) return false;
  }
}

// npm's lookup: <path>/node_modules/<dep>, then each enclosing node_modules, then the root.
function resolveDependency(packages, fromPath, dependency) {
  let base = fromPath;
  for (;;) {
    const candidate = base === "" ? `node_modules/${dependency}` : `${base}/node_modules/${dependency}`;
    if (packages[candidate] !== undefined) return candidate;
    if (base === "") return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut < 0 ? "" : base.slice(0, cut);
  }
}

function workspacePackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => path !== "" && !/(^|\/)node_modules\//u.test(path))
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
  const packages = lock.packages ?? {};
  const allowed = new Set(policy.allowed);
  const externals = externalPackages(lock);
  const workspaces = workspacePackages(lock);
  const workspaceByPath = new Map(workspaces.map((pkg) => [pkg.path, pkg]));
  // The bom-ref a lockfile path stands for: a purl, a workspace, or null.
  const refAt = (path) => {
    const entry = packages[path];
    if (entry === undefined) return null;
    if (entry.link === true) return workspaceByPath.has(entry.resolved) ? `workspace:${workspaceByPath.get(entry.resolved).name}` : null;
    if (workspaceByPath.has(path)) return `workspace:${workspaceByPath.get(path).name}`;
    return purlFor(nameOf(path, entry), entry.version);
  };
  const edgesFrom = (path, entry) => {
    // devDependencies are only installed for the root and the workspaces.
    const names = Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies, ...(path === "" || workspaceByPath.has(path) ? entry.devDependencies : {}) });
    return names.map((name) => resolveDependency(packages, path, name)).filter((target) => target !== null).map(refAt).filter((ref) => ref !== null);
  };
  const root = packages[""] ?? {};
  const rootRef = `workspace:${lock.name ?? root.name ?? "root"}`;
  const components = new Map();
  const graph = new Map();
  const addEdges = (ref, refs) => { const set = graph.get(ref) ?? new Set(); for (const target of refs) set.add(target); graph.set(ref, set); };
  addEdges(rootRef, [...edgesFrom("", root), ...workspaces.map((pkg) => `workspace:${pkg.name}`)]);
  for (const pkg of workspaces) {
    // Lilac declares no license yet (a founder decision); an unknown license is recorded as
    // a property, because CycloneDX license expressions must be SPDX.
    components.set(`workspace:${pkg.name}`, { type: "library", "bom-ref": `workspace:${pkg.name}`, name: pkg.name, version: pkg.version ?? "0.0.0", properties: [{ name: "lilac:first-party", value: "true" }, { name: "lilac:license", value: "NOASSERTION" }] });
    addEdges(`workspace:${pkg.name}`, edgesFrom(pkg.path, packages[pkg.path]));
  }
  // The same name and version can be installed at several paths with different flags; the
  // component's scope is the strongest of them (it ships if any copy ships).
  const RANK = { required: 2, optional: 1, excluded: 0 };
  const scopeOf = (pkg) => (pkg.dev ? "excluded" : pkg.optional || pkg.devOptional || pkg.peer ? "optional" : "required");
  // Likewise its hash comes from any copy that has one, and it is "bundled" only if every
  // copy is.
  const strongest = new Map();
  const hashOf = new Map();
  const allBundled = new Map();
  for (const pkg of externals) {
    const ref = purlFor(pkg.name, pkg.version);
    const scope = scopeOf(pkg);
    if (!strongest.has(ref) || RANK[scope] > RANK[strongest.get(ref)]) strongest.set(ref, scope);
    const hashes = integrityHashes(pkg.integrity);
    if (hashes.length > 0 && !hashOf.has(ref)) hashOf.set(ref, hashes);
    allBundled.set(ref, (allBundled.get(ref) ?? true) && pkg.inBundle === true);
  }
  for (const pkg of externals) {
    const ref = purlFor(pkg.name, pkg.version);
    addEdges(ref, edgesFrom(pkg.path, pkg));
    if (components.has(ref)) continue; // the same name and version at another path
    const { license } = resolveLicense(pkg, policy);
    const properties = [
      ...(pkg.os ? [{ name: "npm:os", value: pkg.os.join(",") }] : []),
      ...(pkg.cpu ? [{ name: "npm:cpu", value: pkg.cpu.join(",") }] : []),
      ...(pkg.license !== undefined && pkg.license !== license ? [{ name: "npm:declaredLicense", value: String(pkg.license) }] : []),
      ...(license === null ? [{ name: "lilac:license", value: "NOASSERTION" }] : []),
      ...(allBundled.get(ref) ? [{ name: "npm:inBundle", value: "true" }] : []),
    ];
    components.set(ref, {
      type: "library",
      "bom-ref": ref,
      name: pkg.name,
      version: pkg.version,
      purl: ref,
      scope: strongest.get(ref),
      hashes: hashOf.get(ref) ?? [],
      // Only allowlisted ids are SPDX ids this tool vouches for; anything else is a name.
      ...(license === null ? {} : { licenses: [allowed.has(license) ? { license: { id: license } } : { license: { name: license } }] }),
      ...(pkg.resolved ? { externalReferences: [{ type: "distribution", url: pkg.resolved }] } : {}),
      ...(properties.length > 0 ? { properties } : {}),
    });
  }
  // The desktop app's runtime: not an npm package, but pinned by the SHA-256 of each
  // official release archive (scripts/desktop/electron.mjs) and redistributed in the
  // desktop packages.
  const electronRef = `pkg:github/electron/electron@${ELECTRON_VERSION}`;
  components.set(electronRef, {
    type: "framework",
    "bom-ref": electronRef,
    name: "electron",
    version: ELECTRON_VERSION,
    purl: electronRef,
    scope: "required",
    licenses: [{ license: { id: "MIT" } }],
    externalReferences: Object.keys(ELECTRON_ARCHIVES).sort().map((target) => ({ type: "distribution", url: `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${archiveName(target)}`, hashes: [{ alg: "SHA-256", content: ELECTRON_ARCHIVES[target] }] })),
    properties: [{ name: "lilac:runtime", value: "desktop" }, { name: "lilac:notices", value: "LICENSES.chromium.html (shipped unchanged)" }],
  });
  if (components.has("workspace:@lilac/desktop")) addEdges("workspace:@lilac/desktop", [electronRef]);
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
    components: [...components.values()].sort((a, b) => compare(a["bom-ref"], b["bom-ref"])),
    dependencies: [...graph.entries()].map(([ref, set]) => ({ ref, dependsOn: [...set].filter((target) => target !== ref).sort(compare) })).sort((a, b) => compare(a.ref, b.ref)),
  };
}

// Every policy violation, as readable lines; an empty list means the lockfile passes.
export function checkPolicy(lockText, policy, notices, { nodeModules = join(ROOT, "node_modules") } = {}) {
  const problems = [];
  const allowed = new Set(policy.allowed);
  const lock = JSON.parse(lockText);
  if (!(lock.lockfileVersion >= 2) || lock.packages === null || typeof lock.packages !== "object" || lock.packages[""] === undefined) {
    return [`package-lock.json must be lockfileVersion 2 or later with a "packages" map (got lockfileVersion ${JSON.stringify(lock.lockfileVersion ?? null)})`];
  }
  let overridesApplied = 0;
  let overridesVerified = 0;
  for (const override of policy.overrides) {
    if (!allowed.has(override.license)) problems.push(`override for ${override.name}@${override.version} resolves to disallowed ${override.license}`);
  }
  const seen = new Set();
  for (const pkg of externalPackages(lock)) {
    const id = `${pkg.name}@${pkg.version}`;
    // A bundled dependency ships inside its parent's tarball, which the lockfile hashes.
    if (integrityHashes(pkg.integrity).length === 0 && !(pkg.inBundle && hashedByEnclosingPackage(lock.packages, pkg.path))) {
      problems.push(`${id} at ${pkg.path}: no sha512 integrity in the lockfile${pkg.inBundle ? " (marked inBundle, but no enclosing package is hashed)" : ""}`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const stale = policy.overrides.find((entry) => entry.name === pkg.name && entry.version !== pkg.version);
    const { license, override } = resolveLicense(pkg, policy);
    if (override !== undefined) {
      overridesApplied += 1;
      if (override.declared !== pkg.license) problems.push(`${id}: override expects declared license ${JSON.stringify(override.declared)}, lockfile has ${JSON.stringify(pkg.license)}`);
      const packageDir = join(nodeModules, pkg.name);
      const file = resolve(packageDir, override.licenseFile);
      const inside = relative(packageDir, file);
      if (inside === "" || inside.startsWith(`..${sep}`) || inside === "..") {
        problems.push(`${id}: override licenseFile ${JSON.stringify(override.licenseFile)} is outside the package`);
      } else if (existsSync(join(packageDir, "package.json"))) {
        const installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
        if (installed === pkg.version) {
          overridesVerified += 1;
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
  // Overrides are only as good as their verification: at least one must be checked
  // against an installed license file (npm installs one platform binary per host).
  if (overridesApplied > 0 && overridesVerified === 0) problems.push(`none of the ${overridesApplied} license overrides could be verified against an installed license file (is node_modules installed?)`);
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
