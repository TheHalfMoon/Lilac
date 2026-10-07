import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FORM_AUTHORITY_ATTRIBUTES,
  IMPORT_SCHEMA_VERSION,
  defaultImportPolicy,
  importHtmlSnapshot,
  isForbiddenImportTag,
  sanitizeImportedCssText,
  validateImportProposal,
} from "../packages/import-stack/src/index.ts";
import { inferSemantics } from "../packages/intake/src/index.ts";
import { scanStaticHtml } from "../packages/design-assurance/src/index.mjs";

// Versioned malicious HTML/CSS/SVG corpus (P06 gate 6). Every case in
// tests/fixtures/malicious/ is listed in manifest.json with its expected outcome
// and exact security summary; the invariants below hold for every case.

const DIRECTORY = fileURLToPath(new URL("./fixtures/malicious/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${DIRECTORY}manifest.json`, "utf8"));
const html = (entry) => readFileSync(`${DIRECTORY}${entry.file}`, "utf8");

const request = (id) => ({
  schemaVersion: IMPORT_SCHEMA_VERSION, requestId: `corpus-${id}`, actorId: "corpus", intent: "Malicious corpus",
  at: "2026-10-07T09:00:00.000Z", policy: defaultImportPolicy("offline"),
  source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
});

const EXECUTABLE_SCHEME = /^\s*(?:javascript|vbscript|data|file|blob):/iu;

// Markup surfaces only: text content is inert data (for example markup inside RCDATA
// <textarea>), so it is not held to these patterns.
function assertNoAuthority(proposal, id) {
  for (const node of Object.values(proposal.nodes)) {
    if (node.tag !== undefined) assert.equal(isForbiddenImportTag(node.tag), false, `${id}: forbidden tag <${node.tag}> survived`);
    for (const [name, value] of Object.entries(node.attributes)) {
      const lower = name.toLowerCase();
      assert.equal(lower.startsWith("on"), false, `${id}: event attribute ${name} survived`);
      assert.equal(["srcdoc", "srcset"].includes(lower) || FORM_AUTHORITY_ATTRIBUTES.has(lower), false, `${id}: ${name} survived`);
      assert.equal(EXECUTABLE_SCHEME.test(value), false, `${id}: ${name} keeps an executable or local scheme`);
    }
    if (node.style.cssText !== undefined) {
      assert.equal(sanitizeImportedCssText(node.style.cssText, 1 << 20).unsafe, false, `${id}: unsafe inline style survived`);
    }
  }
  for (const stylesheet of proposal.stylesheets) {
    assert.equal(sanitizeImportedCssText(stylesheet.cssText, 1 << 20).unsafe, false, `${id}: unsafe stylesheet survived`);
  }
  for (const resource of proposal.resources) {
    const url = new URL(resource.uri);
    assert.ok(url.protocol === "https:" || url.protocol === "http:", `${id}: resource scheme ${url.protocol}`);
    assert.equal(url.username + url.password, "", `${id}: resource keeps credentials`);
    assert.equal(/token|secret|password/iu.test(url.search), false, `${id}: resource keeps a secret-bearing query`);
  }
}

test("the manifest lists exactly the corpus files", () => {
  const files = readdirSync(DIRECTORY).filter((name) => name.endsWith(".html")).sort();
  assert.deepEqual(manifest.cases.map((entry) => entry.file).sort(), files);
  assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, manifest.cases.length);
  assert.ok(manifest.cases.length >= 35);
  for (const category of ["html", "url", "css", "svg", "mxss"]) {
    assert.ok(manifest.cases.some((entry) => entry.category === category), `category ${category} is represented`);
  }
});

for (const entry of manifest.cases) {
  test(`corpus ${entry.id}: ${entry.description}`, () => {
    const input = html(entry);
    if (entry.outcome.startsWith("rejected:")) {
      assert.throws(() => importHtmlSnapshot(request(entry.id), input), (error) => error.name === entry.outcome.slice("rejected:".length));
      return;
    }
    const proposal = importHtmlSnapshot(request(entry.id), input);
    assert.deepEqual(proposal.security, entry.security, "security summary matches the manifest");
    assert.doesNotThrow(() => validateImportProposal(proposal));
    assertNoAuthority(proposal, entry.id);
    // Only anchors may carry the link role; a subresource such as SVG <use> must not.
    for (const record of inferSemantics(proposal).records.filter((item) => item.role === "link")) {
      assert.equal(proposal.nodes[record.nodeId].tag, "a", `${entry.id}: <${proposal.nodes[record.nodeId].tag}> was given the link role`);
    }
  });
}

test("SVG <use> references are image resources, not links", () => {
  const proposal = importHtmlSnapshot(request("use"), html(manifest.cases.find((entry) => entry.id === "svg-use-external")));
  const external = proposal.resources.filter((resource) => resource.uri.startsWith("https://evil.test/"));
  assert.equal(external.length, 1);
  assert.equal(external[0].kind, "image");
});

test("the static design scan treats every corpus case as data", async () => {
  for (const entry of manifest.cases) {
    const report = await scanStaticHtml({ html: html(entry), filePath: `corpus/${entry.file}` });
    assert.ok(Array.isArray(report.findings), entry.id);
    assert.ok(report.findings.every((finding) => finding.location?.path === undefined || finding.location.path === `corpus/${entry.file}`), `${entry.id}: findings stay bound to the case`);
  }
});
