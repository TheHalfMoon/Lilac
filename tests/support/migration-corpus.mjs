// P08-G10 (#230, founder section P08.10): the durable migration corpus. Each case is a project
// folder on disk, made once from the golden fixtures by a small, stated change, and committed:
// legacy (the format before the rename, schema 1), historical (schema 2), current (schema 3,
// with and without segments), future (a newer manifest, document or journal entry), corrupt
// (a sample of the damage the store detects), and recoverable damage (a torn tail, a stale
// temporary). Every case says what opening it must do. tests/migration-corpus.test.mjs opens
// each one through the studio host and holds it to that.
//
//   node tests/support/migration-corpus.mjs --write    regenerate tests/fixtures/corpus
//
// The corpus is frozen: corpus.json records one SHA-256 over every file, and the test fails if
// a file changes, or if this generator would now write something else.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_PROJECT_DIRECTORY, PROJECT_FILES, encodeJournalLine } from "../../packages/persistence/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/projects/", import.meta.url));
export const CORPUS = fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));
export const MANIFEST = join(CORPUS, "corpus.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** JSON with sorted keys, as the store writes its own files. */
const canonical = (value) => JSON.stringify(value, (key, item) => (item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));
const lines = (path) => readFileSync(path, "utf8").split("\n").filter((line) => line !== "");

/** The document object a snapshot names, and its path. */
function documentObject(dir) {
  const { documentObject: digest } = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  return { digest, path: join(dir, "objects", digest.slice(0, 2), digest.slice(2)) };
}

/** Store `bytes` as an object and point the snapshot at it. */
function replaceDocumentObject(dir, bytes) {
  const digest = sha256(bytes);
  mkdirSync(join(dir, "objects", digest.slice(0, 2)), { recursive: true });
  writeFileSync(join(dir, "objects", digest.slice(0, 2), digest.slice(2)), bytes);
  const snapshot = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  writeFileSync(join(dir, "snapshot.json"), canonical({ ...snapshot, documentObject: digest }));
}

/**
 * The cases. `from` is a golden fixture; `change(dir)` edits its store directory (`.ninerr`,
 * or the legacy directory for the format before the rename). `expect` is what opening it must do:
 * `{ opens: "golden" | "segments", writes, recovery }`, where `writes` says whether opening it
 * may change its files and `recovery` is the whole report the host must give, or
 * `{ refused, pattern }` with the host's error code and the cause its message must name. Each is written by hand from
 * the fixture: the golden snapshot stands at entry 2 of 5, so an open replays 3 entries.
 */
// The start of a journal line whose write was cut off.
const TORN = "{\"digest\":\"0123";

export const CASES = [
  // Historical and legacy: they open, migrated, to the same document as this release writes.
  { name: "legacy-v1", category: "legacy", from: "v1-basic", what: "a project from before the rename (its own directory and format, schema 1)", expect: { opens: "golden", writes: true, recovery: { tornTailBytes: 0, staleTemporaryFiles: 0, replayedEntries: 3, migratedFrom: 1, lockOverride: null, legacyProject: true } } },
  {
    name: "legacy-v1-torn-tail",
    category: "legacy",
    from: "v1-basic",
    what: "a project from before the rename whose last journal write was cut off (a crash of the earlier release)",
    change: (dir) => writeFileSync(join(dir, "journal.log"), `${readFileSync(join(dir, "journal.log"), "utf8")}${TORN}`),
    // The torn tail is carried into the Ninerr copy and repaired by its first open; the original keeps it.
    expect: { opens: "golden", writes: true, recovery: { tornTailBytes: Buffer.byteLength(TORN), staleTemporaryFiles: 0, replayedEntries: 3, migratedFrom: 1, lockOverride: null, legacyProject: true } },
  },
  { name: "historical-v2", category: "historical", from: "v2-basic", what: "project schema 2, from before journal segments", expect: { opens: "golden", writes: true, recovery: { tornTailBytes: 0, staleTemporaryFiles: 0, replayedEntries: 3, migratedFrom: 2, lockOverride: null } } },
  // Current.
  { name: "current-v3", category: "current", from: "v3-basic", what: "project schema 3", expect: { opens: "golden", writes: false, recovery: { tornTailBytes: 0, staleTemporaryFiles: 0, replayedEntries: 3, migratedFrom: null, lockOverride: null } } },
  { name: "current-v3-segments", category: "current", from: "v3-segments", what: "project schema 3 with an archived journal segment", expect: { opens: "segments", writes: false, recovery: { tornTailBytes: 0, staleTemporaryFiles: 0, replayedEntries: 3, migratedFrom: null, lockOverride: null } } },
  // Damage the store repairs: the open succeeds and says what it did.
  {
    name: "recoverable-torn-tail",
    category: "recoverable",
    from: "v3-basic",
    what: "a journal whose last write was cut off",
    change: (dir) => writeFileSync(join(dir, "journal.log"), `${readFileSync(join(dir, "journal.log"), "utf8")}${TORN}`),
    expect: { opens: "golden", writes: true, recovery: { tornTailBytes: Buffer.byteLength(TORN), staleTemporaryFiles: 0, replayedEntries: 3, migratedFrom: null, lockOverride: null } },
  },
  {
    name: "recoverable-stale-temporary",
    category: "recoverable",
    from: "v3-basic",
    what: "a temporary file left by an interrupted save",
    change: (dir) => writeFileSync(join(dir, "snapshot.json.tmp-4242-00000000-0000-4000-8000-000000000000"), "{\"half\":"),
    expect: { opens: "golden", writes: true, recovery: { tornTailBytes: 0, staleTemporaryFiles: 1, replayedEntries: 3, migratedFrom: null, lockOverride: null } },
  },
  // Future: from a newer Ninerr. Refused as a version problem, and never changed.
  {
    name: "future-manifest-schema",
    category: "future",
    from: "v3-basic",
    what: "project schema 4",
    change: (dir) => writeFileSync(join(dir, "project.json"), canonical({ ...JSON.parse(readFileSync(join(dir, "project.json"), "utf8")), schemaVersion: 4 })),
    expect: { refused: "project-version", pattern: "project schema 4 is newer than supported schema 3" },
  },
  {
    name: "future-document-schema",
    category: "future",
    from: "v3-basic",
    what: "a document of document schema 2",
    change: (dir) => replaceDocumentObject(dir, Buffer.from(canonical({ ...JSON.parse(readFileSync(documentObject(dir).path, "utf8")), schemaVersion: 2 }), "utf8")),
    expect: { refused: "project-version", pattern: "is document schema 2, newer than supported schema 1" },
  },
  {
    name: "future-journal-operation",
    category: "future",
    from: "v3-basic",
    what: "a correctly chained journal entry with an operation this release does not know",
    change: (dir) => {
      const journal = join(dir, "journal.log");
      const last = JSON.parse(lines(journal).at(-1));
      const entry = { seq: last.entry.seq + 1, revision: last.entry.revision + 1, transaction: { actor: "user-1", baseRevision: last.entry.revision, id: "tx-future", intent: null, metadata: {}, operations: [{ nodeId: "frame-1", type: "morph-node" }], timestamp: null, tool: null } };
      writeFileSync(journal, `${readFileSync(journal, "utf8")}${encodeJournalLine(entry, last.digest).line}`);
    },
    expect: { refused: "project-version", pattern: "uses operation type \"morph-node\", which journal format 1 does not have" },
  },
  // Corrupt: refused as unreadable, and never changed.
  {
    name: "corrupt-journal-chain",
    category: "corrupt",
    from: "v3-basic",
    what: "a journal entry changed after it was written",
    change: (dir) => writeFileSync(join(dir, "journal.log"), readFileSync(join(dir, "journal.log"), "utf8").replace('"intent":"rename"', '"intent":"renamE"')),
    expect: { refused: "project-unreadable", pattern: "journal line 1 breaks the hash chain" },
  },
  {
    name: "corrupt-document-object",
    category: "corrupt",
    from: "v3-basic",
    what: "a document object whose bytes no longer match its name",
    change: (dir) => {
      const { path } = documentObject(dir);
      writeFileSync(path, readFileSync(path, "utf8").replace("doc-golden", "doc-golder"));
    },
    expect: { refused: "project-unreadable", pattern: "object [0-9a-f]{64} does not match its content hash" },
  },
  {
    name: "corrupt-missing-object",
    category: "corrupt",
    from: "v3-basic",
    what: "a document object that is gone",
    change: (dir) => rmSync(documentObject(dir).path),
    expect: { refused: "project-unreadable", pattern: "object [0-9a-f]{64} is missing" },
  },
  {
    name: "corrupt-snapshot",
    category: "corrupt",
    from: "v3-basic",
    what: "a snapshot reference that is not JSON",
    change: (dir) => writeFileSync(join(dir, "snapshot.json"), "not json"),
    expect: { refused: "project-unreadable", pattern: "snapshot reference is not valid JSON" },
  },
  {
    name: "corrupt-snapshot-past-end",
    category: "corrupt",
    from: "v3-basic",
    what: "a snapshot reference past the end of the journal",
    change: (dir) => writeFileSync(join(dir, "snapshot.json"), canonical({ ...JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")), journalSeq: 9 })),
    expect: { refused: "project-unreadable", pattern: "snapshot reference points past the end of the journal" },
  },
  {
    name: "corrupt-manifest",
    category: "corrupt",
    from: "v3-basic",
    what: "a manifest that is not JSON",
    change: (dir) => writeFileSync(join(dir, "project.json"), "{"),
    expect: { refused: "project-unreadable", pattern: "manifest is not valid JSON" },
  },
  {
    name: "corrupt-object-fan-out",
    category: "corrupt",
    from: "v3-basic",
    what: "an object fan-out folder that is a file (Windows reports it as missing, so the store checks)",
    change: (dir) => {
      const { digest } = documentObject(dir);
      rmSync(join(dir, "objects", digest.slice(0, 2)), { recursive: true });
      writeFileSync(join(dir, "objects", digest.slice(0, 2)), "not a folder");
    },
    expect: { refused: "project-unreadable", pattern: "object fan-out directory is not a directory" },
  },
  // Refused legacy projects: the one kind whose normal open writes (a Ninerr copy). Refused,
  // nothing may be created beside the original.
  {
    name: "legacy-v1-future-schema",
    category: "future",
    from: "v1-basic",
    what: "a project from before the rename, of a newer schema than any release wrote",
    change: (dir) => writeFileSync(join(dir, "project.json"), canonical({ ...JSON.parse(readFileSync(join(dir, "project.json"), "utf8")), schemaVersion: 4 })),
    expect: { refused: "project-version", pattern: "project schema 4 is newer than supported schema 3" },
  },
  {
    name: "legacy-v1-corrupt-chain",
    category: "corrupt",
    from: "v1-basic",
    what: "a project from before the rename with a journal entry changed after it was written",
    change: (dir) => writeFileSync(join(dir, "journal.log"), readFileSync(join(dir, "journal.log"), "utf8").replace('"intent":"rename"', '"intent":"renamE"')),
    expect: { refused: "project-unreadable", pattern: "journal line 1 breaks the hash chain" },
  },
];

/** Every file under `root`, as sorted relative paths with forward slashes. */
export function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return out;
}

/** One SHA-256 over every corpus file but the manifest: each path, then its bytes. */
export function treeDigest(root) {
  const hash = createHash("sha256");
  for (const path of filesUnder(root).filter((item) => item !== "corpus.json")) hash.update(`${path} ${sha256(readFileSync(join(root, path)))}\n`);
  return hash.digest("hex");
}

/** Write the corpus into `into` (a fresh folder), and return its manifest. */
export function writeCorpus(into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const item of CASES) {
    const source = join(FIXTURES, item.from);
    const target = join(into, item.name);
    cpSync(source, target, { recursive: true });
    const store = [PROJECT_FILES.directory, LEGACY_PROJECT_DIRECTORY].map((name) => join(target, name)).find((path) => existsSync(path));
    item.change?.(store);
  }
  const manifest = { version: 1, cases: CASES.map(({ name, category, from, what, expect }) => ({ name, category, from, what, expect })), treeSha256: treeDigest(into) };
  writeFileSync(join(into, "corpus.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function isMainModule(url) {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] !== "--write") {
    process.stderr.write("usage: node tests/support/migration-corpus.mjs --write\n");
    process.exit(2);
  }
  const manifest = writeCorpus(CORPUS);
  process.stdout.write(`wrote ${manifest.cases.length} cases into ${relative(process.cwd(), dirname(MANIFEST))} (tree ${manifest.treeSha256})\n`);
}
