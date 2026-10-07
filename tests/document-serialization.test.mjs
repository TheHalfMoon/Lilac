import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DocumentInvariantError,
  createDocument,
  normalizeDocument,
  parseDocument,
  serializeDocument,
} from "../packages/document-model/src/index.mjs";
import { PROJECT_FILES, createProject } from "../packages/persistence/src/index.ts";
import { createPrng, propertySeeds } from "./support/prng.mjs";

const MODEL_URL = new URL("../packages/document-model/src/index.mjs", import.meta.url).href;
const GOLDEN = fileURLToPath(new URL("./fixtures/documents/golden-v1.json", import.meta.url));
const GOLDEN_SHA256 = "5313b064142a1bff683b86f1c44c8a16d4891b457623a3ae4c6f8eb23690dd73";

// Keys whose order differs between code-unit and locale collation (sv_SE puts
// a-ring and a-umlaut after z; en_US interleaves them with a).
const TRICKY_IDS = ["a", "aa", "B", "z", "\u00e4", "\u00e5", "I", "\u0131", "e\u0301", "\u{1f600}", "\ud800", "\udfff", "10", "2"];

function randomValue(prng, depth) {
  const kind = prng.int(0, depth > 2 ? 4 : 6);
  if (kind === 0) return prng.pick([null, true, false]);
  if (kind === 1) return prng.pick([0, -0, 1, -7, 0.1, 1e21, 2 ** 53 - 1, 3.5e-7]);
  if (kind === 2) return prng.pick(["", "x", "\u00e9", "\u{1f600}", "a\"b\\c", "line\nbreak", "\ud800"]);
  if (kind === 3 || kind === 4) return `s${prng.int(0, 999)}`;
  if (kind === 5) return Array.from({ length: prng.int(0, 3) }, () => randomValue(prng, depth + 1));
  const record = {};
  for (const key of prng.shuffle(TRICKY_IDS).slice(0, prng.int(0, 4))) record[key] = randomValue(prng, depth + 1);
  return record;
}

function randomRecord(prng) {
  const record = {};
  for (const key of prng.shuffle(TRICKY_IDS).slice(0, prng.int(0, 5))) record[key] = randomValue(prng, 1);
  return record;
}

function randomDocumentInput(prng) {
  const ids = prng.shuffle(TRICKY_IDS.map((id, index) => `${id}-${index}`)).slice(0, prng.int(1, TRICKY_IDS.length));
  const nodes = ids.map((id) => ({ id, type: "frame", parentId: null, children: [], props: randomRecord(prng), metadata: randomRecord(prng) }));
  for (let index = 1; index < nodes.length; index += 1) {
    if (prng.next() < 0.6) {
      const parent = nodes[prng.int(0, index - 1)];
      nodes[index].parentId = parent.id;
      parent.children.push(nodes[index].id);
    }
  }
  return { id: "doc-1", name: "Generated", nodes, metadata: randomRecord(prng) };
}

// Rebuild every object with its keys inserted in a shuffled order.
function permuteKeys(prng, value) {
  if (Array.isArray(value)) return value.map((entry) => permuteKeys(prng, entry));
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of prng.shuffle(Object.keys(value))) result[key] = permuteKeys(prng, value[key]);
  return result;
}

test("serialized bytes do not depend on key insertion order", () => {
  for (const seed of propertySeeds(40)) {
    const prng = createPrng(seed);
    const document = createDocument(randomDocumentInput(prng));
    const text = serializeDocument(document);
    for (let round = 0; round < 3; round += 1) {
      assert.equal(serializeDocument(permuteKeys(prng, document)), text, `seed ${seed}`);
    }
  }
});

// The canonical form writes -0 as 0; everything else round-trips unchanged.
function zeroNegatives(value) {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(zeroNegatives);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, zeroNegatives(entry)]));
}

test("parse is the exact inverse of serialize", () => {
  for (const seed of propertySeeds(40)) {
    const document = createDocument(randomDocumentInput(createPrng(seed)));
    const text = serializeDocument(document);
    const parsed = parseDocument(text);
    assert.deepEqual(parsed, normalizeDocument(zeroNegatives(document)), `seed ${seed}`);
    assert.equal(serializeDocument(parsed), text, `seed ${seed}`);
  }
});

test("node key order and bytes are identical under every process locale", () => {
  const script = `
    import { createDocument, normalizeDocument, serializeDocument } from ${JSON.stringify(MODEL_URL)};
    const ids = ${JSON.stringify(TRICKY_IDS)};
    const document = createDocument({ id: "doc-1", nodes: ids.map((id) => ({ id, type: "frame" })) });
    process.stdout.write(JSON.stringify({ keys: Object.keys(normalizeDocument(document).nodes), text: serializeDocument(document) }));
  `;
  const results = ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"].map((locale) => execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: "utf8" },
  ));
  for (const result of results.slice(1)) assert.equal(result, results[0]);
  const { keys } = JSON.parse(results[0]);
  // JS enumerates integer-like keys first whatever the insertion order, so the
  // in-memory order is code-unit order for the other keys; the bytes are canonical.
  const named = (ids) => ids.filter((id) => !/^\d+$/u.test(id));
  assert.deepEqual(named(keys), named([...TRICKY_IDS].sort()), "code-unit order");
  assert.match(JSON.parse(results[0]).text, /"nodes":\{"10":.*"2":/u, "serialized node keys are in code-unit order");
});

test("persistence stores exactly the model serialization", () => {
  const root = mkdtempSync(join(tmpdir(), "lilac-serialization-"));
  try {
    const document = createDocument(randomDocumentInput(createPrng(0x5eed)));
    createProject(root, { projectId: "proj-1", document, createdAt: "2026-10-07T09:00:00.000Z" });
    const directory = join(root, PROJECT_FILES.directory);
    const snapshot = JSON.parse(readFileSync(join(directory, PROJECT_FILES.snapshot), "utf8"));
    const digest = snapshot.documentObject;
    const stored = readFileSync(join(directory, PROJECT_FILES.objects, digest.slice(0, 2), digest.slice(2)), "utf8");
    assert.equal(stored, serializeDocument(document));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the golden v1 fixture is canonical and pinned", () => {
  const text = readFileSync(GOLDEN, "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), GOLDEN_SHA256);
  assert.equal(serializeDocument(parseDocument(text)), text);
});

test("values JSON cannot represent faithfully are refused", () => {
  const base = () => createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] });
  const cases = {
    undefined: undefined,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    sparse: [1, , 3],
    date: new Date(0),
    map: new Map(),
    fn: () => 1,
    symbol: Symbol("s"),
    bigint: 1n,
  };
  for (const [name, value] of Object.entries(cases)) {
    const document = base();
    document.nodes.n.props.value = value;
    assert.throws(() => serializeDocument(document), DocumentInvariantError, name);
  }
  let deep = {};
  const document = base();
  document.nodes.n.props.deep = deep;
  for (let level = 0; level < 300; level += 1) { deep.next = {}; deep = deep.next; }
  assert.throws(() => serializeDocument(document), /deeper than/u);
  assert.throws(() => serializeDocument({ id: "x" }), DocumentInvariantError, "invalid documents are refused");
});

test("negative zero is written as zero and null-prototype records are plain", () => {
  const document = createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame", props: { z: -0 } }] });
  const record = Object.create(null);
  record.k = 1;
  document.nodes.n.metadata = record;
  const text = serializeDocument(document);
  assert.match(text, /"z":0[,}]/u);
  assert.match(text, /"metadata":\{"k":1\}/u);
});

test("non-canonical text is rejected by parseDocument", () => {
  const text = serializeDocument(createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame", props: { w: 1, a: "\u00e9" } }] }));
  const variants = {
    whitespace: text.replace(":", ": "),
    reordered: text.replace('{"a":"\u00e9","w":1}', '{"w":1,"a":"\u00e9"}'),
    float: text.replace('"w":1', '"w":1.0'),
    escaped: text.replace("\u00e9", "\\u00e9"),
    trailing: `${text}\n`,
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(variant, text, name);
    assert.throws(() => parseDocument(variant), DocumentInvariantError, name);
  }
  assert.throws(() => parseDocument("{"), DocumentInvariantError);
  assert.throws(() => parseDocument(42), DocumentInvariantError);
  assert.throws(() => parseDocument('{"id":"x"}'), DocumentInvariantError, "valid canonical JSON that is not a document");
});

// Untrusted text reaches validateDocument through parseDocument, so validation
// must stay linear, iterative, own-key only, and bounded in what it echoes.
function chainDocument(length) {
  const nodes = Array.from({ length }, (_, index) => ({
    id: `n${index}`, type: "frame", parentId: index === 0 ? null : `n${index - 1}`,
    children: index === length - 1 ? [] : [`n${index + 1}`], props: {}, metadata: {},
  }));
  return { schemaVersion: 1, id: "doc-1", name: "Chain", revision: 0, rootIds: ["n0"], nodes: Object.fromEntries(nodes.map((node) => [node.id, node])), metadata: {} };
}

test("a long parent chain validates without overflowing the stack", () => {
  const text = serializeDocument(chainDocument(30000));
  assert.equal(Object.keys(parseDocument(text).nodes).length, 30000);
});

test("validation is linear in the number of children", () => {
  const count = 40000;
  const children = Array.from({ length: count }, (_, index) => `c${index}`);
  const document = {
    schemaVersion: 1, id: "doc-1", name: "Wide", revision: 0, rootIds: ["root"], metadata: {},
    nodes: Object.fromEntries([
      ["root", { id: "root", type: "frame", parentId: null, children, props: {}, metadata: {} }],
      ...children.map((id) => [id, { id, type: "frame", parentId: "root", children: [], props: {}, metadata: {} }]),
    ]),
  };
  const started = performance.now();
  parseDocument(serializeDocument(document));
  assert.ok(performance.now() - started < 3000, "40k siblings must validate well under the quadratic cost");
});

test("inherited property names are not treated as nodes", () => {
  for (const parentId of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
    const text = serializeDocument(createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] }))
      .replace('"parentId":null', `"parentId":${JSON.stringify(parentId)}`)
      .replace('"rootIds":["n"]', '"rootIds":[]');
    assert.throws(() => parseDocument(text), DocumentInvariantError, parentId);
  }
  const child = serializeDocument(createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] }))
    .replace('"children":[]', '"children":["constructor"]');
  assert.throws(() => parseDocument(child), /missing child constructor/u);
});

test("error messages do not echo oversized ids", () => {
  const long = "x".repeat(100000);
  const document = createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] });
  document.nodes.n.parentId = long;
  document.rootIds = [];
  assert.throws(() => serializeDocument(document), (error) => error instanceof DocumentInvariantError && error.message.length < 300);
  const many = createDocument({ id: "doc-1", nodes: [{ id: "n", type: "frame" }] });
  for (let index = 0; index < 50; index += 1) {
    many.nodes[`o${index}`] = { id: `o${index}`, type: "frame", parentId: `o${(index + 1) % 50}`, children: [`o${(index + 49) % 50}`], props: {}, metadata: {} };
  }
  assert.throws(() => serializeDocument(many), (error) => /Unreachable nodes: .*\(and 40 more\)/u.test(error.message));
});
