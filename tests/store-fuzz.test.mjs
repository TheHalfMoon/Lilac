import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocument, serializeDocument, validateDocument } from "../packages/document-model/src/index.mjs";
import { PROJECT_FILES, PersistenceError, createProject, openProject } from "../packages/persistence/src/index.ts";
import { hostPool } from "./support/host-api.mjs";
import { createPrng, positiveIntegerFromEnv, propertySeeds } from "./support/prng.mjs";
import { generatedEdit } from "./support/reference-model.mjs";

// P08-G3a (#230, founder section P08.3): the project store under generated damage. Each seed
// builds a real project (a checkpoint part-way, so the snapshot and the journal both matter),
// keeping every document it ever held. Then each case copies it, damages one of its files
// (bytes flipped, inserted or removed, truncated, lines swapped or repeated, a JSON value
// changed, removed or added), and opens it. The store must fail closed:
// - a refused open throws the store's own typed error, and leaves every file exactly as it
//   found it, with no lock behind;
// - an open that succeeds yields a valid document that is exactly one the project really held:
//   the latest, or an earlier one only when what is left of the journal is a prefix of it (its
//   end was cut). A cut through a line is repaired and reported; a cut between whole lines
//   cannot be told from changes never made (#239);
// - opening the result again gives the very same document: recovery is deterministic;
// - through the studio host, every fifth case answers 422 with a typed code, never a 500, or
//   opens the very document the store opens.
// NINERR_FUZZ_RUNS sets the number of seeds (default 4) and NINERR_FUZZ_CASES the damaged
// copies per seed (default 60); NINERR_PROPERTY_SEED=<seed> replays one seed.

const RUNS = positiveIntegerFromEnv("NINERR_FUZZ_RUNS", 4);
const CASES = positiveIntegerFromEnv("NINERR_FUZZ_CASES", 60);
const AT = "2026-10-09T12:00:00.000Z";
const open = (root) => openProject(root, { owner: "fuzz", at: AT });
const store = (root) => join(root, PROJECT_FILES.directory);

/** Every file of the store but the lock, by path relative to the store, with its bytes. */
function snapshotFiles(root) {
  const files = {};
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (relative !== PROJECT_FILES.lock) files[relative] = readFileSync(join(directory, entry.name)).toString("base64");
    }
  };
  walk(store(root), "");
  return files;
}

/** A real project: a history of generated edits with a checkpoint part-way, and every document it held. */
function buildProject(prng, root) {
  mkdirSync(root);
  createProject(root, { projectId: "fuzz-project", document: createDocument({ id: "fuzz-doc", nodes: [] }), createdAt: AT });
  const project = open(root);
  const held = new Set([serializeDocument(project.document)]);
  const counter = { next: 0 };
  const edits = prng.int(8, 20);
  const checkpointAt = prng.int(2, edits - 2);
  for (let index = 0; index < edits; index += 1) {
    const document = project.document;
    const edit = generatedEdit(prng, document, counter);
    try {
      project.commit({ id: `tx-${index}`, actor: "fuzz-user", baseRevision: project.revision, intent: edit.intent, operations: edit.operations });
    } catch {
      continue; // a generated edit that is invalid here (a cycle, an index past the end)
    }
    held.add(serializeDocument(project.document));
    if (index === checkpointAt) project.checkpoint();
  }
  const latest = serializeDocument(project.document);
  project.close();
  return { held, latest };
}

const JSON_FILES = [PROJECT_FILES.manifest, PROJECT_FILES.snapshot];

/** Damage one file of the store at `root`; returns what was done, for the failure message. */
function damage(prng, root) {
  const files = Object.keys(snapshotFiles(root));
  const objects = files.filter((name) => name.startsWith(`${PROJECT_FILES.objects}/`));
  const used = JSON.parse(readFileSync(join(store(root), PROJECT_FILES.snapshot), "utf8")).documentObject;
  const objectPath = (digest) => `${PROJECT_FILES.objects}/${digest.slice(0, 2)}/${digest.slice(2)}`;
  const referenced = objects.filter((name) => name === objectPath(used));
  const target = prng.pick([PROJECT_FILES.manifest, PROJECT_FILES.snapshot, PROJECT_FILES.journal, PROJECT_FILES.journal, ...(objects.length > 0 ? [prng.pick(objects)] : []), ...referenced]);
  const path = join(store(root), ...target.split("/"));
  const bytes = readFileSync(path);
  const kinds = ["flip", "insert", "remove", "truncate", "append", "empty"];
  // A value inside one journal line changed, the line still valid JSON: only the hash chain can tell.
  if (target === PROJECT_FILES.journal) kinds.push("swap-lines", "repeat-line", "drop-line", "flip-last-line", "line-value", "line-value");
  if (JSON_FILES.includes(target)) kinds.push("json-change", "json-remove", "json-add");
  // An object the snapshot uses, its text changed but still valid, canonical JSON: only its
  // content hash can tell.
  if (target === objectPath(used)) kinds.push("object-value", "object-value");
  const kind = prng.pick(kinds);
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
    case "line-value": {
      const lines = bytes.toString("utf8").split("\n");
      const candidates = lines.map((line, index) => [line, index]).filter(([line]) => line.includes('"name":"'));
      if (candidates.length === 0) return damage(prng, root);
      const [line, index] = prng.pick(candidates);
      const name = line.indexOf('"name":"') + 8;
      lines[index] = `${line.slice(0, name)}X${line.slice(name)}`;
      next = Buffer.from(lines.join("\n"), "utf8");
      break;
    }
    case "object-value": {
      const text = bytes.toString("utf8");
      const at = text.indexOf('"name":"');
      next = Buffer.from(at < 0 ? text.replace('"revision":', '"revision":1') : `${text.slice(0, at + 8)}X${text.slice(at + 8)}`, "utf8");
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
    default: {
      if (["swap-lines", "repeat-line", "drop-line"].includes(kind)) {
        const lines = bytes.toString("utf8").split("\n").filter((line) => line !== "");
        if (lines.length < 2) return damage(prng, root);
        const a = prng.int(0, lines.length - 1);
        const b = (a + prng.int(1, lines.length - 1)) % lines.length;
        if (kind === "swap-lines") [lines[a], lines[b]] = [lines[b], lines[a]];
        else if (kind === "repeat-line") lines.splice(b, 0, lines[a]);
        else lines.splice(a, 1);
        next = Buffer.from(`${lines.join("\n")}\n`, "utf8");
        break;
      }
      // A JSON value changed, removed or added, the file still valid JSON.
      const value = JSON.parse(bytes.toString("utf8"));
      const keys = Object.keys(value);
      const key = prng.pick(keys);
      if (kind === "json-change") value[key] = typeof value[key] === "number" ? value[key] + prng.pick([1, -1]) : typeof value[key] === "string" ? `${value[key]}x` : null;
      else if (kind === "json-remove") delete value[key];
      else value[prng.pick(["extra", "__proto__", "revision"])] = prng.pick([1, "x", null, {}]);
      next = Buffer.from(JSON.stringify(value), "utf8");
    }
  }
  writeFileSync(path, next);
  return `${kind} in ${target}${["flip", "insert", "remove", "truncate"].includes(kind) ? ` at ${at}` : ""}`;
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();

test("the store under generated damage fails closed: refused unchanged, or exactly a state the project held", async (t) => {
  const totals = {};
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      const prng = createPrng(seed);
      const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-fuzz-")));
      const pool = hostPool(now);
      try {
        const { call } = await pool.open(base);
        const original = join(base, "original");
        const { held, latest } = buildProject(prng, original);
        const journals = { original: readFileSync(join(store(original), PROJECT_FILES.journal)) };
        for (let index = 0; index < CASES; index += 1) {
          const copy = join(base, `case-${index}`);
          cpSync(original, copy, { recursive: true });
          const what = damage(prng, copy);
          const damaged = snapshotFiles(copy);
          const where = `seed ${seed}, case ${index}: ${what}`;
          // Through the host, on a copy of the damaged project: a typed answer, never a 500.
          let hosted = null;
          if (index % 5 === 0) {
            cpSync(copy, join(base, `hosted-${index}`), { recursive: true });
            const opened = await call("POST", "/api/projects/open", { name: `hosted-${index}` });
            assert.ok(opened.status === 200 || (opened.status === 422 && ["project-unreadable", "project-version"].includes(opened.json.error.code)), `${where}: the host answers ${opened.status} ${JSON.stringify(opened.json)}`);
            if (opened.status === 200) {
              hosted = serializeDocument((await call("GET", "/api/document")).json.document);
              await call("POST", "/api/projects/close");
            }
            totals[`hosted ${opened.status}`] = (totals[`hosted ${opened.status}`] ?? 0) + 1;
            rmSync(join(base, `hosted-${index}`), { recursive: true, force: true });
          }
          let project;
          try {
            project = open(copy);
          } catch (error) {
            assert.ok(error instanceof PersistenceError, `${where}: refused with the store's own error, not ${error?.name}: ${error?.message}`);
            assert.deepEqual(snapshotFiles(copy), damaged, `${where}: a refused open changes no file`);
            assert.equal(existsSync(join(store(copy), PROJECT_FILES.lock)), false, `${where}: and leaves no lock`);
            assert.equal(hosted, null, `${where}: the host opened what the store refuses`);
            totals[`refused (${error.name})`] = (totals[`refused (${error.name})`] ?? 0) + 1;
            rmSync(copy, { recursive: true, force: true });
            continue;
          }
          const document = project.document;
          const recovery = project.recovery;
          project.close();
          validateDocument(document);
          const text = serializeDocument(document);
          assert.ok(held.has(text), `${where}: the opened document is one the project held`);
          if (index % 5 === 0) assert.equal(hosted, text, `${where}: the host opens the very document the store opens`);
          if (text !== latest) {
            const left = readFileSync(join(store(copy), PROJECT_FILES.journal));
            assert.ok(journals.original.subarray(0, left.length).equals(left), `${where}: an earlier state only when what is left of the journal is a prefix of it`);
            const outcome = recovery.tornTailBytes > 0 ? "opened at an earlier state (a cut through a line, repaired)" : "opened at an earlier state (a cut between lines, #239)";
            totals[outcome] = (totals[outcome] ?? 0) + 1;
          } else {
            totals["opened at the latest state"] = (totals["opened at the latest state"] ?? 0) + 1;
          }
          const again = open(copy);
          assert.equal(serializeDocument(again.document), text, `${where}: opening again gives the same document`);
          assert.equal(again.recovery.tornTailBytes, 0, `${where}: and has nothing left to repair`);
          again.close();
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
