import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_JOURNAL_GENESIS,
  LEGACY_PROJECT_DIRECTORY,
  PROJECT_FILES,
  PersistenceCorruptionError,
  PersistenceLockError,
  PersistenceValidationError,
  PersistenceVersionError,
  createProject,
  encodeJournalLine,
  genesisDigest,
  migrateLegacyProject,
  openProject,
  projectLayout,
} from "../packages/persistence/src/index.ts";
import { createDocument } from "../packages/document-model/src/index.mjs";
import { GOLDEN_AT } from "./support/golden-project.mjs";

// N0-G2 (#190): projects written before the rename (`.lilac`, project schema 1) migrate into
// `.ninerr` deterministically, keep their journal chain, and are never modified; a refused
// migration creates nothing. tests/fixtures/projects/v1-basic is the frozen legacy corpus:
// the same history as the v2 golden fixture, written by the earlier release.

const LEGACY = fileURLToPath(new URL("./fixtures/projects/v1-basic/", import.meta.url));
const CURRENT = fileURLToPath(new URL("./fixtures/projects/v2-basic/", import.meta.url));
const MIGRATED_MANIFEST = '{"createdAt":"2026-10-07T12:00:00.000Z","documentId":"doc-golden","format":"ninerr-project","journalGenesis":"lilac-journal-genesis","projectId":"golden-v1","schemaVersion":2}';
const actor = { owner: "migrator-1", at: GOLDEN_AT };

function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path).split("\\").join("/")] = readFileSync(path).toString("base64");
    }
  };
  walk(root);
  return out;
}

function withRoot(callback, source = LEGACY) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-legacy-")));
  try {
    cpSync(source, root, { recursive: true });
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const legacyFile = (root, name) => join(root, LEGACY_PROJECT_DIRECTORY, name);
const currentFile = (root, name) => join(root, PROJECT_FILES.directory, name);
const open = (root) => openProject(root, { owner: "reader-1", at: GOLDEN_AT });
const subtree = (all, prefix) => Object.fromEntries(Object.entries(all).filter(([path]) => path.startsWith(`${prefix}/`)).map(([path, bytes]) => [path.slice(prefix.length + 1), bytes]));

/** Rewrite a legacy journal from `entries` on the legacy chain, as the earlier release would. */
function rewriteLegacyJournal(root, edit) {
  const entries = readFileSync(legacyFile(root, PROJECT_FILES.journal), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).entry);
  edit(entries);
  const snapshot = JSON.parse(readFileSync(legacyFile(root, PROJECT_FILES.snapshot), "utf8"));
  let digest = genesisDigest("golden-v1", LEGACY_JOURNAL_GENESIS);
  let text = "";
  for (const entry of entries) {
    const encoded = encodeJournalLine(entry, digest);
    text += encoded.line;
    digest = encoded.digest;
    if (entry.seq === snapshot.journalSeq) snapshot.chainDigest = digest;
  }
  writeFileSync(legacyFile(root, PROJECT_FILES.journal), text);
  writeFileSync(legacyFile(root, PROJECT_FILES.snapshot), JSON.stringify(snapshot));
}

test("a legacy project is recognized, and opening or creating over it is refused without writing", () => withRoot((root) => {
  const before = tree(root);
  assert.equal(projectLayout(root), "legacy");
  assert.throws(() => open(root), (error) => error instanceof PersistenceVersionError && /legacy project from before Ninerr; migrate it/.test(error.message));
  const document = createDocument({ id: "doc-new", nodes: [] });
  assert.throws(() => createProject(root, { projectId: "new", document, createdAt: GOLDEN_AT }), (error) => error instanceof PersistenceValidationError && /legacy project exists at this root; migrate it/.test(error.message));
  assert.deepEqual(tree(root), before);
}));

test("migration copies the legacy project exactly, records its genesis domain, and leaves it untouched", () => withRoot((root) => {
  const legacyBefore = subtree(tree(root), LEGACY_PROJECT_DIRECTORY);
  const report = migrateLegacyProject(root, actor);
  assert.deepEqual({ ...report, projectDir: relative(root, report.projectDir), legacyDir: relative(root, report.legacyDir) }, {
    projectDir: PROJECT_FILES.directory,
    legacyDir: LEGACY_PROJECT_DIRECTORY,
    migratedFrom: 1,
    objectsCopied: 2,
    tornTailBytes: 0,
  });
  const after = tree(root);
  assert.deepEqual(subtree(after, LEGACY_PROJECT_DIRECTORY), legacyBefore, "the legacy directory is byte-identical");
  const migrated = subtree(after, PROJECT_FILES.directory);
  assert.equal(Buffer.from(migrated[PROJECT_FILES.manifest], "base64").toString("utf8"), MIGRATED_MANIFEST);
  const { [PROJECT_FILES.manifest]: _manifest, ...rest } = migrated;
  const { [PROJECT_FILES.manifest]: _legacyManifest, ...legacyRest } = legacyBefore;
  assert.deepEqual(rest, legacyRest, "journal, snapshot and objects are byte-identical copies");
  assert.equal(projectLayout(root), "current");

  const store = open(root);
  assert.equal(store.revision, 5);
  assert.equal(store.recovery.migratedFrom, null, "the migrated manifest is already current");
  assert.equal(store.manifest.journalGenesis, LEGACY_JOURNAL_GENESIS);
  store.close();
}));

test("a migrated project equals the same history written by this release, and keeps its chain as it grows", () => {
  const reference = withRoot((root) => {
    const store = open(root);
    try {
      return store.document;
    } finally {
      store.close();
    }
  }, CURRENT);
  withRoot((root) => {
    migrateLegacyProject(root, actor);
    let store = open(root);
    assert.deepEqual(store.document, reference, "the migrated document equals the v2 golden document");
    store.commit({ id: "tx-6", actor: "user-1", baseRevision: 5, operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "After migration" } }] });
    store.checkpoint();
    store.commit({ id: "tx-7", actor: "user-1", baseRevision: 6, operations: [{ type: "set-props", nodeId: "text-1", set: { text: "Again" } }] });
    store.close();
    const legacyJournal = readFileSync(legacyFile(root, PROJECT_FILES.journal));
    assert.deepEqual(readFileSync(currentFile(root, PROJECT_FILES.journal)).subarray(0, legacyJournal.length), legacyJournal, "new entries extend the legacy chain");
    store = open(root);
    assert.equal(store.revision, 7);
    assert.equal(store.document.nodes["frame-1"].props.title, "After migration");
    store.close();
  });
});

test("migration is deterministic", () => {
  const run = () => withRoot((root) => {
    migrateLegacyProject(root, actor);
    return subtree(tree(root), PROJECT_FILES.directory);
  });
  assert.deepEqual(run(), run());
});

test("refused migrations create nothing and leave the legacy project as it was", () => {
  const cases = [
    ["a newer legacy schema", (root) => {
      const manifest = JSON.parse(readFileSync(legacyFile(root, PROJECT_FILES.manifest), "utf8"));
      writeFileSync(legacyFile(root, PROJECT_FILES.manifest), JSON.stringify({ ...manifest, schemaVersion: 3 }));
    }, PersistenceVersionError, /project schema 3 is newer than supported schema 2/],
    ["a corrupt journal", (root) => {
      const lines = readFileSync(legacyFile(root, PROJECT_FILES.journal), "utf8").split("\n");
      lines[1] = lines[1].replace("World", "Earth");
      writeFileSync(legacyFile(root, PROJECT_FILES.journal), lines.join("\n"));
    }, PersistenceCorruptionError, /hash chain/],
    ["a wrong legacy format", (root) => {
      const manifest = JSON.parse(readFileSync(legacyFile(root, PROJECT_FILES.manifest), "utf8"));
      writeFileSync(legacyFile(root, PROJECT_FILES.manifest), JSON.stringify({ ...manifest, format: "other-project" }));
    }, PersistenceCorruptionError, /schema-1 manifest must have the legacy project format/],
    ["a current-schema manifest in the legacy directory", (root) => {
      writeFileSync(legacyFile(root, PROJECT_FILES.manifest), MIGRATED_MANIFEST);
    }, PersistenceCorruptionError, /holds a current-schema manifest/],
    ["an object that does not match its hash", (root) => {
      // The initial document object; the snapshot references the other one, so only the copy reads it.
      const [fanOut, name] = ["f8", "b846df15c76042d2c88127d181a84e316e5fb4945734460bcbb3dba80b35ae"];
      const objects = legacyFile(root, PROJECT_FILES.objects);
      const snapshot = JSON.parse(readFileSync(legacyFile(root, PROJECT_FILES.snapshot), "utf8"));
      assert.notEqual(`${fanOut}${name}`, snapshot.documentObject, "the damaged object is not the snapshot document, so only the copy finds it");
      writeFileSync(join(objects, fanOut, name), "damaged");
    }, PersistenceCorruptionError, /does not match its content hash/],
    ["a newer journal format", (root) => rewriteLegacyJournal(root, (entries) => { entries[3].transaction.signature = "abc"; }), PersistenceVersionError, /journal entry 4 uses transaction field "signature"/],
  ];
  for (const [label, damage, ErrorType, pattern] of cases) {
    withRoot((root) => {
      damage(root);
      const before = tree(root);
      assert.throws(() => migrateLegacyProject(root, actor), (error) => error instanceof ErrorType && pattern.test(error.message), label);
      assert.deepEqual(tree(root), before, `${label}: nothing is created or changed`);
      assert.equal(projectLayout(root), "legacy", label);
    });
  }
});

test("a locked legacy project, an existing Ninerr project, or no legacy project refuses migration", () => {
  withRoot((root) => {
    writeFileSync(legacyFile(root, PROJECT_FILES.lock), JSON.stringify({ owner: "lilac-app", pid: 1, at: GOLDEN_AT, nonce: "n" }));
    const before = tree(root);
    assert.throws(() => migrateLegacyProject(root, actor), PersistenceLockError);
    assert.deepEqual(tree(root), before, "the earlier release's lock is left in place");
  });
  withRoot((root) => {
    migrateLegacyProject(root, actor);
    assert.throws(() => migrateLegacyProject(root, actor), (error) => error instanceof PersistenceValidationError && /Ninerr project already exists/.test(error.message));
  });
  withRoot((root) => {
    assert.equal(projectLayout(root), "current");
    assert.throws(() => migrateLegacyProject(root, actor), (error) => error instanceof PersistenceValidationError && /Ninerr project already exists/.test(error.message));
  }, CURRENT);
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-legacy-")));
  try {
    assert.equal(projectLayout(empty), "none");
    assert.throws(() => migrateLegacyProject(empty, actor), (error) => error instanceof PersistenceValidationError && /no legacy project exists/.test(error.message));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a torn legacy tail is carried over and recovered by the first open; stale temporaries are not copied", () => withRoot((root) => {
  appendFileSync(legacyFile(root, PROJECT_FILES.journal), '{"digest":"torn');
  writeFileSync(legacyFile(root, `${PROJECT_FILES.snapshot}.tmp-1-0`), "stale");
  const report = migrateLegacyProject(root, actor);
  assert.equal(report.tornTailBytes, 15);
  assert.equal(existsSync(currentFile(root, `${PROJECT_FILES.snapshot}.tmp-1-0`)), false);
  const store = open(root);
  assert.equal(store.recovery.tornTailBytes, 15);
  assert.equal(store.revision, 5);
  store.close();
  assert.ok(readFileSync(legacyFile(root, PROJECT_FILES.journal), "utf8").endsWith('{"digest":"torn'), "the legacy journal keeps its tail");
}));

/** A schema-1 project placed directly in `.ninerr` (copied by hand) upgrades in place. */
function legacyInCurrentDirectory(root) {
  renameSync(join(root, LEGACY_PROJECT_DIRECTORY), join(root, PROJECT_FILES.directory));
}

test("a schema-1 manifest in the current directory upgrades in place, with host steps for earlier versions", () => {
  withRoot((root) => {
    legacyInCurrentDirectory(root);
    const store = open(root);
    assert.equal(store.recovery.migratedFrom, 1);
    assert.equal(store.revision, 5);
    store.close();
    assert.equal(readFileSync(currentFile(root, PROJECT_FILES.manifest), "utf8"), MIGRATED_MANIFEST);
  });
  withRoot((root) => {
    legacyInCurrentDirectory(root);
    const { documentId, ...manifest } = JSON.parse(readFileSync(currentFile(root, PROJECT_FILES.manifest), "utf8"));
    writeFileSync(currentFile(root, PROJECT_FILES.manifest), JSON.stringify({ ...manifest, schemaVersion: 0, legacyRoot: documentId }));
    const store = openProject(root, { owner: "reader-1", at: GOLDEN_AT, migrations: { 0: ({ legacyRoot, ...rest }) => ({ ...rest, documentId: legacyRoot }), 1: () => ({}) } });
    assert.equal(store.recovery.migratedFrom, 0, "a host step runs, and the built-in step wins for its own version");
    store.close();
    assert.equal(readFileSync(currentFile(root, PROJECT_FILES.manifest), "utf8"), MIGRATED_MANIFEST);
  });
});

test("a refused open leaves a legacy-schema project as it found it, even when the migration and a repair were due", () => withRoot((root) => {
  rewriteLegacyJournal(root, (entries) => { entries[3].transaction.signature = "abc"; });
  appendFileSync(legacyFile(root, PROJECT_FILES.journal), '{"digest":"torn');
  legacyInCurrentDirectory(root);
  const before = tree(root);
  assert.throws(() => open(root), (error) => error instanceof PersistenceVersionError && /journal entry 4 uses transaction field "signature"/.test(error.message));
  assert.deepEqual(tree(root), before);
}));

test("the frozen legacy corpus is unchanged", () => {
  assert.deepEqual(Object.keys(tree(LEGACY)), [
    ".lilac/journal.log",
    ".lilac/objects/ee/d19d67df2a78916b14b192f3d1c1e94beec32fb42f2778894acb030ceb54fb",
    ".lilac/objects/f8/b846df15c76042d2c88127d181a84e316e5fb4945734460bcbb3dba80b35ae",
    ".lilac/project.json",
    ".lilac/snapshot.json",
  ]);
  assert.equal(readFileSync(join(LEGACY, ".lilac/project.json"), "utf8"), '{"createdAt":"2026-10-07T12:00:00.000Z","documentId":"doc-golden","format":"lilac-project","projectId":"golden-v1","schemaVersion":1}');
});
