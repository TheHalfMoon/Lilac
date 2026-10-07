import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  PROJECT_FILES,
  PROJECT_SCHEMA_VERSION,
  PersistenceCorruptionError,
  PersistenceValidationError,
  PersistenceVersionError,
  encodeJournalLine,
  genesisDigest,
  openProject,
} from "../packages/persistence/src/index.ts";
import { GOLDEN_AT, writeGoldenProject } from "./support/golden-project.mjs";

// P06 gate 11: version compatibility. A project written by this release (schema 1, journal
// format 1) must keep reopening byte-stably, and anything from another schema or format must
// be refused as a version problem rather than replayed with its meaning lost or reported as
// corruption.

const GOLDEN = new URL("./fixtures/projects/v1-basic/", import.meta.url).pathname;

function tempRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "lilac-compat-")));
}

function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return out;
}

function withGolden(callback) {
  const root = tempRoot();
  try {
    cpSync(GOLDEN, root, { recursive: true });
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const file = (root, name) => join(root, PROJECT_FILES.directory, name);
const open = (root, extra = {}) => openProject(root, { owner: "reader-1", at: GOLDEN_AT, ...extra });
const readJson = (root, name) => JSON.parse(readFileSync(file(root, name), "utf8"));

function journalEntries(root) {
  return readFileSync(file(root, PROJECT_FILES.journal), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).entry);
}

/** Rewrite the journal from `entries`, re-chaining so only the edited content differs. */
function writeJournal(root, entries) {
  let digest = genesisDigest(readJson(root, PROJECT_FILES.manifest).projectId);
  let text = "";
  const snapshot = readJson(root, PROJECT_FILES.snapshot);
  for (const entry of entries) {
    const encoded = encodeJournalLine(entry, digest);
    text += encoded.line;
    digest = encoded.digest;
    if (entry.seq === snapshot.journalSeq) snapshot.chainDigest = digest;
  }
  writeFileSync(file(root, PROJECT_FILES.journal), text);
  writeFileSync(file(root, PROJECT_FILES.snapshot), JSON.stringify(snapshot));
}

function editEntry(root, seq, edit) {
  const entries = journalEntries(root);
  edit(entries[seq - 1].transaction);
  writeJournal(root, entries);
}

function refused(root, ErrorType, pattern) {
  assert.throws(() => open(root), (error) => error instanceof ErrorType && pattern.test(error.message), `expected ${ErrorType.name} ${pattern}`);
  assert.equal(existsSync(file(root, PROJECT_FILES.lock)), false, "a refused open releases the lock");
}

test("the golden schema-1 project reopens to its recorded state and close leaves it byte-identical", () => withGolden((root) => {
  const before = tree(root);
  const store = open(root);
  assert.equal(store.revision, 4);
  assert.deepEqual(store.recovery, { tornTailBytes: 0, staleTemporaryFiles: 0, replayedEntries: 2, migratedFrom: null, lockOverride: null });
  assert.equal(store.document.id, "doc-golden");
  assert.deepEqual(store.document.nodes["frame-1"].children, ["text-1"]);
  assert.equal(store.document.nodes["frame-1"].props.title, "Plans");
  assert.equal(store.document.nodes["text-1"].props.text, "Hi");
  assert.equal(store.document.nodes["text-2"], undefined);
  store.close();
  assert.deepEqual(tree(root), before, "opening and closing a current project rewrites nothing");

  const writer = open(root);
  writer.commit({ id: "tx-5", actor: "user-1", baseRevision: 4, operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "Later" } }] });
  writer.close();
  const reopened = open(root);
  assert.equal(reopened.revision, 5);
  assert.equal(reopened.document.nodes["frame-1"].props.title, "Later");
  reopened.close();
}));

test("this release writes the golden fixture byte-for-byte, so the format has not drifted", () => {
  const root = tempRoot();
  try {
    writeGoldenProject(root);
    assert.deepEqual(tree(root), tree(GOLDEN));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const [path, bytes] of Object.entries(tree(GOLDEN))) {
    if (!path.startsWith(join(PROJECT_FILES.directory, PROJECT_FILES.objects))) continue;
    const name = path.split(/[\\/]/).slice(-2).join("");
    assert.equal(createHash("sha256").update(Buffer.from(bytes, "base64")).digest("hex"), name, `${path} is content-addressed`);
  }
});

test("project manifest versions: only schema 1 opens unless a registered step migrates it", () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 1);
  const cases = [
    [2, /project schema 2 is newer than supported schema 1/],
    [99, /newer than supported/],
    [0, /no migration from project schema 0/],
    [-1, /not a non-negative integer/],
    [1.5, /not a non-negative integer/],
    ["1", /not a non-negative integer/],
    [null, /not a non-negative integer/],
  ];
  for (const [schemaVersion, pattern] of cases) {
    withGolden((root) => {
      writeFileSync(file(root, PROJECT_FILES.manifest), JSON.stringify({ ...readJson(root, PROJECT_FILES.manifest), schemaVersion }));
      refused(root, PersistenceVersionError, pattern);
    });
  }
  withGolden((root) => {
    const manifest = readJson(root, PROJECT_FILES.manifest);
    const { documentId, ...legacy } = manifest;
    writeFileSync(file(root, PROJECT_FILES.manifest), JSON.stringify({ ...legacy, schemaVersion: 0, legacyRoot: documentId }));
    const store = open(root, { migrations: { 0: ({ legacyRoot, ...rest }) => ({ ...rest, documentId: legacyRoot }) } });
    assert.equal(store.recovery.migratedFrom, 0);
    assert.equal(store.revision, 4);
    store.close();
    assert.equal(readFileSync(file(root, PROJECT_FILES.manifest), "utf8"), readFileSync(join(GOLDEN, PROJECT_FILES.directory, PROJECT_FILES.manifest), "utf8"));
  });
});

test("a document object from another document schema is a version error, not corruption", () => {
  for (const [schemaVersion, pattern] of [[2, /document schema 2 is newer than supported schema 1/], [0, /no migration from document schema 0/]]) {
    withGolden((root) => {
      const snapshot = readJson(root, PROJECT_FILES.snapshot);
      const objects = join(root, PROJECT_FILES.directory, PROJECT_FILES.objects);
      const current = JSON.parse(readFileSync(join(objects, snapshot.documentObject.slice(0, 2), snapshot.documentObject.slice(2)), "utf8"));
      const bytes = Buffer.from(JSON.stringify({ ...current, schemaVersion }), "utf8");
      const digest = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(join(objects, digest.slice(0, 2)), { recursive: true });
      writeFileSync(join(objects, digest.slice(0, 2), digest.slice(2)), bytes);
      writeFileSync(file(root, PROJECT_FILES.snapshot), JSON.stringify({ ...snapshot, documentObject: digest }));
      refused(root, PersistenceVersionError, pattern);
    });
  }
});

test("journal entries using fields or operations journal format 1 lacks are refused as newer", () => {
  const cases = [
    ["an unknown transaction field", 3, (tx) => { tx.signature = "abc"; }, /journal entry 3 uses transaction field "signature".*newer Lilac/],
    ["an unknown operation type", 4, (tx) => { tx.operations.push({ type: "reparent-all", nodeId: "text-1" }); }, /journal entry 4 uses operation type "reparent-all"/],
    ["an unknown operation field", 3, (tx) => { tx.operations[0].anchor = "start"; }, /journal entry 3 uses field "anchor" on operation 0/],
    ["an unknown node field", 2, (tx) => { tx.operations[0].node.locked = true; }, /journal entry 2 uses node field "locked" on operation 0/],
    ["a newer field in an entry the snapshot already covers", 1, (tx) => { tx.priority = 1; }, /journal entry 1 uses transaction field "priority"/],
  ];
  for (const [label, seq, edit, pattern] of cases) {
    withGolden((root) => {
      editEntry(root, seq, edit);
      assert.throws(() => open(root), (error) => error instanceof PersistenceVersionError && pattern.test(error.message), label);
      assert.equal(existsSync(file(root, PROJECT_FILES.lock)), false, `${label}: a refused open releases the lock`);
    });
  }
  withGolden((root) => {
    editEntry(root, 3, () => {});
    const store = open(root);
    assert.equal(store.revision, 4, "re-chaining an unedited journal is a no-op, so the cases above isolate the edit");
    store.close();
  });
});

test("entry-level additions and malformed snapshot references stay corruption", () => {
  withGolden((root) => {
    const lines = readFileSync(file(root, PROJECT_FILES.journal), "utf8").split("\n").filter(Boolean);
    const record = JSON.parse(lines[2]);
    record.entry.flags = 1;
    lines[2] = JSON.stringify(record);
    writeFileSync(file(root, PROJECT_FILES.journal), `${lines.join("\n")}\n`);
    refused(root, PersistenceCorruptionError, /hash chain/);
  });
  for (const mutate of [(snapshot) => ({ ...snapshot, compression: "none" }), ({ revision, ...rest }) => rest]) {
    withGolden((root) => {
      writeFileSync(file(root, PROJECT_FILES.snapshot), JSON.stringify(mutate(readJson(root, PROJECT_FILES.snapshot))));
      refused(root, PersistenceCorruptionError, /snapshot reference is malformed/);
    });
  }
});

test("commit never writes an entry a journal-format-1 reader would refuse", () => withGolden((root) => {
  const journalBefore = readFileSync(file(root, PROJECT_FILES.journal));
  const store = open(root);
  try {
    const attempts = [
      { type: "set-props", nodeId: "frame-1", set: { title: "X" }, anchor: "start" },
      { type: "insert-node", node: { id: "text-9", type: "text", props: {}, locked: true }, parentId: "frame-1", index: 0 },
    ];
    for (const [index, operation] of attempts.entries()) {
      assert.throws(
        () => store.commit({ id: `bad-${index}`, actor: "user-1", baseRevision: 4, operations: [operation] }),
        (error) => error instanceof PersistenceValidationError && /journal format 1 cannot record/.test(error.message),
      );
    }
    assert.equal(store.revision, 4);
    store.commit({ id: "tx-5", actor: "user-1", baseRevision: 4, operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "Fine" } }] });
  } finally {
    store.close();
  }
  const journalAfter = readFileSync(file(root, PROJECT_FILES.journal));
  assert.deepEqual(journalAfter.subarray(0, journalBefore.length), journalBefore, "refused commits leave the journal untouched");
  assert.equal(journalEntries(root).length, 5);
  const reopened = open(root);
  assert.equal(reopened.revision, 5);
  reopened.close();
}));
