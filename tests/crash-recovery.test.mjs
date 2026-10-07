import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { PROJECT_FILES, PersistenceCorruptionError, createProject, openProject } from "../packages/persistence/src/index.ts";
import { isFilesystemError, removeStaleFiles } from "../packages/persistence/src/fsio.ts";

// P06 gate 10 (#133): systematic crash-point injection. Every injected crash state either
// recovers to the last durable revision, or fails closed with a specific error; none
// opens with a wrong document.

const AT = "2026-10-07T12:00:00.000Z";
const EURO = String.fromCharCode(0x20ac);
const title = (revision) => (revision === 0 ? "start" : `rev ${revision} ${EURO}`);
const setTitle = (revision) => ({ id: `tx-${revision}`, actor: "user-1", baseRevision: revision - 1, operations: [{ type: "set-props", nodeId: "node-1", set: { title: title(revision) } }] });
const open = (root, extra = {}) => openProject(root, { owner: "writer-1", at: AT, ...extra });
const lilac = (root, name) => join(root, PROJECT_FILES.directory, name);
const temporaryName = (target) => `${target}.tmp-${4242}-${randomUUID()}`;

function tempRoot(prefix = "lilac-crash-") {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// A project with `commits` journal entries, optionally checkpointed after `checkpointAt`.
function project(commits, checkpointAt = null) {
  const root = tempRoot();
  createProject(root, { projectId: "proj-1", document: createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame", props: { title: title(0) } }] }), createdAt: AT });
  const store = open(root);
  for (let revision = 1; revision <= commits; revision += 1) {
    store.commit(setTitle(revision));
    if (revision === checkpointAt) store.checkpoint();
  }
  store.close();
  return root;
}

function withCopy(root, mutate, check) {
  const copy = tempRoot("lilac-crash-copy-");
  try {
    cpSync(root, copy, { recursive: true });
    mutate(copy);
    return check(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const lineEnds = (bytes) => [...bytes.keys()].filter((index) => bytes[index] === 0x0a).map((index) => index + 1);

// The outcome of opening: the revision and title it recovered, or the error class.
function outcome(root) {
  try {
    const store = open(root);
    const result = { revision: store.revision, title: store.document.nodes["node-1"].props.title, recovery: store.recovery };
    store.close();
    return result;
  } catch (error) {
    return { error };
  }
}

test("truncating the journal at every byte offset of its last entries recovers the last complete entry", () => {
  const root = project(6);
  try {
    const bytes = readFileSync(lilac(root, PROJECT_FILES.journal));
    const ends = lineEnds(bytes);
    assert.equal(ends.length, 6);
    let cases = 0;
    for (let offset = ends[2]; offset <= bytes.length; offset += 1) {
      const complete = ends.filter((end) => end <= offset);
      withCopy(root, (copy) => truncateSync(lilac(copy, PROJECT_FILES.journal), offset), (copy) => {
        const first = outcome(copy);
        assert.equal(first.error, undefined, `offset ${offset}: ${first.error}`);
        assert.equal(first.revision, complete.length, `offset ${offset}`);
        assert.equal(first.title, title(complete.length), `offset ${offset}`);
        assert.equal(first.recovery.tornTailBytes, offset - (complete.at(-1) ?? 0), `offset ${offset}`);
        // The repair is durable, and work continues from the recovered head.
        const store = open(copy);
        assert.equal(store.recovery.tornTailBytes, 0);
        store.commit(setTitle(store.revision + 1));
        store.close();
        assert.equal(outcome(copy).revision, complete.length + 1);
      });
      cases += 1;
    }
    assert.ok(cases > 800, `${cases} offsets`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("losing journal bytes below a checkpoint fails closed; above it recovers", () => {
  const root = project(6, 4);
  try {
    const bytes = readFileSync(lilac(root, PROJECT_FILES.journal));
    const ends = lineEnds(bytes);
    for (let offset = ends[1]; offset <= bytes.length; offset += 1) {
      const complete = ends.filter((end) => end <= offset).length;
      withCopy(root, (copy) => truncateSync(lilac(copy, PROJECT_FILES.journal), offset), (copy) => {
        const result = outcome(copy);
        if (complete < 4) {
          assert.ok(result.error instanceof PersistenceCorruptionError, `offset ${offset}: ${result.error ?? result.revision}`);
          assert.match(result.error.message, /snapshot reference points past the end of the journal/u);
        } else {
          assert.equal(result.revision, complete, `offset ${offset}`);
          assert.equal(result.title, title(complete));
        }
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a flipped byte in the last entry fails closed or, if only its terminator is lost, recovers the previous revision", () => {
  const root = project(4);
  try {
    const bytes = readFileSync(lilac(root, PROJECT_FILES.journal));
    const ends = lineEnds(bytes);
    let failedClosed = 0;
    let terminatorRecovered = false;
    for (let index = ends[2]; index < bytes.length; index += 1) {
      withCopy(root, (copy) => {
        const flipped = Buffer.from(bytes);
        flipped[index] ^= 0x20;
        writeFileSync(lilac(copy, PROJECT_FILES.journal), flipped);
      }, (copy) => {
        const result = outcome(copy);
        if (result.error !== undefined) {
          assert.ok(result.error instanceof PersistenceCorruptionError, `byte ${index}: ${result.error}`);
          failedClosed += 1;
          return;
        }
        // Only losing the terminator opens anything: the previous revision, exactly.
        assert.equal(index, bytes.length - 1, `byte ${index} opened revision ${result.revision}`);
        assert.equal(result.revision, 3);
        assert.equal(result.title, title(3));
        assert.equal(result.recovery.tornTailBytes, bytes.length - ends[2]);
        terminatorRecovered = true;
      });
    }
    assert.equal(failedClosed, bytes.length - ends[2] - 1, "every other flip fails closed");
    assert.equal(terminatorRecovered, true, "the terminator case was exercised and recovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// What an interrupted atomicWrite leaves behind: the old target intact plus a temporary
// that is empty, partially written, or complete but never renamed.
const TEMPORARY_STATES = {
  empty: () => "",
  partial: (content) => content.slice(0, Math.floor(content.length / 2)),
  complete: (content) => content,
};

test("an interrupted atomic write of the manifest, snapshot or journal recovers and clears its temporary", () => {
  const root = project(3, 2);
  try {
    for (const target of [PROJECT_FILES.manifest, PROJECT_FILES.snapshot, PROJECT_FILES.journal]) {
      for (const [state, make] of Object.entries(TEMPORARY_STATES)) {
        withCopy(root, (copy) => {
          const current = readFileSync(lilac(copy, target), "utf8");
          // A complete temporary holds what the write would have committed: a later state.
          writeFileSync(lilac(copy, temporaryName(target)), make(current.replace(/"revision":\d+/u, "\"revision\":99")));
        }, (copy) => {
          const result = outcome(copy);
          assert.equal(result.error, undefined, `${target} ${state}: ${result.error}`);
          assert.equal(result.revision, 3, `${target} ${state}`);
          assert.equal(result.title, title(3));
          assert.equal(result.recovery.staleTemporaryFiles, 1, `${target} ${state}`);
          assert.deepEqual(readdirSync(join(copy, PROJECT_FILES.directory)).filter((name) => name.includes(".tmp-")), []);
          assert.equal(outcome(copy).recovery.staleTemporaryFiles, 0, "nothing left for the next open");
        });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkpoint interrupted before its snapshot reference moved, and an interrupted object write, recover", () => {
  const root = project(3);
  try {
    withCopy(root, (copy) => {
      // The checkpoint wrote its document object, then crashed before the snapshot
      // reference was replaced: restore the old reference, so the new object is an orphan.
      const snapshotPath = lilac(copy, PROJECT_FILES.snapshot);
      const before = readFileSync(snapshotPath);
      const store = open(copy);
      store.checkpoint();
      store.close();
      writeFileSync(snapshotPath, before);
      // An object write that crashed leaves a temporary in its fan-out directory.
      const objects = lilac(copy, PROJECT_FILES.objects);
      const fanOut = readdirSync(objects).find((name) => /^[0-9a-f]{2}$/u.test(name));
      writeFileSync(join(objects, fanOut, temporaryName(readdirSync(join(objects, fanOut))[0])), "half an object");
    }, (copy) => {
      const result = outcome(copy);
      assert.equal(result.revision, 3);
      assert.equal(result.title, title(3));
      assert.equal(result.recovery.replayedEntries, 3, "the previous snapshot is used and the journal replayed");
      assert.equal(result.recovery.staleTemporaryFiles, 1);
      const objectCount = readdirSync(lilac(copy, PROJECT_FILES.objects)).flatMap((dir) => readdirSync(join(lilac(copy, PROJECT_FILES.objects), dir))).length;
      assert.equal(objectCount, 2, "the orphaned object is kept: it may be referenced later");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a torn-tail repair interrupted mid-rewrite is redone on the next open", () => {
  const root = project(3);
  try {
    withCopy(root, (copy) => {
      const journal = lilac(copy, PROJECT_FILES.journal);
      const intact = readFileSync(journal);
      writeFileSync(journal, Buffer.concat([intact, Buffer.from("{\"seq\":4,\"rev", "utf8")]));
      // The repair's own atomic write was interrupted: its temporary holds the intact bytes.
      writeFileSync(lilac(copy, temporaryName(PROJECT_FILES.journal)), intact);
    }, (copy) => {
      const result = outcome(copy);
      assert.equal(result.revision, 3);
      assert.equal(result.recovery.tornTailBytes, 13);
      assert.equal(result.recovery.staleTemporaryFiles, 1);
      assert.equal(outcome(copy).recovery.tornTailBytes, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a migration interrupted before its manifest rename migrates again", () => {
  const root = project(1);
  try {
    withCopy(root, (copy) => {
      const manifestPath = lilac(copy, PROJECT_FILES.manifest);
      const current = JSON.parse(readFileSync(manifestPath, "utf8"));
      const { documentId, ...legacy } = current;
      writeFileSync(manifestPath, JSON.stringify({ ...legacy, schemaVersion: 0, rootDocument: documentId }));
      writeFileSync(lilac(copy, temporaryName(PROJECT_FILES.manifest)), JSON.stringify(current));
    }, (copy) => {
      const migrations = { 0: ({ rootDocument, ...rest }) => ({ ...rest, documentId: rootDocument }) };
      const store = open(copy, { migrations });
      assert.equal(store.recovery.migratedFrom, 0);
      assert.equal(store.recovery.staleTemporaryFiles, 1);
      assert.equal(store.revision, 1);
      store.close();
      const again = open(copy);
      assert.equal(again.recovery.migratedFrom, null);
      again.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup removes only regular files named as a known target's temporary", () => {
  const root = project(1);
  try {
    withCopy(root, (copy) => {
      const dir = join(copy, PROJECT_FILES.directory);
      mkdirSync(join(dir, temporaryName(PROJECT_FILES.snapshot)));
      symlinkSync(join(copy, "outside.txt"), join(dir, temporaryName(PROJECT_FILES.journal)));
      writeFileSync(join(copy, "outside.txt"), "keep");
      writeFileSync(join(dir, "notes.tmp-1-not-a-uuid"), "keep");
      writeFileSync(join(dir, temporaryName("unknown.json")), "keep");
      // In the object store: a symlinked fan-out directory, a non-hex directory and the
      // objects root itself are never scanned.
      const outside = join(copy, "outside-objects");
      mkdirSync(outside);
      writeFileSync(join(outside, temporaryName("a".repeat(62))), "keep");
      symlinkSync(outside, join(dir, PROJECT_FILES.objects, "ab"));
      mkdirSync(join(dir, PROJECT_FILES.objects, "zz"));
      writeFileSync(join(dir, PROJECT_FILES.objects, "zz", temporaryName("b".repeat(62))), "keep");
      writeFileSync(join(dir, PROJECT_FILES.objects, temporaryName("c".repeat(62))), "keep");
    }, (copy) => {
      const result = outcome(copy);
      assert.equal(result.revision, 1);
      assert.equal(result.recovery.staleTemporaryFiles, 0);
      assert.equal(readdirSync(join(copy, PROJECT_FILES.directory)).filter((name) => name.includes(".tmp-")).length, 4, "directory, symlink and foreign names stay");
      assert.equal(readFileSync(join(copy, "outside.txt"), "utf8"), "keep");
      assert.equal(readdirSync(join(copy, "outside-objects")).length, 1, "a symlinked fan-out directory is not followed");
      assert.equal(readdirSync(join(copy, PROJECT_FILES.directory, PROJECT_FILES.objects, "zz")).length, 1);
      assert.equal(readdirSync(join(copy, PROJECT_FILES.directory, PROJECT_FILES.objects)).filter((name) => name.includes(".tmp-")).length, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock file left empty or partial by a crash fails closed until explicitly overridden", () => {
  const root = project(1);
  try {
    for (const content of ["", "{\"owner\":\"writer-1\",\"pi"]) {
      withCopy(root, (copy) => writeFileSync(lilac(copy, PROJECT_FILES.lock), content), (copy) => {
        const refused = outcome(copy);
        assert.equal(refused.error?.name, "PersistenceLockError", JSON.stringify(content));
        const store = open(copy, { breakStaleLock: { reason: "the writer crashed while creating its lock" } });
        assert.equal(store.revision, 1);
        assert.equal(store.recovery.lockOverride.previous, null, "an unreadable lock has no previous owner");
        store.close();
        assert.equal(outcome(copy).revision, 1);
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock override interrupted after renaming the stale lock aside leaves nothing behind", () => {
  const root = project(1);
  try {
    withCopy(root, (copy) => writeFileSync(lilac(copy, `${PROJECT_FILES.lock}.broken-${randomUUID()}`), "{\"owner\":\"writer-0\"}"), (copy) => {
      const result = outcome(copy);
      assert.equal(result.revision, 1);
      assert.equal(result.recovery.staleTemporaryFiles, 1);
      assert.deepEqual(readdirSync(join(copy, PROJECT_FILES.directory)).filter((name) => name.includes(".broken-")), []);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup absorbs only operating-system errors, never a bug", () => {
  assert.equal(isFilesystemError(Object.assign(new Error("gone"), { code: "ENOENT", errno: -2 })), true);
  let argumentError;
  try { readdirSync(undefined); } catch (error) { argumentError = error; }
  assert.equal(argumentError.code, "ERR_INVALID_ARG_TYPE");
  assert.equal(isFilesystemError(argumentError), false, "Node's argument errors are bugs");
  assert.throws(() => removeStaleFiles(undefined, () => true), TypeError);
  assert.equal(removeStaleFiles(join(tmpdir(), `lilac-missing-${randomUUID()}`), () => true), 0, "a missing directory is nothing to clean");
});
