import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../packages/persistence/src/canonical.ts";
import { openProject } from "../packages/persistence/src/index.ts";
import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { GOLDEN_AT, writeGoldenProject, writeSegmentedGoldenProject } from "./support/golden-project.mjs";
import { client } from "./support/host-api.mjs";
import { CASES, CORPUS, MANIFEST, filesUnder, treeDigest, writeCorpus } from "./support/migration-corpus.mjs";

// P08-G10 (#230, founder section P08.10): the durable migration corpus
// (tests/support/migration-corpus.mjs) opened through the studio host, as the editor opens a
// project:
// - historical, legacy and current projects open to the document this release writes for the
//   same history (semantics preserved);
// - future and corrupt ones are refused with the right reason and leave every byte as it was;
// - recoverable damage is repaired and reported;
// - doing any of it twice gives the same bytes (deterministic).

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tree = (root) => Object.fromEntries(filesUnder(root).map((path) => [path, sha256(readFileSync(join(root, path)))]));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

/** The document this release writes for the golden history, built from code, not the corpus. */
function referenceDocument(write) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-reference-")));
  try {
    write(root);
    const store = openProject(root, { owner: "reader-1", at: GOLDEN_AT });
    try {
      return canonicalJson(store.document);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const REFERENCE = { golden: referenceDocument(writeGoldenProject), segments: referenceDocument(writeSegmentedGoldenProject) };

/** Open corpus case `name` in a fresh projects folder; returns the answer, the document, and the folder's files before and after. */
async function openCase(name) {
  const projects = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-")));
  try {
    cpSync(join(CORPUS, name), join(projects, name), { recursive: true });
    const before = tree(join(projects, name));
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
    return { answer, document, before, after: tree(join(projects, name)) };
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
  assert.deepEqual([...new Set(manifest.cases.map((item) => item.category))].sort(), ["current", "historical", "legacy", "recoverable"]);
  assert.deepEqual(manifest.cases.map((item) => item.name), CASES.map((item) => item.name));
});

for (const item of manifest.cases) {
  test(`corpus ${item.category}: ${item.what} (${item.name}) (P08-G10)`, async () => {
    const first = await openCase(item.name);
    const { expect } = item;
    if (expect.refused) {
      assert.ok([404, 409, 422].includes(first.answer.status), JSON.stringify(first.answer));
      assert.equal(first.answer.json.error.code, expect.refused, JSON.stringify(first.answer.json));
      assert.match(first.answer.json.error.message, new RegExp(expect.pattern, "iu"));
      assert.deepEqual(first.after, first.before, "a refused open changes no file");
    } else {
      assert.equal(first.answer.status, 200, JSON.stringify(first.answer));
      assert.equal(first.document, REFERENCE[expect.opens], "it opens to the document this release writes for the same history");
      if (expect.writes) assert.notDeepEqual(first.after, first.before, "opening it migrated or repaired it");
      else assert.deepEqual(first.after, first.before, "opening and closing a current project leaves it byte-identical");
      for (const [field, value] of Object.entries(expect.recovery ?? {})) assert.equal(first.answer.json.recovery[field], value, `recovery reports ${field}`);
      if (item.category === "legacy") {
        // The original is left as it was, beside the migrated copy.
        for (const [path, digest] of Object.entries(first.before)) assert.equal(first.after[path], digest, `${path} is unchanged`);
        assert.ok(Object.keys(first.after).some((path) => path.startsWith(".ninerr/")), "a Ninerr copy was made");
      }
    }
    // Deterministic: the same case, opened again from the corpus, gives the same answer and bytes.
    const second = await openCase(item.name);
    assert.deepEqual(second.answer, first.answer);
    assert.equal(second.document, first.document);
    assert.deepEqual(second.after, first.after);
  });
}

test("an opened historical project opens again unchanged, as a current one (P08-G10)", async () => {
  // Migration happens once: the migrated result is itself a current project.
  const projects = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-corpus-twice-")));
  try {
    for (const name of ["legacy-v1", "historical-v2"]) {
      cpSync(join(CORPUS, name), join(projects, name), { recursive: true });
      for (let round = 0; round < 2; round += 1) {
        const host = await startStudioHost({ projectsRoot: projects, now: () => GOLDEN_AT });
        try {
          const before = tree(join(projects, name));
          const answer = await client(host.url, host.token)("POST", "/api/projects/open", { name });
          assert.equal(answer.status, 200, JSON.stringify(answer));
          assert.equal(answer.json.recovery.migratedFrom ?? null, round === 0 ? answer.json.recovery.migratedFrom : null, "only the first open migrates");
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
