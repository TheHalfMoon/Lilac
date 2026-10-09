import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocument, serializeDocument, validateDocument } from "../packages/document-model/src/index.mjs";
import { PERSISTENCE_LIMITS, PROJECT_FILES, PersistenceError, PersistenceLockError, createProject, openProject } from "../packages/persistence/src/index.ts";
import { hostPool } from "./support/host-api.mjs";
import { createPrng, positiveIntegerFromEnv, propertySeeds } from "./support/prng.mjs";
import { generatedEdit } from "./support/reference-model.mjs";

// P08-G3a (#230, founder section P08.3): the project store under generated damage. Each seed
// builds a real project (a checkpoint part-way, so the snapshot and the journal both matter),
// keeping the document after every journal length. Then each case copies it, damages it, and
// opens it. The damage: bytes flipped, inserted or removed, truncation, text appended, a file
// emptied, deleted or replaced by a directory; journal lines swapped, repeated or dropped; a
// byte flipped in the last line only (what a crash mid-append leaves); a JSON value changed,
// removed or added; values only a hash can tell (a name inside a journal line, inside the
// snapshot's object); another encoding (a byte-order mark, CRLF lines, UTF-16, a lone
// surrogate); a file over the store's limits; an unknown extra file; a missing object
// directory; and a lock held by someone else. The store must fail closed:
// - a refused open throws the store's own typed error and leaves every file exactly as it
//   found it (a foreign lock stays, and no lock of ours is left);
// - an open that succeeds yields a valid document the project really held: the latest, or the
//   very one an earlier journal length gave, and only when what is left of the journal is a
//   prefix of it (its end was cut). A cut through a line is repaired and reported; a cut
//   between whole lines cannot be told from changes never made (#239);
// - opening the result again gives the very same document: recovery is deterministic;
// - through the studio host, every fifth case answers a typed refusal (422, or 409 for a
//   lock) that also changes nothing, never a 500, or opens the very document the store opens.
// NINERR_FUZZ_RUNS sets the number of seeds (default 4) and NINERR_FUZZ_CASES the damaged
// copies per seed (default 60); NINERR_PROPERTY_SEED=<seed> replays one seed.

const RUNS = positiveIntegerFromEnv("NINERR_FUZZ_RUNS", 4);
const CASES = positiveIntegerFromEnv("NINERR_FUZZ_CASES", 60);
const AT = "2026-10-09T12:00:00.000Z";
const open = (root) => openProject(root, { owner: "fuzz", at: AT });
const store = (root) => join(root, PROJECT_FILES.directory);
const objectPath = (digest) => `${PROJECT_FILES.objects}/${digest.slice(0, 2)}/${digest.slice(2)}`;
const FOREIGN_LOCK = JSON.stringify({ owner: "someone-else", pid: 1, at: AT, nonce: "foreign" });
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();

/** Every entry of the store, by path relative to it: a file's bytes, or "<directory>". */
function snapshotFiles(root, { withLock = false } = {}) {
  const files = {};
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        files[relative] = "<directory>";
        walk(join(directory, entry.name), relative);
      } else if (withLock || relative !== PROJECT_FILES.lock) files[relative] = readFileSync(join(directory, entry.name)).toString("base64");
    }
  };
  walk(store(root), "");
  return files;
}

/**
 * A real project: generated edits with a checkpoint part-way. Returns the document after each
 * journal length (in bytes), so an earlier state can be checked against the exact one it
 * must be, and the latest document.
 */
function buildProject(prng, root) {
  mkdirSync(root);
  createProject(root, { projectId: "fuzz-project", document: createDocument({ id: "fuzz-doc", nodes: [] }), createdAt: AT });
  const project = open(root);
  const journal = join(store(root), PROJECT_FILES.journal);
  const byLength = new Map([[0, serializeDocument(project.document)]]);
  const counter = { next: 0 };
  const edits = prng.int(8, 20);
  const checkpointAt = prng.int(2, edits - 2);
  let checkpointed = false;
  try {
    for (let index = 0; index < edits; index += 1) {
      const edit = generatedEdit(prng, project.document, counter);
      try {
        project.commit({ id: `tx-${index}`, actor: "fuzz-user", baseRevision: project.revision, intent: edit.intent, operations: edit.operations });
      } catch {
        continue; // a generated edit that is invalid here (a cycle, an index past the end)
      }
      byLength.set(readFileSync(journal).length, serializeDocument(project.document));
      // At the first edit that commits at or after the chosen point.
      if (!checkpointed && index >= checkpointAt) {
        project.checkpoint();
        checkpointed = true;
      }
    }
    if (!checkpointed) project.checkpoint();
    return { byLength, latest: serializeDocument(project.document) };
  } finally {
    project.close();
  }
}

const JSON_FILES = [PROJECT_FILES.manifest, PROJECT_FILES.snapshot];
const TEXT_KINDS = ["bom", "crlf", "utf16", "lone-surrogate"];

/**
 * Damage the store at `root` in one way; returns what was done, for the failure message. With
 * `filesOnly`, only a file is damaged (the second damage beside leftovers).
 */
function damage(prng, root, { filesOnly = false } = {}) {
  const entries = snapshotFiles(root);
  const files = Object.keys(entries).filter((name) => entries[name] !== "<directory>");
  const objects = files.filter((name) => name.startsWith(`${PROJECT_FILES.objects}/`));
  const used = JSON.parse(readFileSync(join(store(root), PROJECT_FILES.snapshot), "utf8")).documentObject;
  const referenced = objects.filter((name) => name === objectPath(used));
  const scope = filesOnly ? "file" : prng.pick(["file", "file", "file", "file", "file", "store"]);
  if (scope === "store") {
    // The shape of the store itself.
    const kind = prng.pick(["foreign-lock", "extra-file", "missing-fan-out", "leftovers", "leftovers"]);
    if (kind === "leftovers") {
      // What an interrupted write and an interrupted lock override leave, beside other damage:
      // a refused open must keep them (#241); an open that succeeds clears and counts them.
      const hex = (length) => Array.from({ length }, () => prng.int(0, 15).toString(16)).join("");
      const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
      writeFileSync(join(store(root), `${PROJECT_FILES.snapshot}.tmp-4242-${uuid()}`), "an interrupted write");
      writeFileSync(join(store(root), `${PROJECT_FILES.lock}.broken-${uuid()}`), "{}");
      return `leftovers, and ${damage(prng, root, { filesOnly: true })}`;
    }
    if (kind === "foreign-lock") writeFileSync(join(store(root), PROJECT_FILES.lock), FOREIGN_LOCK);
    else if (kind === "extra-file") writeFileSync(join(store(root), prng.pick(["notes.txt", "journal.log.bak", ".DS_Store"])), "unrelated");
    else rmSync(join(store(root), PROJECT_FILES.objects, used.slice(0, 2)), { recursive: true, force: true });
    return kind;
  }
  const target = prng.pick([PROJECT_FILES.manifest, PROJECT_FILES.snapshot, PROJECT_FILES.journal, PROJECT_FILES.journal, ...(objects.length > 0 ? [prng.pick(objects)] : []), ...referenced]);
  const path = join(store(root), ...target.split("/"));
  const bytes = readFileSync(path);
  const kinds = ["flip", "insert", "remove", "truncate", "append", "empty", "delete", "directory", ...TEXT_KINDS, "oversize"];
  // A value inside one journal line changed, the line still valid JSON: only the hash chain can tell.
  if (target === PROJECT_FILES.journal) kinds.push("swap-lines", "repeat-line", "drop-line", "flip-last-line", "line-value", "line-value");
  if (JSON_FILES.includes(target)) kinds.push("json-change", "json-remove", "json-add");
  // An object the snapshot uses, its text changed but still valid, canonical JSON: only its
  // content hash can tell.
  if (target === objectPath(used)) kinds.push("object-value", "object-value");
  const kind = prng.pick(kinds);
  if (kind === "delete" || kind === "directory") {
    rmSync(path);
    if (kind === "directory") mkdirSync(path);
    return `${kind} ${target}`;
  }
  const at = bytes.length === 0 ? 0 : prng.int(0, bytes.length - 1);
  let next;
  switch (kind) {
    case "flip": {
      next = Buffer.from(bytes);
      if (next.length > 0) next[at] ^= 1 << prng.int(0, 7);
      break;
    }
    case "insert":
      next = Buffer.concat([bytes.subarray(0, at), Buffer.from(prng.pick(["\n", "{", "\"", "\u0000", "é", "}\n{\"seq\":1}"]), "utf8"), bytes.subarray(at)]);
      break;
    case "remove":
      next = Buffer.concat([bytes.subarray(0, at), bytes.subarray(Math.min(bytes.length, at + prng.int(1, 16)))]);
      break;
    case "truncate":
      next = bytes.subarray(0, at);
      break;
    case "append":
      next = Buffer.concat([bytes, Buffer.from(prng.pick(["{\"seq\":", "\n\n", "garbage", "{\"seq\":99,\"entry\":{}}\n"]), "utf8")]);
      break;
    case "empty":
      next = Buffer.alloc(0);
      break;
    case "bom":
      next = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
      break;
    case "crlf":
      next = Buffer.from(bytes.toString("utf8").replace(/\n/gu, "\r\n"), "utf8");
      break;
    case "utf16":
      next = Buffer.from(bytes.toString("utf8"), "utf16le");
      break;
    case "lone-surrogate":
      // An encoded lone surrogate (ED A0 80), which is not valid UTF-8.
      next = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xed, 0xa0, 0x80]), bytes.subarray(at)]);
      break;
    case "oversize": {
      // Past the store's limit for this kind of file: a journal line, or a manifest or snapshot.
      if (target !== PROJECT_FILES.journal && !JSON_FILES.includes(target)) return damage(prng, root, { filesOnly });
      const limit = target === PROJECT_FILES.journal ? PERSISTENCE_LIMITS.maxEntryBytes : PERSISTENCE_LIMITS.maxManifestBytes;
      next = target === PROJECT_FILES.journal
        ? Buffer.concat([bytes, Buffer.from(`{"seq":999,"digest":"${"0".repeat(64)}","entry":{"pad":"${"x".repeat(limit)}"}}\n`, "utf8")])
        : Buffer.concat([bytes, Buffer.alloc(limit + 1, 0x20)]);
      break;
    }
    case "line-value": {
      const lines = bytes.toString("utf8").split("\n");
      const candidates = lines.map((line, index) => [line, index]).filter(([line]) => line.includes('"name":"'));
      if (candidates.length === 0) return damage(prng, root, { filesOnly });
      const [line, index] = prng.pick(candidates);
      const name = line.indexOf('"name":"') + 8;
      lines[index] = `${line.slice(0, name)}X${line.slice(name)}`;
      next = Buffer.from(lines.join("\n"), "utf8");
      break;
    }
    case "object-value": {
      const text = bytes.toString("utf8");
      const name = text.indexOf('"name":"');
      if (name < 0) return damage(prng, root, { filesOnly });
      next = Buffer.from(`${text.slice(0, name + 8)}X${text.slice(name + 8)}`, "utf8");
      break;
    }
    case "flip-last-line": {
      // Damage inside the final line only: what a crash mid-append can leave.
      const text = bytes.toString("utf8");
      const start = text.lastIndexOf("\n", text.length - 2) + 1;
      next = Buffer.from(bytes);
      if (next.length > start) next[prng.int(start, next.length - 1)] ^= 1 << prng.int(0, 7);
      break;
    }
    case "swap-lines":
    case "repeat-line":
    case "drop-line": {
      const lines = bytes.toString("utf8").split("\n").filter((line) => line !== "");
      if (lines.length < 2) return damage(prng, root, { filesOnly });
      const a = prng.int(0, lines.length - 1);
      const b = (a + prng.int(1, lines.length - 1)) % lines.length;
      if (kind === "swap-lines") [lines[a], lines[b]] = [lines[b], lines[a]];
      else if (kind === "repeat-line") lines.splice(b, 0, lines[a]);
      else lines.splice(a, 1);
      next = Buffer.from(`${lines.join("\n")}\n`, "utf8");
      break;
    }
    default: {
      // A JSON value changed, removed or added, the file still valid JSON.
      const value = JSON.parse(bytes.toString("utf8"));
      const key = prng.pick(Object.keys(value));
      if (kind === "json-change") value[key] = typeof value[key] === "number" ? value[key] + prng.pick([1, -1]) : `${value[key]}x`;
      else if (kind === "json-remove") delete value[key];
      else Object.defineProperty(value, prng.pick(["extra", "__proto__", "createdBy"]), { value: prng.pick([1, "x", null, {}]), enumerable: true });
      next = Buffer.from(JSON.stringify(value), "utf8");
    }
  }
  // Damage that changes nothing is no damage: draw another.
  if (next.equals(bytes)) return damage(prng, root, { filesOnly });
  writeFileSync(path, next);
  return `${kind} in ${target}${["flip", "insert", "remove", "truncate", "lone-surrogate"].includes(kind) ? ` at ${at}` : ""}`;
}

test("the store under generated damage fails closed: refused unchanged, or exactly a state the project held", async (t) => {
  const totals = {};
  const tally = (what) => {
    totals[what] = (totals[what] ?? 0) + 1;
  };
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      const prng = createPrng(seed);
      const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-fuzz-")));
      const pool = hostPool(now);
      try {
        const { call } = await pool.open(base);
        const original = join(base, "original");
        const { byLength, latest } = buildProject(prng, original);
        const originalJournal = readFileSync(join(store(original), PROJECT_FILES.journal));
        assert.ok(JSON.parse(readFileSync(join(store(original), PROJECT_FILES.snapshot), "utf8")).journalSeq > 0, "the snapshot is a checkpoint, not the start");
        for (let index = 0; index < CASES; index += 1) {
          const copy = join(base, `case-${index}`);
          cpSync(original, copy, { recursive: true });
          const what = damage(prng, copy);
          const lockedByOther = what === "foreign-lock";
          const damaged = snapshotFiles(copy, { withLock: lockedByOther });
          const where = `seed ${seed}, case ${index}: ${what}`;
          // Through the host, on a copy of the damaged project: a typed answer that changes
          // nothing, never a 500.
          let hosted = null;
          if (index % 5 === 0) {
            const name = `hosted-${index}`;
            cpSync(copy, join(base, name), { recursive: true });
            const opened = await call("POST", "/api/projects/open", { name });
            const typed = lockedByOther ? [409, "project-locked"] : [422, ["project-unreadable", "project-version"]];
            assert.ok(opened.status === 200 || (opened.status === typed[0] && [typed[1]].flat().includes(opened.json?.error?.code)), `${where}: the host answers ${opened.status} ${JSON.stringify(opened.json)}`);
            if (opened.status === 200) {
              hosted = serializeDocument((await call("GET", "/api/document")).json.document);
              await call("POST", "/api/projects/close");
            } else {
              assert.deepEqual(snapshotFiles(join(base, name), { withLock: lockedByOther }), damaged, `${where}: a refusal through the host changes nothing`);
            }
            tally(`hosted ${opened.status}`);
            rmSync(join(base, name), { recursive: true, force: true });
          }
          let project;
          try {
            project = open(copy);
          } catch (error) {
            assert.ok(error instanceof PersistenceError, `${where}: refused with the store's own error, not ${error?.name}: ${error?.message}`);
            if (lockedByOther) assert.ok(error instanceof PersistenceLockError, `${where}: a lock held by someone else is a lock refusal`);
            assert.deepEqual(snapshotFiles(copy, { withLock: lockedByOther }), damaged, `${where}: a refused open changes no file`);
            if (!lockedByOther) assert.equal(existsSync(join(store(copy), PROJECT_FILES.lock)), false, `${where}: and leaves no lock`);
            assert.equal(hosted, null, `${where}: the host opened what the store refuses`);
            tally(`refused (${error.name})`);
            rmSync(copy, { recursive: true, force: true });
            continue;
          }
          let text;
          try {
            if (what.startsWith("leftovers")) assert.equal(project.recovery.staleTemporaryFiles, 2, `${where}: the leftovers are cleared and counted`);
            const document = project.document;
            validateDocument(document);
            text = serializeDocument(document);
            if (text === latest) {
              tally("opened at the latest state");
            } else {
              // An earlier state only when the journal's end was cut, and then exactly the state
              // that journal length gives.
              const left = readFileSync(join(store(copy), PROJECT_FILES.journal));
              assert.ok(left.length < originalJournal.length && originalJournal.subarray(0, left.length).equals(left), `${where}: an earlier state only when what is left of the journal is a prefix of it`);
              assert.equal(text, byLength.get(left.length), `${where}: exactly the state that journal length gave`);
              tally(project.recovery.tornTailBytes > 0 ? "opened at an earlier state (a cut through a line, repaired)" : "opened at an earlier state (a cut between lines, #239)");
            }
            if (index % 5 === 0) assert.equal(hosted, text, `${where}: the host opens the very document the store opens`);
          } finally {
            project.close();
          }
          const again = open(copy);
          try {
            assert.equal(serializeDocument(again.document), text, `${where}: opening again gives the same document`);
            assert.equal(again.recovery.tornTailBytes, 0, `${where}: and has nothing left to repair`);
          } finally {
            again.close();
          }
          rmSync(copy, { recursive: true, force: true });
        }
      } finally {
        await pool.closeAll();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
  t.diagnostic(`outcomes: ${JSON.stringify(totals)}`);
});
