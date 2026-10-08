// The Electron runtime the Lilac desktop app is built on, pinned by version and by the
// SHA-256 of each official release archive. Lilac does not depend on the `electron` npm
// package (or its downloader and their dependencies): the archive is fetched from the
// Electron project's GitHub release, checked against the pinned digest, and unpacked into
// a cache in this repository. Nothing unchecked is ever unpacked or run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ELECTRON_VERSION = "44.7.0";

// From the release's SHASUMS256.txt, matched against the electron@44.7.0 npm package's
// checksums.json (two independent publications of the same digests).
export const ELECTRON_ARCHIVES = Object.freeze({
  "linux-x64": "3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a",
  "darwin-arm64": "e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b",
  "win32-x64": "eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c",
});

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ELECTRON_CACHE = join(ROOT, ".lilac-cache", "electron");

export const currentTarget = () => `${process.platform}-${process.arch}`;

export function archiveName(target) {
  return `electron-v${ELECTRON_VERSION}-${target}.zip`;
}

/** Where the unpacked runtime for `target` lives. */
export function electronDirectory(target = currentTarget()) {
  return join(ELECTRON_CACHE, `v${ELECTRON_VERSION}`, target);
}

/** The Electron executable for `target`, inside its unpacked runtime. */
export function electronExecutable(target = currentTarget()) {
  const directory = electronDirectory(target);
  if (target.startsWith("darwin-")) return join(directory, "Electron.app", "Contents", "MacOS", "Electron");
  if (target.startsWith("win32-")) return join(directory, "electron.exe");
  return join(directory, "electron");
}

/** The executable when it has been fetched, or null. */
export function findElectron(target = currentTarget()) {
  const path = electronExecutable(target);
  return existsSync(path) && existsSync(join(electronDirectory(target), ".lilac-verified")) ? path : null;
}

function unzip(archive, into) {
  // Each platform's own unzip: Info-ZIP on Linux, ditto on macOS (which keeps the app
  // bundle's symlinks and permissions), and bsdtar on Windows.
  const [command, args] = process.platform === "darwin"
    ? ["ditto", ["-x", "-k", archive, into]]
    : process.platform === "win32"
      ? ["tar", ["-xf", archive, "-C", into]]
      : ["unzip", ["-q", archive, "-d", into]];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} could not unpack ${archive}`);
}

/**
 * Fetch, verify and unpack the pinned runtime for `target` (once; later calls return the
 * cached executable). The archive is verified before it is unpacked.
 */
export async function fetchElectron(target = currentTarget(), { log = () => {} } = {}) {
  const expected = ELECTRON_ARCHIVES[target];
  if (expected === undefined) throw new Error(`Lilac's desktop app is not built for ${target} (supported: ${Object.keys(ELECTRON_ARCHIVES).join(", ")})`);
  const found = findElectron(target);
  if (found !== null) return found;
  const name = archiveName(target);
  const downloads = join(ELECTRON_CACHE, "downloads");
  mkdirSync(downloads, { recursive: true });
  const archive = join(downloads, name);
  let bytes = existsSync(archive) ? readFileSync(archive) : null;
  if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== expected) {
    const url = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${name}`;
    log(`Fetching ${url}`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`${name} does not match its pinned SHA-256 (expected ${expected}, got ${actual}); nothing was unpacked`);
    writeFileSync(archive, bytes);
  }
  const directory = electronDirectory(target);
  const staging = `${directory}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  unzip(archive, staging);
  writeFileSync(join(staging, ".lilac-verified"), `${name} ${expected}\n`);
  rmSync(directory, { recursive: true, force: true });
  renameSync(staging, directory);
  log(`Electron ${ELECTRON_VERSION} for ${target} is ready: ${electronExecutable(target)}`);
  return electronExecutable(target);
}
