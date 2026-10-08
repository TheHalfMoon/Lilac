import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startStudioHost } from "../packages/studio-host/src/index.ts";

// N0-G2c (#190): the studio host lists a project from before the rename and opens it by
// migrating it into the Ninerr format, leaving the original directory unchanged.

const LEGACY_PROJECT = fileURLToPath(new URL("./fixtures/projects/v1-basic/", import.meta.url));
const AT = "2026-10-08T12:00:00.000Z";
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "ninerr-legacy-host-")));

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
