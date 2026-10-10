import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../packages/persistence/src/canonical.ts";
import { LEGACY_PROJECT_DIRECTORY, PROJECT_FILES, openProject } from "../packages/persistence/src/index.ts";
import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { GOLDEN_AT, writeGoldenProject, writeSegmentedGoldenProject } from "./support/golden-project.mjs";
import { client, ok } from "./support/host-api.mjs";
import { CASES, CORPUS, MANIFEST, filesUnder, treeDigest, writeCorpus } from "./support/migration-corpus.mjs";

// P08-G10 (#230, founder section P08.10): the durable migration corpus
// (tests/support/migration-corpus.mjs) opened through the studio host, as the editor opens a
// project:
// - legacy, historical and current projects open to the document this release writes for the
//   same history, with that history's journal entries (who made each change, with what tool,
//   why) kept as they were: semantics preserved;
// - recoverable damage is repaired, and the whole recovery report is as expected;
// - doing any of it twice gives the same bytes (deterministic).
// - future and corrupt projects are refused with the host's reason for each, and leave every
//   byte as it was.

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tree = (root) => Object.fromEntries(filesUnder(root).map((path) => [path, sha256(readFileSync(join(root, path)))]));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

/**
 * The transactions in a project's current journal segment, in order (`store`: its store
 * directory). Only whole lines count, as for the store: a last line cut off by a crash is not
 * an entry.
 */
const journalOf = (projectDir, store = PROJECT_FILES.directory) => {
  const text = readFileSync(join(projectDir, store, PROJECT_FILES.journal), "utf8");
  return wholeLines(text);
};
const wholeLines = (text) => text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.entry !== undefined).map((line) => line.entry.transaction);

/**
 * The document and journal this release writes for the golden history, built from code
 * (tests/support/golden-project.mjs), not from the corpus.
 */
function reference(write) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-reference-")));
  try {
    write(root);
    const store = openProject(root, { owner: "reader-1", at: GOLDEN_AT });
    try {
      return { document: canonicalJson(store.document), journal: journalOf(root) };
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const REFERENCE = { golden: reference(writeGoldenProject), segments: reference(writeSegmentedGoldenProject) };
// Pinned by hand, so a reader that misread both the corpus and the reference the same way would
// still be caught: the canonical golden document at revision 5 (both histories end there).
const GOLDEN_DOCUMENT_SHA256 = "b5bab3855fa87f1934c9df56deb6681fff18d5e7f862789419b71f0a5d630388";

/**
 * Open corpus case `name` in a fresh projects folder; returns the answer, the document, the
 * journal, and the files before and after, of the project and of the whole projects folder.
 * The folder already holds what a person's does, an agent registry, so a change to anything
 * beside the project shows too.
 */
async function openCase(name) {
  const projects = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-")));
  try {
    const setup = await startStudioHost({ projectsRoot: projects, now: () => GOLDEN_AT });
    try {
      await ok(client(setup.url, setup.token)("POST", "/api/agents/create", { name: "Kept" }));
    } finally {
      await setup.close();
    }
    cpSync(join(CORPUS, name), join(projects, name), { recursive: true });
    const before = tree(join(projects, name));
    const folderBefore = tree(projects);
    let clock = 0;
    const now = () => new Date(Date.parse(GOLDEN_AT) + 60_000 + clock++ * 1000).toISOString();
    const host = await startStudioHost({ projectsRoot: projects, now });
    let answer;
    let document = null;
    try {
      answer = await client(host.url, host.token)("POST", "/api/projects/open", { name });
      if (answer.status === 200) document = canonicalJson(host.session.document);
    } finally {
      await host.close();
    }
    const journal = existsSync(join(projects, name, PROJECT_FILES.directory, PROJECT_FILES.journal)) ? journalOf(join(projects, name)) : null;
    const folderAfter = tree(projects);
    // Everything in the projects folder but the project itself: the person's other files.
    const besides = (files) => Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(`${name}/`)));
    return { answer, document, journal, before, after: tree(join(projects, name)), folderBefore, folderAfter, besidesBefore: besides(folderBefore), besidesAfter: besides(folderAfter) };
  } finally {
    rmSync(projects, { recursive: true, force: true });
  }
}

test("the corpus is frozen: every file is as recorded, and the generator still writes exactly it (P08-G10)", () => {
  assert.equal(treeDigest(CORPUS), manifest.treeSha256, "no corpus file changed, and none was added or removed");
  const fresh = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-regenerated-")));
  try {
    writeCorpus(fresh);
    assert.deepEqual(tree(fresh), tree(CORPUS), "regenerating the corpus gives the same bytes");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
  // Every category is there.
  assert.deepEqual([...new Set(manifest.cases.map((item) => item.category))].sort(), ["corrupt", "current", "future", "historical", "legacy", "recoverable"]);
  assert.deepEqual(manifest.cases.map((item) => item.name), CASES.map((item) => item.name));
  assert.equal(sha256(REFERENCE.golden.document), GOLDEN_DOCUMENT_SHA256, "the reference is the golden document");
  assert.equal(REFERENCE.segments.document, REFERENCE.golden.document, "the segmented history ends at the same document");
});

for (const item of manifest.cases) {
  test(`corpus ${item.category}: ${item.what} (${item.name}) (P08-G10)`, async () => {
    const first = await openCase(item.name);
    const { expect } = item;
    if (expect.refused) {
      assert.equal(first.answer.status, 422, JSON.stringify(first.answer));
      assert.equal(first.answer.json.error.code, expect.refused, JSON.stringify(first.answer.json));
      assert.match(first.answer.json.error.message, new RegExp(expect.pattern, "iu"));
      assert.deepEqual(first.after, first.before, "a refused open changes no file of the project");
      assert.deepEqual(first.folderAfter, first.folderBefore, "nor any other file in the projects folder");
    } else {
      assert.equal(first.answer.status, 200, JSON.stringify(first.answer));
      assert.equal(first.document, REFERENCE[expect.opens].document, "it opens to the document this release writes for the same history");
      // The history itself survives: every journal entry, with its actor, tool, intent and
      // metadata. A legacy project keeps its own entries exactly as they were written, old tool
      // names included: migration copies history, it never rewrites it.
      const history = item.category === "legacy" ? journalOf(join(CORPUS, item.name), LEGACY_PROJECT_DIRECTORY) : REFERENCE[expect.opens].journal;
      assert.deepEqual(first.journal, history, "its journal holds the same history, entry by entry");
      if (item.category === "legacy") {
        // And it is the same history: only the package scope from before the rename (named after
        // the legacy directory) differs from this release's.
        const oldScope = `@${LEGACY_PROJECT_DIRECTORY.slice(1)}/`;
        assert.deepEqual(JSON.parse(JSON.stringify(history).replaceAll(oldScope, "@ninerr/")), REFERENCE.golden.journal);
      }
      if (expect.writes) assert.notDeepEqual(first.after, first.before, "opening it migrated or repaired it");
      else assert.deepEqual(first.after, first.before, "opening and closing a current project leaves it byte-identical");
      assert.deepEqual(first.answer.json.recovery, expect.recovery, "the whole recovery report is as expected");
      assert.deepEqual(first.besidesAfter, first.besidesBefore, "opening it changes nothing beside the project");
      if (item.category === "legacy") {
        // The original is left exactly as it was, beside the migrated copy: no file changed, added or removed.
        const legacy = (files) => Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${LEGACY_PROJECT_DIRECTORY}/`)));
        assert.deepEqual(legacy(first.after), legacy(first.before), "the original is untouched");
        assert.deepEqual(legacy(first.before), first.before, "the case held only the original");
        assert.ok(Object.keys(first.after).some((path) => path.startsWith(`${PROJECT_FILES.directory}/`)), "a Ninerr copy was made");
      }
    }
    // Deterministic: the same case, opened again from the corpus, gives the same answer and bytes.
    const second = await openCase(item.name);
    assert.deepEqual(second.answer, first.answer);
    assert.equal(second.document, first.document);
    assert.deepEqual(second.journal, first.journal);
    assert.deepEqual(second.after, first.after);
  });
}

test("an opened historical project opens again unchanged, as a current one (P08-G10)", async () => {
  // Migration happens once: the migrated result is itself a current project.
  const projects = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-twice-")));
  try {
    for (const [name, migratedFrom] of [["legacy-v1", 1], ["historical-v2", 2]]) {
      cpSync(join(CORPUS, name), join(projects, name), { recursive: true });
      for (let round = 0; round < 2; round += 1) {
        const host = await startStudioHost({ projectsRoot: projects, now: () => GOLDEN_AT });
        try {
          const before = tree(join(projects, name));
          const answer = await client(host.url, host.token)("POST", "/api/projects/open", { name });
          assert.equal(answer.status, 200, JSON.stringify(answer));
          assert.equal(answer.json.recovery.migratedFrom, round === 0 ? migratedFrom : null, "only the first open migrates");
          await client(host.url, host.token)("POST", "/api/projects/close");
          if (round === 1) assert.deepEqual(tree(join(projects, name)), before, "the second open changes nothing");
        } finally {
          await host.close();
        }
      }
      assert.ok(existsSync(join(projects, name, ".ninerr", "project.json")));
    }
  } finally {
    rmSync(projects, { recursive: true, force: true });
  }
});
