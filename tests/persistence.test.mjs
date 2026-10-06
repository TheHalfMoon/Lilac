import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmodSync, linkSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import { join } from "node:path";

import { createDocument } from "../packages/document-model/src/index.mjs";
import {
  PERSISTENCE_LIMITS,
  PERSISTENCE_PROVENANCE,
  PROJECT_FILES,
  PersistenceCorruptionError,
  PersistenceLockError,
  PersistenceValidationError,
  PersistenceVersionError,
  createProject,
  encodeJournalLine,
  genesisDigest,
  openProject,
} from "../packages/persistence/src/index.ts";

const AT = "2026-10-06T12:00:00.000Z";

function tempRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "lilac-persist-")));
}

function baseDocument() {
  return createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame", props: { title: "Before" } }] });
}

function project() {
  const root = tempRoot();
  createProject(root, { projectId: "proj-1", document: baseDocument(), createdAt: AT });
  return root;
}

function setTitle(id, baseRevision, title) {
  return { id, actor: "user-1", baseRevision, operations: [{ type: "set-props", nodeId: "node-1", set: { title } }] };
}

const file = (root, name) => join(root, PROJECT_FILES.directory, name);
const open = (root, extra = {}) => openProject(root, { owner: "writer-1", at: AT, ...extra });

function withProject(callback) {
  const root = project();
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("provenance is local-only and the package has no external dependencies", () => {
  assert.match(PERSISTENCE_PROVENANCE.posture, /No network, model, or hosted service/);
  const manifest = JSON.parse(readFileSync(new URL("../packages/persistence/package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@lilac/document-model", "@lilac/history"]);
});

test("create, open, commit, close, and reopen round-trip the document", () => withProject((root) => {
  const store = open(root);
  assert.equal(store.revision, 0);
  assert.deepEqual(store.recovery, { tornTailBytes: 0, replayedEntries: 0, migratedFrom: null, lockOverride: null });
  assert.deepEqual(store.commit(setTitle("tx-1", 0, "After")), { revision: 1, seq: 1, transactionId: "tx-1" });
  store.commit(setTitle("tx-2", 1, "Final"));
  const expected = store.document;
  store.close();
  assert.equal(existsSync(file(root, PROJECT_FILES.lock)), false);

  const reopened = open(root);
  assert.deepEqual(reopened.document, expected);
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.journalSeq, 2);
  assert.equal(reopened.recovery.replayedEntries, 2);
  assert.equal(reopened.document.nodes["node-1"].props.title, "Final");
  reopened.close();
}));

test("document copies cannot mutate store state", () => withProject((root) => {
  const store = open(root);
  const copy = store.document;
  copy.nodes["node-1"].props.title = "Tampered";
  assert.equal(store.document.nodes["node-1"].props.title, "Before");
  store.close();
}));

test("stale or invalid transactions write nothing", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "After"));
  const before = readFileSync(file(root, PROJECT_FILES.journal));
  assert.throws(() => store.commit(setTitle("tx-stale", 0, "Stale")), /Stale transaction/);
  assert.throws(() => store.commit({ id: "tx-bad", actor: "user-1", operations: [{ type: "set-props", nodeId: "missing", set: {} }] }));
  assert.deepEqual(readFileSync(file(root, PROJECT_FILES.journal)), before);
  assert.equal(store.revision, 1);
  store.close();
}));

test("checkpoint moves the snapshot so reopen replays only later entries", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  store.commit(setTitle("tx-2", 1, "Two"));
  const snapshot = store.checkpoint();
  assert.equal(snapshot.journalSeq, 2);
  store.commit(setTitle("tx-3", 2, "Three"));
  store.close();
  const reopened = open(root);
  assert.equal(reopened.recovery.replayedEntries, 1);
  assert.equal(reopened.revision, 3);
  assert.equal(reopened.document.nodes["node-1"].props.title, "Three");
  reopened.close();
}));

test("a torn journal tail is reported and removed, including inside a multi-byte character", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "After"));
  store.close();
  const journal = file(root, PROJECT_FILES.journal);
  const intact = readFileSync(journal);
  appendFileSync(journal, Buffer.concat([Buffer.from('{"digest":"ab', "utf8"), Buffer.from([0xe2, 0x82])]));
  const recovered = open(root);
  assert.equal(recovered.recovery.tornTailBytes, 15);
  assert.equal(recovered.revision, 1);
  assert.deepEqual(readFileSync(journal), intact);
  recovered.commit(setTitle("tx-2", 1, "Next"));
  recovered.close();
  const again = open(root);
  assert.equal(again.revision, 2);
  assert.equal(again.recovery.tornTailBytes, 0);
  again.close();
}));

test("a crash after commit is recovered on reopen with an explicit stale-lock override", () => withProject((root) => {
  const crashed = open(root);
  crashed.commit(setTitle("tx-1", 0, "Durable"));
  // Simulated crash: the process dies without close(), so the lock file remains.
  assert.throws(() => open(root), PersistenceLockError);
  assert.throws(() => open(root, { breakStaleLock: { reason: " " } }), PersistenceValidationError);
  const recovered = open(root, { owner: "writer-2", breakStaleLock: { reason: "previous writer process exited" } });
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.document.nodes["node-1"].props.title, "Durable");
  assert.equal(recovered.recovery.lockOverride.previous.owner, "writer-1");
  assert.equal(recovered.recovery.lockOverride.reason, "previous writer process exited");
  crashed.close();
  assert.equal(existsSync(file(root, PROJECT_FILES.lock)), true, "a stale writer must not release a lock it no longer owns");
  recovered.close();
}));

test("a durable journal entry not yet reflected in memory is replayed on reopen", () => withProject((root) => {
  const genesis = genesisDigest("proj-1");
  const transaction = { id: "tx-1", actor: "user-1", baseRevision: 0, intent: null, tool: null, timestamp: null, metadata: {}, operations: [{ type: "set-props", nodeId: "node-1", set: { title: "Appended" } }] };
  const { line } = encodeJournalLine({ seq: 1, revision: 1, transaction }, genesis);
  appendFileSync(file(root, PROJECT_FILES.journal), line);
  const store = open(root);
  assert.equal(store.revision, 1);
  assert.equal(store.document.nodes["node-1"].props.title, "Appended");
  store.close();
}));

test("second writers are refused until the first closes", () => withProject((root) => {
  const first = open(root);
  assert.throws(() => open(root, { owner: "writer-2" }), PersistenceLockError);
  first.close();
  const second = open(root, { owner: "writer-2" });
  second.close();
}));

function corruptAndExpect(mutate, pattern) {
  withProject((root) => {
    const store = open(root);
    store.commit(setTitle("tx-1", 0, "One"));
    store.commit(setTitle("tx-2", 1, "Two"));
    store.close();
    mutate(root);
    assert.throws(() => open(root), (error) => error instanceof PersistenceCorruptionError && pattern.test(error.message));
    assert.equal(existsSync(file(root, PROJECT_FILES.lock)), false, "failed opens release the lock");
  });
}

test("mid-journal corruption, chain breaks, and bad objects or manifests fail closed", () => {
  const journalLines = (root) => readFileSync(file(root, PROJECT_FILES.journal), "utf8").split("\n").filter(Boolean);
  corruptAndExpect((root) => {
    const lines = journalLines(root);
    lines[0] = lines[0].replace('"One"', '"0ne"');
    writeFileSync(file(root, PROJECT_FILES.journal), `${lines.join("\n")}\n`);
  }, /hash chain/);
  corruptAndExpect((root) => {
    const lines = journalLines(root);
    writeFileSync(file(root, PROJECT_FILES.journal), `${[lines[1], lines[0]].join("\n")}\n`);
  }, /sequence|hash chain/);
  corruptAndExpect((root) => {
    const lines = journalLines(root);
    writeFileSync(file(root, PROJECT_FILES.journal), `${lines[0]}\nnot json\n`);
  }, /not valid JSON/);
  corruptAndExpect((root) => {
    const snapshot = JSON.parse(readFileSync(file(root, PROJECT_FILES.snapshot), "utf8"));
    const objectFile = join(root, PROJECT_FILES.directory, PROJECT_FILES.objects, snapshot.documentObject.slice(0, 2), snapshot.documentObject.slice(2));
    writeFileSync(objectFile, "{}");
  }, /content hash/);
  corruptAndExpect((root) => {
    const snapshot = JSON.parse(readFileSync(file(root, PROJECT_FILES.snapshot), "utf8"));
    unlinkSync(join(root, PROJECT_FILES.directory, PROJECT_FILES.objects, snapshot.documentObject.slice(0, 2), snapshot.documentObject.slice(2)));
  }, /missing/);
  corruptAndExpect((root) => writeFileSync(file(root, PROJECT_FILES.manifest), "{not json"), /manifest is not valid JSON/);
  corruptAndExpect((root) => {
    const manifest = JSON.parse(readFileSync(file(root, PROJECT_FILES.manifest), "utf8"));
    writeFileSync(file(root, PROJECT_FILES.manifest), JSON.stringify({ ...manifest, extra: true }));
  }, /unsupported field/);
  corruptAndExpect((root) => {
    const snapshot = JSON.parse(readFileSync(file(root, PROJECT_FILES.snapshot), "utf8"));
    writeFileSync(file(root, PROJECT_FILES.snapshot), JSON.stringify({ ...snapshot, journalSeq: 9 }));
  }, /past the end/);
  corruptAndExpect((root) => writeFileSync(file(root, PROJECT_FILES.journal), Buffer.from([0xff, 0xfe, 0x0a])), /UTF-8/);
});

test("schema versions: newer is refused, older migrates through a registered step", () => withProject((root) => {
  const manifestPath = file(root, PROJECT_FILES.manifest);
  const current = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...current, schemaVersion: 2 }));
  assert.throws(() => open(root), PersistenceVersionError);

  const { documentId, ...legacy } = current;
  writeFileSync(manifestPath, JSON.stringify({ ...legacy, schemaVersion: 0, rootDocument: documentId }));
  assert.throws(() => open(root), /no migration from project schema 0/);
  const migrations = { 0: ({ rootDocument, ...rest }) => ({ ...rest, documentId: rootDocument }) };
  const store = open(root, { migrations });
  assert.equal(store.recovery.migratedFrom, 0);
  store.close();
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), current);
  const plain = open(root);
  assert.equal(plain.recovery.migratedFrom, null);
  plain.close();
}));

test("project roots and layouts are confined", () => {
  assert.throws(() => createProject("relative/path", { projectId: "p", document: baseDocument(), createdAt: AT }), PersistenceValidationError);
  assert.throws(() => openProject(join(tmpdir(), "lilac-does-not-exist-xyz"), { owner: "w", at: AT }), PersistenceValidationError);
  withProject((root) => {
    assert.throws(() => createProject(root, { projectId: "proj-2", document: baseDocument(), createdAt: AT }), /already exists/);
    assert.deepEqual(readdirSync(root), [PROJECT_FILES.directory], "failed creation leaves no staging directory");
  });
  const empty = tempRoot();
  try {
    assert.throws(() => openProject(empty, { owner: "w", at: AT }), /no Lilac project/);
    assert.throws(() => createProject(empty, { projectId: "bad id", document: baseDocument(), createdAt: AT }), PersistenceValidationError);
    assert.throws(() => createProject(empty, { projectId: "p", document: { id: "x" }, createdAt: AT }), /document is invalid/);
    assert.throws(() => openProject(empty, { owner: "w", at: "yesterday" }), PersistenceValidationError);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a symbolic-link project directory is refused", () => {
  const root = tempRoot();
  const elsewhere = tempRoot();
  try {
    createProject(elsewhere, { projectId: "proj-1", document: baseDocument(), createdAt: AT });
    symlinkSync(join(elsewhere, PROJECT_FILES.directory), join(root, PROJECT_FILES.directory), "junction");
    assert.throws(() => openProject(root, { owner: "w", at: AT }), /symbolic link/);
    assert.throws(() => createProject(root, { projectId: "p", document: baseDocument(), createdAt: AT }), /symbolic link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a symbolic-link project file is refused", (context) => withProject((root) => {
  const outside = join(tempRoot(), "elsewhere.log");
  writeFileSync(outside, "");
  unlinkSync(file(root, PROJECT_FILES.journal));
  try {
    symlinkSync(outside, file(root, PROJECT_FILES.journal), "file");
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("file symlinks need elevated privileges on this platform");
      return;
    }
    throw error;
  }
  assert.throws(() => open(root), /symbolic link/);
}));

test("oversized objects and journal entries are refused before anything is written", () => withProject((root) => {
  const store = open(root);
  assert.throws(() => store.putObject(Buffer.alloc(PERSISTENCE_LIMITS.maxObjectBytes + 1)), /exceeds/);
  const before = readFileSync(file(root, PROJECT_FILES.journal));
  assert.throws(() => store.commit(setTitle("tx-huge", 0, "x".repeat(PERSISTENCE_LIMITS.maxEntryBytes))), /journal entry exceeds/);
  assert.deepEqual(readFileSync(file(root, PROJECT_FILES.journal)), before);
  assert.equal(store.revision, 0);
  const id = store.putObject(Buffer.from("asset bytes"));
  assert.equal(store.getObject(id).toString(), "asset bytes");
  assert.equal(store.putObject(Buffer.from("asset bytes")), id);
  assert.throws(() => store.getObject("../../etc/passwd"), PersistenceValidationError);
  store.close();
  assert.throws(() => store.commit(setTitle("tx-closed", 0, "x")), /closed/);
}));

test("journal encoding is deterministic across independent projects", () => {
  const roots = [project(), project()];
  try {
    for (const root of roots) {
      const store = open(root);
      store.commit(setTitle("tx-1", 0, "Same"));
      store.close();
    }
    assert.deepEqual(readFileSync(file(roots[0], PROJECT_FILES.journal)), readFileSync(file(roots[1], PROJECT_FILES.journal)));
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("a failed journal write poisons the store until reopen", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  const journal = file(root, PROJECT_FILES.journal);
  chmodSync(journal, 0o444);
  try {
    assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")));
  } finally {
    chmodSync(journal, 0o644);
  }
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), /reopened after a failed journal write/);
  assert.throws(() => store.checkpoint(), /reopened after a failed journal write/);
  store.close();
  const reopened = open(root);
  assert.equal(reopened.revision, 1);
  reopened.commit(setTitle("tx-2", 1, "Two"));
  reopened.close();
}));

test("bytes written to the journal by anyone else stop the writer before it appends", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  appendFileSync(file(root, PROJECT_FILES.journal), '{"partial');
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), (error) => error instanceof PersistenceCorruptionError && /outside this writer/.test(error.message));
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), /reopened/);
  store.close();
  const reopened = open(root);
  assert.equal(reopened.recovery.tornTailBytes, 9);
  assert.equal(reopened.revision, 1);
  reopened.close();
}));

test("a writer whose lock was overridden can no longer write, and the override is persisted", () => withProject((root) => {
  const stale = open(root);
  const fresh = open(root, { owner: "writer-2", breakStaleLock: { reason: "first writer hung" } });
  const lock = JSON.parse(readFileSync(file(root, PROJECT_FILES.lock), "utf8"));
  assert.equal(lock.owner, "writer-2");
  assert.equal(lock.override.reason, "first writer hung");
  assert.equal(lock.override.previous.owner, "writer-1");
  assert.throws(() => stale.commit(setTitle("tx-stale", 0, "Stale")), PersistenceLockError);
  assert.throws(() => stale.checkpoint(), PersistenceLockError);
  fresh.commit(setTitle("tx-1", 0, "Fresh"));
  stale.close();
  fresh.close();
  const reopened = open(root);
  assert.equal(reopened.document.nodes["node-1"].props.title, "Fresh");
  reopened.close();
}));

test("a second writer in another process is refused", () => withProject((root) => {
  const store = open(root);
  try {
    const entry = new URL("../packages/persistence/src/index.ts", import.meta.url).href;
    const script = `import { openProject } from ${JSON.stringify(entry)};
try { openProject(${JSON.stringify(root)}, { owner: "child", at: "${AT}" }); console.log("OPENED"); }
catch (error) { console.log(error.name); }`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
    assert.equal(output, "PersistenceLockError");
  } finally {
    store.close();
  }
}));

test("a hard-linked journal is refused before any write leaves the project", () => withProject((root) => {
  const outsideDir = tempRoot();
  try {
    const store = open(root);
    linkSync(file(root, PROJECT_FILES.journal), join(outsideDir, "victim.log"));
    assert.throws(() => store.commit(setTitle("tx-1", 0, "Leak")), /hard-linked/);
    assert.equal(readFileSync(join(outsideDir, "victim.log"), "utf8"), "");
    store.close();
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
}));

test("an unterminated final line is an unacknowledged write and is recovered even if it is a complete entry", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  store.commit(setTitle("tx-2", 1, "Two"));
  store.close();
  const journal = file(root, PROJECT_FILES.journal);
  const bytes = readFileSync(journal);
  const firstLineEnd = bytes.indexOf(0x0a) + 1;
  writeFileSync(journal, bytes.subarray(0, bytes.length - 1));
  const recovered = open(root);
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.recovery.tornTailBytes, bytes.length - 1 - firstLineEnd);
  assert.deepEqual(readFileSync(journal), bytes.subarray(0, firstLineEnd));
  recovered.close();
}));

test("values JSON cannot represent are refused, and memory always equals replay", () => withProject((root) => {
  const store = open(root);
  const journal = file(root, PROJECT_FILES.journal);
  const before = readFileSync(journal);
  const props = (set) => ({ id: "tx-x", actor: "user-1", baseRevision: 0, operations: [{ type: "set-props", nodeId: "node-1", set }] });
  assert.throws(() => store.commit(props({ when: new Date(0) })), /non-plain object/);
  assert.throws(() => store.commit(props({ tags: new Map() })), /non-plain object/);
  assert.throws(() => store.commit(props({ gone: undefined })), /undefined/);
  assert.deepEqual(readFileSync(journal), before);
  assert.equal(store.revision, 0);
  store.commit(props({ zero: -0, big: 1e21, text: "line\u{2028}separator" }));
  const inMemory = store.document;
  assert.ok(Object.is(inMemory.nodes["node-1"].props.zero, 0));
  store.close();
  const reopened = open(root);
  assert.deepEqual(reopened.document, inMemory);
  reopened.close();
}));

test("an existing .lilac of any kind is never replaced by project creation", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, PROJECT_FILES.directory), "USER DATA");
    assert.throws(() => createProject(root, { projectId: "p", document: baseDocument(), createdAt: AT }), /already exists/);
    assert.equal(readFileSync(join(root, PROJECT_FILES.directory), "utf8"), "USER DATA");
    assert.deepEqual(readdirSync(root), [PROJECT_FILES.directory]);
    rmSync(join(root, PROJECT_FILES.directory));
    mkdirSync(join(root, PROJECT_FILES.directory));
    assert.throws(() => createProject(root, { projectId: "p", document: baseDocument(), createdAt: AT }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a closed store refuses every read and write", () => withProject((root) => {
  const store = open(root);
  store.close();
  assert.throws(() => store.revision, /closed/);
  assert.throws(() => store.journalSeq, /closed/);
  assert.throws(() => store.document, /closed/);
  assert.throws(() => store.checkpoint(), /closed/);
}));

test("lock identity includes a per-acquisition nonce, so a same-owner stale store cannot write or release", () => withProject((root) => {
  const stale = open(root);
  const fresh = open(root, { breakStaleLock: { reason: "same owner reopened" } });
  assert.throws(() => stale.commit(setTitle("tx-stale", 0, "Stale")), PersistenceLockError);
  assert.throws(() => stale.checkpoint(), PersistenceLockError);
  assert.throws(() => stale.putObject(Buffer.from("x")), PersistenceLockError);
  stale.close();
  assert.equal(existsSync(file(root, PROJECT_FILES.lock)), true);
  fresh.commit(setTitle("tx-1", 0, "Fresh"));
  fresh.close();
}));

test("a journal replaced while open is detected even when sizes match", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  const journal = file(root, PROJECT_FILES.journal);
  const size = readFileSync(journal).length;
  const impostor = join(root, PROJECT_FILES.directory, "impostor.log");
  writeFileSync(impostor, `${"x".repeat(size - 1)}${String.fromCharCode(10)}`);
  rmSync(journal);
  writeFileSync(journal, readFileSync(impostor));
  rmSync(impostor);
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), /replaced or modified outside this writer/);
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), /reopened/);
  store.close();
}));

test("a deleted journal and a non-file lock path fail with typed errors", () => withProject((root) => {
  const store = open(root);
  rmSync(file(root, PROJECT_FILES.journal));
  assert.throws(() => store.commit(setTitle("tx-1", 0, "One")), (error) => error instanceof PersistenceCorruptionError && /journal is missing/.test(error.message));
  store.close();
  writeFileSync(file(root, PROJECT_FILES.journal), "");
  mkdirSync(file(root, PROJECT_FILES.lock));
  assert.throws(() => open(root, { breakStaleLock: { reason: "lock is a directory" } }), /not a regular file/);
  assert.equal(readdirSync(join(root, PROJECT_FILES.directory)).some((name) => name.startsWith("lock.broken-")), false);
}));

test("an in-place rewrite of the journal with identical size and inode is detected", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  const journal = file(root, PROJECT_FILES.journal);
  const bytes = readFileSync(journal);
  const altered = Buffer.from(bytes);
  altered[altered.indexOf(0x4f)] = 0x30;
  writeFileSync(journal, altered);
  assert.equal(readFileSync(journal).length, bytes.length);
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), /replaced or modified outside this writer/);
  store.close();
  assert.throws(() => open(root), PersistenceCorruptionError);
}));

test("appendDurable refuses a same-size, same-inode journal whose content differs from the pin", async () => {
  // appendDurable is internal (not exported from the package index); this unit test pins its content check directly.
  const { appendDurable, fileIdentity } = await import("../packages/persistence/src/fsio.ts");
  const { createHash } = await import("node:crypto");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilac-append-")));
  try {
    const path = join(dir, "journal.log");
    writeFileSync(path, "line-A\n");
    const identity = fileIdentity(path, "journal");
    const sha256 = (text) => createHash("sha256").update(text).digest("hex");
    assert.throws(
      () => appendDurable(path, "line-B\n", "journal", { size: 7, identity, sha256: sha256("line-Z\n") }),
      (error) => error instanceof PersistenceCorruptionError && /replaced or modified outside this writer/.test(error.message),
    );
    assert.equal(readFileSync(path, "utf8"), "line-A\n", "nothing is written on a content mismatch");
    assert.throws(
      () => appendDurable(path, "line-B\n", "journal", { size: 6, identity, sha256: sha256("line-A\n") }),
      /changed outside this writer \(expected 6 bytes, found 7\)/,
    );
    appendDurable(path, "line-B\n", "journal", { size: 7, identity, sha256: sha256("line-A\n") });
    assert.equal(readFileSync(path, "utf8"), "line-A\nline-B\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-size rewrite after open and before the first commit is detected", () => withProject((root) => {
  const first = open(root);
  first.commit(setTitle("tx-1", 0, "One"));
  first.close();
  const store = open(root);
  const journal = file(root, PROJECT_FILES.journal);
  const altered = Buffer.from(readFileSync(journal));
  altered[altered.indexOf(0x4f)] = 0x30;
  writeFileSync(journal, altered);
  assert.throws(() => store.commit(setTitle("tx-2", 1, "Two")), /replaced or modified outside this writer/);
  store.close();
}));

test("metadata-only journal changes do not refuse commits", () => withProject((root) => {
  const store = open(root);
  store.commit(setTitle("tx-1", 0, "One"));
  const journal = file(root, PROJECT_FILES.journal);
  utimesSync(journal, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
  store.commit(setTitle("tx-2", 1, "Two"));
  store.close();
  const reopened = open(root);
  assert.equal(reopened.revision, 2);
  reopened.close();
}));
