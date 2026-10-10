// P08-G10 (#230, founder section P08.10): the durable migration corpus. Each case is a project
// folder on disk, made once from the golden fixtures by a small, stated change, and committed:
// historical (the format before the rename, schema 2), current (schema 3, with and without
// segments), and recoverable damage (a torn tail, a stale temporary); future and corrupt
// projects follow. Every case says what opening it must do. tests/migration-corpus.test.mjs opens each one through
// the studio host and holds it to that.
//
//   node tests/support/migration-corpus.mjs --write    regenerate tests/fixtures/corpus
//
// The corpus is frozen: corpus.json records one SHA-256 over every file, and the test fails if
// a file changes, or if this generator would now write something else.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_PROJECT_DIRECTORY, PROJECT_FILES } from "../../packages/persistence/src/index.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/projects/", import.meta.url));
export const CORPUS = fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));
export const MANIFEST = join(CORPUS, "corpus.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The cases. `from` is a golden fixture; `change(dir)` edits its store directory (`.ninerr`,
 * or the legacy directory for the format before the rename). `expect` is what opening it must do:
 * `{ opens: "golden" | "segments", writes }`, where `writes` says whether opening it may change
 * its files, or `{ refused, pattern }` with the host's error code and message.
 */
// The start of a journal line whose write was cut off.
const TORN = "{\"digest\":\"0123";

export const CASES = [
  // Historical and legacy: they open, migrated, to the same document as this release writes.
  { name: "legacy-v1", category: "legacy", from: "v1-basic", what: "a project from before the rename (its own directory and format, schema 1)", expect: { opens: "golden", writes: true } },
  { name: "historical-v2", category: "historical", from: "v2-basic", what: "project schema 2, from before journal segments", expect: { opens: "golden", writes: true } },
  // Current.
  { name: "current-v3", category: "current", from: "v3-basic", what: "project schema 3", expect: { opens: "golden", writes: false } },
  { name: "current-v3-segments", category: "current", from: "v3-segments", what: "project schema 3 with an archived journal segment", expect: { opens: "segments", writes: false } },
  // Damage the store repairs: the open succeeds and says what it did.
  {
    name: "recoverable-torn-tail",
    category: "recoverable",
    from: "v3-basic",
    what: "a journal whose last write was cut off",
    change: (dir) => writeFileSync(join(dir, "journal.log"), `${readFileSync(join(dir, "journal.log"), "utf8")}${TORN}`),
    expect: { opens: "golden", writes: true, recovery: { tornTailBytes: Buffer.byteLength(TORN) } },
  },
  {
    name: "recoverable-stale-temporary",
    category: "recoverable",
    from: "v3-basic",
    what: "a temporary file left by an interrupted save",
    change: (dir) => writeFileSync(join(dir, "snapshot.json.tmp-4242-00000000-0000-4000-8000-000000000000"), "{\"half\":"),
    expect: { opens: "golden", writes: true, recovery: { staleTemporaryFiles: 1 } },
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
