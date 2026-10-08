import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startStudioHost } from "../packages/studio-host/src/index.ts";

// N0-G2c (#190): the studio host lists a project from before the rename and opens it by
// migrating it into the Ninerr format, leaving the original directory unchanged.

const LEGACY_PROJECT = fileURLToPath(new URL("./fixtures/projects/v1-basic/", import.meta.url));
const AT = "2026-10-08T12:00:00.000Z";
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "ninerr-legacy-host-")));

test("a legacy project still locked by the earlier release is not taken over, and the person is told what to do", async () => {
  const root = scratch();
  cpSync(LEGACY_PROJECT, join(root, "old"), { recursive: true });
  writeFileSync(join(root, "old", ".lilac", "lock"), JSON.stringify({ owner: "lilac-app", pid: 2 ** 22 + 4321, at: AT, nonce: "n" }));
  const host = await startStudioHost({ projectsRoot: root, now: () => AT });
  try {
    for (const body of [{ name: "old" }, { name: "old", breakStaleLock: { reason: "it crashed" } }]) {
      const response = await fetch(`${host.url}/api/projects/open`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await response.json();
      assert.equal(response.status, 409);
      assert.equal(json.error.code, "legacy-project-locked", "not the takeover dialog's code");
      assert.match(json.error.message, /left it locked when it stopped/u, "the lock's process is gone");
      assert.match(json.error.message, /remove old\/\.lilac\/lock/u);
    }
    // Held by a running process: the person is told to close it there or wait, never to remove the lock.
    writeFileSync(join(root, "old", ".lilac", "lock"), JSON.stringify({ owner: "lilac-app", pid: process.pid, at: AT, nonce: "n" }));
    const running = await (await fetch(`${host.url}/api/projects/open`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "old" }) })).json();
    assert.equal(running.error.code, "legacy-project-locked");
    assert.match(running.error.message, /open elsewhere right now/u);
    assert.doesNotMatch(running.error.message, /remove/u);
    assert.equal(existsSync(join(root, "old", ".ninerr")), false, "nothing is created");
    assert.ok(existsSync(join(root, "old", ".lilac", "lock")), "the legacy lock is left in place");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the studio host lists a legacy project and opens it by migrating it, leaving the original unchanged", async () => {
  const root = scratch();
  cpSync(LEGACY_PROJECT, join(root, "old"), { recursive: true });
  const legacyFiles = () => Object.fromEntries(readdirSync(join(root, "old", ".lilac"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => [path, readFileSync(path).toString("base64")]));
  const before = legacyFiles();
  const host = await startStudioHost({ projectsRoot: root, now: () => AT });
  try {
    const call = (method, path, body) => fetch(`${host.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, json: await response.json() }));
    assert.deepEqual((await call("GET", "/api/projects")).json.projects, ["old"]);
    const opened = await call("POST", "/api/projects/open", { name: "old" });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.revision, 5);
    assert.equal(opened.json.recovery.legacyProject, true);
    assert.equal(opened.json.recovery.migratedFrom, 1);
    assert.ok(existsSync(join(root, "old", ".ninerr", "project.json")));
  } finally {
    await host.close();
  }
  try {
    assert.deepEqual(legacyFiles(), before, "the legacy directory is byte-identical");
    assert.equal(readFileSync(join(root, "old", ".lilac", "project.json"), "utf8"), readFileSync(join(LEGACY_PROJECT, ".lilac", "project.json"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
