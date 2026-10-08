// Electron's fuses: switches compiled into the Electron binary that turn features off
// for good, so no environment variable or command-line flag can turn them back on. The
// fuse block follows a fixed sentinel: a version byte (1), a count, then one byte per
// fuse, "0" (off), "1" (on) or "r" (removed), in this order.
import { readFileSync, writeFileSync } from "node:fs";

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "latin1");

export const FUSES = Object.freeze([
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "EnableWasmTrapHandlers",
]);

// Lilac's desktop app: it is never run as a plain Node (ELECTRON_RUN_AS_NODE), never reads
// NODE_OPTIONS, never accepts --inspect, and never gives file: pages extra privileges.
// WebAssembly trap handlers stay on; the others stay at Electron's default (off).
export const LILAC_FUSES = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: false,
  OnlyLoadAppFromAsar: false,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  EnableWasmTrapHandlers: true,
});

function locate(bytes, path) {
  const at = bytes.indexOf(SENTINEL);
  if (at < 0 || bytes.indexOf(SENTINEL, at + 1) >= 0) throw new Error(`${path} does not hold exactly one Electron fuse block`);
  const start = at + SENTINEL.length;
  if (bytes[start] !== 1) throw new Error(`${path} has fuse version ${bytes[start]}; only version 1 is understood`);
  const count = bytes[start + 1];
  if (count !== FUSES.length) throw new Error(`${path} has ${count} fuses; Lilac knows ${FUSES.length}`);
  return start + 2;
}

/** The fuses in the binary at `path`, by name: true, false or "removed". */
export function readFuses(path) {
  const bytes = readFileSync(path);
  const offset = locate(bytes, path);
  return Object.fromEntries(FUSES.map((name, index) => {
    const value = String.fromCharCode(bytes[offset + index]);
    return [name, value === "1" ? true : value === "0" ? false : "removed"];
  }));
}

/** Set every fuse in the binary at `path` as `wanted` says; a removed fuse is left alone. */
export function writeFuses(path, wanted = LILAC_FUSES) {
  const bytes = readFileSync(path);
  const offset = locate(bytes, path);
  FUSES.forEach((name, index) => {
    if (typeof wanted[name] !== "boolean") throw new Error(`no setting for fuse ${name}`);
    if (bytes[offset + index] === 0x72) return; // "r": removed in this build
    bytes[offset + index] = wanted[name] ? 0x31 : 0x30;
  });
  writeFileSync(path, bytes);
  return readFuses(path);
}
