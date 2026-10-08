import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_JOURNAL_GENESIS,
  LEGACY_PROJECT_DIRECTORY,
  PROJECT_FILES,
  PersistenceValidationError,
  PersistenceVersionError,
  createProject,
  encodeJournalLine,
  genesisDigest,
  openProject,
} from "../packages/persistence/src/index.ts";
import { createDocument } from "../packages/document-model/src/index.mjs";
import { GOLDEN_AT } from "./support/golden-project.mjs";

// N0-G2 (#190): projects written before the rename (`.lilac`, project schema 1). A root with
// only a legacy project is refused without writing; a schema-1 manifest upgrades in place and
// keeps its journal chain. tests/fixtures/projects/v1-basic is the frozen legacy corpus: the
// same history as the v2 golden fixture, written by the earlier release.

const LEGACY = fileURLToPath(new URL("./fixtures/projects/v1-basic/", import.meta.url));
const MIGRATED_MANIFEST = '{"createdAt":"2026-10-07T12:00:00.000Z","documentId":"doc-golden","format":"ninerr-project","journalGenesis":"lilac-journal-genesis","projectId":"golden-v1","schemaVersion":2}';

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
  assert.throws(() => open(root), (error) => error instanceof PersistenceVersionError && /legacy project from before Ninerr; it must be migrated/.test(error.message));
  const document = createDocument({ id: "doc-new", nodes: [] });
  assert.throws(() => createProject(root, { projectId: "new", document, createdAt: GOLDEN_AT }), (error) => error instanceof PersistenceValidationError && /legacy project exists at this root; migrate it/.test(error.message));
  assert.deepEqual(tree(root), before);
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
