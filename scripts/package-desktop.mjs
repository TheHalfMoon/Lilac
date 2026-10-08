#!/usr/bin/env node
// Package the Lilac desktop app for this computer's platform (MASTER_PLAN PC gate 15):
//
//   node scripts/package-desktop.mjs [--out <folder>]
//
// A Lilac-owned assembly, with no packaging tool: the pinned, SHA-256-verified Electron
// runtime (scripts/fetch-electron.mjs), renamed Lilac, with its fuses set so it can never
// run as a plain Node or accept an inspector, and the app beside it as plain files:
// - the workspace packages the shell and the editor reach, as source (packages/<name>);
// - the installed runtime dependencies (node_modules), with their license texts;
// - Lilac's notices and security policy.
// Each platform is packaged on its own runner (Linux x64, macOS arm64, Windows x64). The
// result is an archive in <folder> (default dist/desktop) and a manifest of what is in it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ELECTRON_VERSION, WINDOWS_TAR, currentTarget, electronDirectory, fetchElectron } from "./desktop/electron.mjs";
import { classifyChromiumLicenses } from "./desktop/chromium-licenses.mjs";
import { LILAC_FUSES, writeFuses } from "./desktop/fuses.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUNDLE_ID = "io.github.thehalfmoon.lilac";
// The editor's browser-side packages, which the host serves as static files.
const SERVED = ["studio-web", "document-model", "history", "renderer", "canvas"];

const args = process.argv.slice(2);
const at = args.indexOf("--out");
if (args.some((arg, index) => arg !== "--out" && index !== at + 1) || (at >= 0 && (args[at + 1] === undefined || args[at + 1].startsWith("--")))) {
  process.stderr.write("usage: node scripts/package-desktop.mjs [--out <folder>]\n");
  process.exit(2);
}
const out = resolve(at >= 0 ? args[at + 1] : join(ROOT, "dist", "desktop"));
const target = currentTarget();
const log = (line) => process.stdout.write(`${line}\n`);
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed`);
};

/** The workspace packages reachable from `entries` through their imports. */
export function reachablePackages(entries) {
  const found = new Set(SERVED);
  const queue = [...entries, ...SERVED.map((name) => join(ROOT, "packages", name, "src"))];
  const seen = new Set();
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) if (/\.(?:mjs|ts|cjs|js)$/u.test(entry)) queue.push(join(path, entry));
      continue;
    }
    const text = readFileSync(path, "utf8");
    for (const [, specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/gu)) {
      const scoped = /^@lilac\/([a-z][a-z0-9-]*)/u.exec(specifier);
      if (scoped !== null) {
        if (!found.has(scoped[1])) {
          found.add(scoped[1]);
          queue.push(join(ROOT, "packages", scoped[1], "src"));
        }
      } else if (specifier.startsWith(".")) {
        const next = resolve(dirname(path), specifier);
        const name = relative(join(ROOT, "packages"), next).split(/[\\/]/u)[0];
        if (!name.startsWith("..") && !found.has(name)) {
          found.add(name);
          queue.push(join(ROOT, "packages", name, "src"));
        }
        if (existsSync(next) && statSync(next).isFile()) queue.push(next);
      }
    }
  }
  return [...found].sort();
}

/** Installed runtime dependencies (not development ones), from the lockfile. */
function runtimeDependencies() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith("node_modules/") && !entry.dev && !entry.link && existsSync(join(ROOT, key)))
    .map(([key, entry]) => ({ path: key, name: key.slice("node_modules/".length), version: entry.version, license: entry.license ?? null }));
}

function treeDigest(directory) {
  const hash = createHash("sha256");
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(`${relative(directory, full)}\0`).update(readFileSync(full));
    }
  };
  walk(directory);
  return hash.digest("hex");
}

async function main() {
  await fetchElectron(target, { log });
  const name = `Lilac-${target}`;
  const staging = join(out, name);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(electronDirectory(target), staging, { recursive: true, verbatimSymlinks: true, filter: (source) => !source.endsWith(".lilac-verified") });

  // The runtime, renamed, and where the app goes inside it.
  let executable;
  let resources;
  let fused;
  if (target.startsWith("darwin-")) {
    renameSync(join(staging, "Electron.app"), join(staging, "Lilac.app"));
    const contents = join(staging, "Lilac.app", "Contents");
    resources = join(contents, "Resources");
    executable = join(contents, "MacOS", "Electron");
    fused = join(contents, "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
    // The bundle's name and identity (the executable and its helpers keep Electron's names,
    // which the runtime looks its helpers up by).
    const plist = join(contents, "Info.plist");
    for (const [key, value] of [["CFBundleName", "Lilac"], ["CFBundleDisplayName", "Lilac"], ["CFBundleIdentifier", BUNDLE_ID]]) {
      run("plutil", ["-replace", key, "-string", value, plist]);
    }
  } else if (target.startsWith("win32-")) {
    renameSync(join(staging, "electron.exe"), join(staging, "Lilac.exe"));
    executable = fused = join(staging, "Lilac.exe");
    resources = join(staging, "resources");
  } else {
    renameSync(join(staging, "electron"), join(staging, "lilac"));
    executable = fused = join(staging, "lilac");
    resources = join(staging, "resources");
  }
  rmSync(join(resources, "default_app.asar"), { force: true });
  // Every component the runtime's own notice names under a non-permissive license must be
  // one Lilac has reviewed; the notice ships unchanged.
  const chromiumLicenses = classifyChromiumLicenses(join(staging, "LICENSES.chromium.html"));
  if (chromiumLicenses.unreviewed.length > 0) throw new Error(`LICENSES.chromium.html names components not yet reviewed: ${JSON.stringify(chromiumLicenses.unreviewed)}`);
  if (!existsSync(join(staging, "LICENSE"))) throw new Error("the runtime's LICENSE is missing");
  const fuses = writeFuses(fused, LILAC_FUSES);

  // The app, as plain files.
  const app = join(resources, "app");
  const packages = reachablePackages([join(ROOT, "packages", "desktop", "src", "bootstrap.mjs")]);
  for (const pkg of packages) {
    cpSync(join(ROOT, "packages", pkg, "package.json"), join(app, "packages", pkg, "package.json"));
    cpSync(join(ROOT, "packages", pkg, "src"), join(app, "packages", pkg, "src"), { recursive: true });
  }
  const dependencies = runtimeDependencies();
  for (const dependency of dependencies) cpSync(join(ROOT, dependency.path), join(app, dependency.path), { recursive: true, dereference: true });
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "lilac", productName: "Lilac", version: root.version, private: true, type: "module", main: "packages/desktop/src/bootstrap.mjs" }, null, 2)}\n`);
  for (const file of ["THIRD_PARTY_NOTICES.md", "SECURITY.md"]) cpSync(join(ROOT, file), join(app, file));

  // macOS needs a valid signature to run on arm64; patching the fuses broke Electron's. An
  // ad-hoc signature lets it run; a release signature needs the owner's certificate (#139).
  if (target.startsWith("darwin-")) run("codesign", ["--force", "--deep", "--sign", "-", join(staging, "Lilac.app")]);

  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() || null;
  const manifest = {
    product: "Lilac",
    target,
    commit,
    electron: ELECTRON_VERSION,
    executable: relative(staging, executable).split("\\").join("/"),
    fuses,
    chromiumLicenses: { components: chromiumLicenses.components, sha256: chromiumLicenses.sha256, families: chromiumLicenses.families },
    packages,
    dependencies: dependencies.map(({ name, version, license }) => ({ name, version, license })),
    appSha256: treeDigest(app),
    signed: target.startsWith("darwin-") ? "ad-hoc" : "unsigned",
  };
  writeFileSync(join(staging, "lilac-package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The archive: a zip on macOS and Windows, a tar.gz on Linux (which keeps the modes).
  const archive = join(out, `${name}.${target.startsWith("linux-") ? "tar.gz" : "zip"}`);
  rmSync(archive, { force: true });
  if (target.startsWith("darwin-")) run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", staging, archive]);
  else if (target.startsWith("win32-")) run(WINDOWS_TAR, ["-a", "-c", "-f", archive, "-C", out, name]);
  else run("tar", ["-czf", archive, "-C", out, name]);
  const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ ...manifest, archive: relative(out, archive), archiveSha256 }, null, 2)}\n`);
  log(`Packaged Lilac for ${target}: ${archive} (sha256 ${archiveSha256})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`package-desktop: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
