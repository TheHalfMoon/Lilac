import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { PROJECT_FILES, PersistenceValidationError, createProject, openProject } from "../packages/persistence/src/index.ts";

// Sandbox escapes found by the P06 gate-5 probe (#115), plus attacks that already
// failed closed but had no test.

const AT = "2026-10-07T09:00:00.000Z";
const PERSISTENCE_URL = new URL("../packages/persistence/src/index.ts", import.meta.url).href;
const document = () => createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame" }] });
const setTitle = (id, baseRevision, title) => ({ id, actor: "user-1", baseRevision, operations: [{ type: "set-props", nodeId: "node-1", set: { title } }] });
const open = (root, extra = {}) => openProject(root, { owner: "writer-1", at: AT, ...extra });
const file = (root, name) => join(root, PROJECT_FILES.directory, name);

function withRoot(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lilac-sandbox-"));
  const root = join(parent, "root");
  mkdirSync(root);
  createProject(root, { projectId: "proj-1", document: document(), createdAt: AT });
  try {
    return callback(root, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const hasMkfifo = spawnSync("mkfifo", ["--version"]).error === undefined;

test("a FIFO in place of a project file is refused instead of hanging", { skip: !hasMkfifo && "mkfifo is unavailable" }, () => {
  for (const name of [PROJECT_FILES.snapshot, PROJECT_FILES.manifest, PROJECT_FILES.journal]) {
    withRoot((root) => {
      unlinkSync(file(root, name));
      execFileSync("mkfifo", [file(root, name)]);
      const script = `import { openProject } from ${JSON.stringify(PERSISTENCE_URL)};
        try { openProject(${JSON.stringify(root)}, { owner: "w", at: ${JSON.stringify(AT)} }); console.log("opened"); }
        catch (error) { console.log(error.name + ": " + error.message); }`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
      assert.equal(result.signal, null, `${name}: openProject must not block on a FIFO`);
      assert.match(result.stdout, /PersistenceValidationError: .*must be a regular file/u, name);
    });
  }
});

test("a FIFO in place of the lock is refused instead of hanging", { skip: !hasMkfifo && "mkfifo is unavailable" }, () => withRoot((root) => {
  // In a child process with a timeout, so a regression fails instead of hanging the suite.
  const script = `import { unlinkSync } from "node:fs"; import { execFileSync } from "node:child_process";
    import { openProject } from ${JSON.stringify(PERSISTENCE_URL)};
    const store = openProject(${JSON.stringify(root)}, { owner: "w", at: ${JSON.stringify(AT)} });
    const lock = ${JSON.stringify(file(root, PROJECT_FILES.lock))};
    unlinkSync(lock); execFileSync("mkfifo", [lock]);
    try { store.commit({ id: "t1", actor: "u", baseRevision: 0, operations: [{ type: "set-props", nodeId: "node-1", set: { a: 1 } }] }); console.log("committed"); }
    catch (error) { console.log(error.name + ": " + error.message); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.signal, null, "a lock read must not block on a FIFO");
  assert.match(result.stdout, /no longer holds the project lock/u, "an unreadable lock is not this writer's lock");
}));

test("writes are refused after the project root is swapped for a symlink", () => withRoot((root, parent) => {
  const store = open(root);
  store.commit(setTitle("t1", 0, "x"));
  const outside = mkdtempSync(join(parent, "outside-"));
  mkdirSync(join(outside, PROJECT_FILES.directory, PROJECT_FILES.objects), { recursive: true });
  cpSync(file(root, PROJECT_FILES.lock), join(outside, PROJECT_FILES.directory, PROJECT_FILES.lock));
  renameSync(root, join(parent, "moved"));
  symlinkSync(outside, root);
  assert.throws(() => store.checkpoint(), /project directory changed since the store was opened/u);
  assert.throws(() => store.putObject(Buffer.from("planted")), /changed since/u);
  assert.throws(() => store.commit(setTitle("t2", 1, "y")), /changed since/u);
  assert.deepEqual(readdirSync(join(outside, PROJECT_FILES.directory)).sort(), [PROJECT_FILES.lock, PROJECT_FILES.objects].sort(), "nothing was written outside");
  assert.deepEqual(readdirSync(join(outside, PROJECT_FILES.directory, PROJECT_FILES.objects)), []);
}));

test("writes are refused after .lilac is replaced by a fresh directory", () => withRoot((root) => {
  const store = open(root);
  renameSync(join(root, PROJECT_FILES.directory), join(root, ".lilac-old"));
  mkdirSync(join(root, PROJECT_FILES.directory, PROJECT_FILES.objects), { recursive: true });
  cpSync(join(root, ".lilac-old", PROJECT_FILES.lock), file(root, PROJECT_FILES.lock));
  assert.throws(() => store.checkpoint(), /changed since/u);
  assert.equal(existsSync(file(root, PROJECT_FILES.snapshot)), false);
}));

test("an objects path that is a regular file fails with a typed error", () => withRoot((root) => {
  rmSync(file(root, PROJECT_FILES.objects), { recursive: true });
  writeFileSync(file(root, PROJECT_FILES.objects), "x");
  assert.throws(() => open(root), PersistenceValidationError);
}));

test("a hard-linked lock is unreadable and its contents are not copied", () => withRoot((root, parent) => {
  const victim = join(parent, "victim.json");
  writeFileSync(victim, JSON.stringify({ owner: "SECRET-OWNER", pid: 1, at: "leak", nonce: "n" }));
  linkSync(victim, file(root, PROJECT_FILES.lock));
  const store = open(root, { breakStaleLock: { reason: "stale" } });
  const override = JSON.stringify(store.recovery.lockOverride ?? null);
  store.close();
  assert.equal(override.includes("SECRET-OWNER"), false, "outside file contents must not enter the override record");
  assert.equal(readFileSync(victim, "utf8").includes("SECRET-OWNER"), true, "the outside file is untouched");
}));

test("symlinked object directories are refused", () => {
  withRoot((root, parent) => {
    const store = open(root);
    const objects = file(root, PROJECT_FILES.objects);
    const fanouts = readdirSync(objects);
    assert.ok(fanouts.length > 0);
    const outside = mkdtempSync(join(parent, "fan-"));
    renameSync(join(objects, fanouts[0]), join(outside, "moved"));
    symlinkSync(join(outside, "moved"), join(objects, fanouts[0]));
    assert.throws(() => store.checkpoint(), PersistenceValidationError, "fan-out symlink");
    store.close();
  });
  withRoot((root, parent) => {
    const store = open(root);
    const objects = file(root, PROJECT_FILES.objects);
    const outside = mkdtempSync(join(parent, "objs-"));
    renameSync(objects, join(outside, "objects"));
    symlinkSync(join(outside, "objects"), objects);
    assert.throws(() => store.checkpoint(), PersistenceValidationError, "objects symlink");
    store.close();
  });
});

test("a hard-linked snapshot is replaced, never rewritten in place", () => withRoot((root, parent) => {
  const peer = join(parent, "peer.json");
  linkSync(file(root, PROJECT_FILES.snapshot), peer);
  const before = readFileSync(peer, "utf8");
  const store = open(root);
  store.commit(setTitle("t1", 0, "x"));
  store.checkpoint();
  store.close();
  assert.equal(readFileSync(peer, "utf8"), before, "the other link keeps its old content");
}));

test("malformed object ids and roots are refused", () => {
  withRoot((root) => {
    const store = open(root);
    for (const digest of ["../../../../etc/passwd", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}\n`, `ab/${"a".repeat(61)}`]) {
      assert.throws(() => store.getObject(digest), PersistenceValidationError, JSON.stringify(digest));
    }
    store.close();
  });
  for (const root of ["\0", "relative/root", "~/x", "file:///tmp", `${tmpdir()}/\0x`]) {
    assert.throws(() => open(root), PersistenceValidationError, JSON.stringify(root));
  }
});

test("recovering a torn journal tail never writes through a hard link", () => withRoot((root, parent) => {
  const store = open(root);
  store.commit(setTitle("t1", 0, "x"));
  store.close();
  const journal = file(root, PROJECT_FILES.journal);
  writeFileSync(journal, `${readFileSync(journal, "utf8")}{"torn`);
  const peer = join(parent, "journal-peer");
  linkSync(journal, peer);
  const before = readFileSync(peer, "utf8");
  // Recovery replaces the journal atomically, so the other link keeps the old bytes
  // and later appends go to the new, singly linked journal.
  const recovered = open(root);
  assert.equal(recovered.recovery.tornTailBytes, 6);
  recovered.commit(setTitle("t2", 1, "y"));
  recovered.close();
  assert.equal(readFileSync(peer, "utf8"), before, "nothing was written through the hard link");
  assert.equal(statSync(journal).nlink, 1);
}));
