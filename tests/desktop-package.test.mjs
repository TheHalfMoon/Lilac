import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyChromiumLicenses } from "../scripts/desktop/chromium-licenses.mjs";
import { electronDirectory } from "../scripts/desktop/electron.mjs";
import { FUSES, LILAC_FUSES, readFuses, writeFuses } from "../scripts/desktop/fuses.mjs";
import { reachablePackages } from "../scripts/package-desktop.mjs";

// PC9 (#174): the pieces of the desktop packaging (PC gate 15) that can be checked without
// a runner of each platform. The packages themselves are built and smoke-tested on each
// platform's runner by the Desktop workflow.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const scratch = () => mkdtempSync(join(tmpdir(), "lilac-desktop-package-"));

test("fuses are read and set in place, and only in a block Lilac understands", () => {
  const dir = scratch();
  try {
    const binary = join(dir, "electron");
    // Electron 44's defaults, with filler on both sides.
    writeFileSync(binary, Buffer.concat([Buffer.alloc(64, 7), Buffer.from(`${SENTINEL}\u0001\u0009101100011`, "latin1"), Buffer.alloc(64, 9)]));
    const before = readFuses(binary);
    assert.equal(before.RunAsNode, true);
    assert.equal(before.EnableNodeCliInspectArguments, true);
    assert.deepEqual(writeFuses(binary), LILAC_FUSES);
    const bytes = readFileSync(binary);
    assert.equal(bytes.length, 64 + SENTINEL.length + 2 + FUSES.length + 64, "nothing else changes size");
    assert.equal(bytes.subarray(SENTINEL.length + 66, SENTINEL.length + 66 + 9).toString("latin1"), "000000001");
    assert.ok(bytes.subarray(0, 64).every((byte) => byte === 7) && bytes.subarray(-64).every((byte) => byte === 9), "nothing else changes");
    // A removed fuse stays removed.
    writeFileSync(binary, Buffer.from(`${SENTINEL}\u0001\u00091r1100011`, "latin1"));
    assert.equal(writeFuses(binary).EnableCookieEncryption, "removed");
    // Refused: no block, two blocks, another version, another count.
    for (const content of ["no fuses here", `${SENTINEL}\u0001\u0009101100011${SENTINEL}\u0001\u0009101100011`, `${SENTINEL}\u0002\u0009101100011`, `${SENTINEL}\u0001\u000810110001`]) {
      writeFileSync(binary, Buffer.from(content, "latin1"));
      assert.throws(() => writeFuses(binary), /fuse/u, JSON.stringify(content.slice(-12)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the runtime's notice is classified, and an unreviewed copyleft component is caught", () => {
  const dir = scratch();
  try {
    const notice = join(dir, "LICENSES.chromium.html");
    const product = (title, license) => `<div class="product"><span class="title">${title}</span><pre>${license}</pre></div>`;
    writeFileSync(notice, [
      "<html>",
      product("zlib", "Permission is hereby granted, free of charge, to any person"),
      product("ffmpeg", "GNU Lesser General Public License version 2.1"),
      product("play-services-base", "GNU Lesser General Public License"),
      product("Some &amp; New Thing", "GNU General Public License version 3"),
      "</html>",
    ].join(""));
    const result = classifyChromiumLicenses(notice);
    assert.equal(result.components, 4);
    assert.deepEqual(result.unreviewed, [{ component: "Some & New Thing", families: ["GPL"] }], "reviewed and Android-only components pass; the new one does not");
    assert.equal(result.families["MIT-style"], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The pinned runtime for this computer, when it has been fetched: every component reviewed.
  const real = join(electronDirectory(), "LICENSES.chromium.html");
  if (existsSync(real)) {
    const result = classifyChromiumLicenses(real);
    assert.ok(result.components > 500, `${result.components} components`);
    assert.deepEqual(result.unreviewed, []);
  }
});

test("the package holds the packages the shell and the editor reach, and no others", () => {
  const packages = reachablePackages([join(ROOT, "packages", "desktop", "src", "bootstrap.mjs")]);
  for (const name of ["desktop", "studio-host", "persistence", "history", "document-model", "collaboration", "mcp-protocol", "import-stack", "intake", "code-ir", "studio-web", "canvas", "renderer"]) {
    assert.ok(packages.includes(name), `${name} is packaged`);
  }
  for (const name of ["agent-supervisor", "visual-git", "decision-router", "architecture"]) assert.ok(!packages.includes(name), `${name} is not`);
  for (const name of packages) assert.ok(existsSync(join(ROOT, "packages", name, "package.json")), `${name} is a workspace package`);
});
