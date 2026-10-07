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
  PRESENTATION_URL_ATTRIBUTES,
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

const request = (entry) => ({
  schemaVersion: IMPORT_SCHEMA_VERSION, requestId: `corpus-${entry.id}`, actorId: "corpus", intent: "Malicious corpus",
  at: "2026-10-07T09:00:00.000Z", policy: defaultImportPolicy("offline"),
  source: entry.baseUrl === null
    ? { kind: "html-snapshot" }
    : { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
});

const EXECUTABLE_SCHEME = /^\s*(?:javascript|vbscript|data|file|blob):/iu;

// Attributes that may carry a URL. A kept value must be inert: a fragment, or a proven
// local object. Every other URL is a resource or is removed.
const URL_BEARING = new Set([
  "href", "src", "poster", "cite", "background", "xlink:href", "action", "formaction", "srcset",
  "ping", "attributionsrc", "imagesrcset", "codebase", "archive", "classid", "longdesc", "xml:base",
  "profile", "manifest", "dynsrc", "lowsrc", "itemid", "icon", "data",
]);
const INERT_URL = /^(?:#[^\s"'<>`\\]*|\.\/objects\/[a-f0-9]{64})$/u;
const HOST_ACTING = new Set(["is", "commandfor", "command", "popovertarget", "popovertargetaction", "interestfor", "invoketarget", "invokeaction", "interesttarget", "interestaction", "anchor"]);

// Independent of the import-stack sanitizer: CSS Syntax preprocessing (CR LF, CR, FF to
// LF), comment removal, and escape decoding (hex escape with one optional whitespace,
// escaped newline removed, other escapes literal), then a search for any function or
// at-rule that can fetch or execute.
function cssView(css) {
  const preprocessed = css.replace(/\r\n|[\r\f]/gu, "\n");
  let out = "";
  let quote = null;
  for (let index = 0; index < preprocessed.length; index += 1) {
    const char = preprocessed[index];
    // Comments start only outside strings and when "/" is not escaped.
    if (char !== "\\" && quote === null && char === "/" && preprocessed[index + 1] === "*") {
      const end = preprocessed.indexOf("*/", index + 2);
      index = end < 0 ? preprocessed.length : end + 1;
      continue;
    }
    if (char !== "\\") {
      if (quote !== null && (char === quote || char === "\n")) quote = null;
      else if (quote === null && (char === "\"" || char === "'")) quote = char;
      out += char;
      continue;
    }
    const next = preprocessed[index + 1] ?? "";
    if (next === "\n") { index += 1; continue; }
    const hex = /^[0-9a-fA-F]{1,6}/u.exec(preprocessed.slice(index + 1))?.[0];
    if (hex) {
      const code = Number.parseInt(hex, 16);
      out += code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
      index += hex.length;
      if (/[ \t\n]/u.test(preprocessed[index + 1] ?? "")) index += 1;
      continue;
    }
    out += next;
    index += 1;
  }
  return out.toLowerCase().replace(/\s+/gu, "");
}
// Comments can hide, never create, a url( or @import (tokens never join across a
// comment), so decoding escapes without removing anything is a second, sound view.
function rawCssView(css) {
  const preprocessed = css.replace(/\r\n|[\r\f]/gu, "\n");
  return preprocessed
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/gu, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
    })
    .replace(/\\(.)/gsu, "$1")
    .toLowerCase()
    .replace(/\s+/gu, "");
}
const unsafeCss = (css) => CSS_AUTHORITY.test(cssView(css)) || CSS_AUTHORITY.test(rawCssView(css));
const CSS_AUTHORITY = /url\(|@import|image-set\(|image\(|expression\(|-moz-binding|behavior:|src\(|cross-fade\(|element\(|paint\(|javascript:|vbscript:/u;

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
      assert.equal(HOST_ACTING.has(lower), false, `${id}: ${name} acts on host elements`);
      if (URL_BEARING.has(lower)) assert.match(value, INERT_URL, `${id}: ${name} keeps a live URL`);
      if (PRESENTATION_URL_ATTRIBUTES.has(lower) || lower === "style") {
        assert.equal(unsafeCss(value), false, `${id}: ${name} keeps CSS fetch authority`);
      }
    }
    if (node.style.cssText !== undefined) {
      assert.equal(unsafeCss(node.style.cssText), false, `${id}: unsafe inline style survived`);
    }
  }
  for (const stylesheet of proposal.stylesheets) {
    assert.equal(unsafeCss(stylesheet.cssText), false, `${id}: unsafe stylesheet survived`);
  }
  for (const resource of proposal.resources) {
    // Without a base URL a resource may stay relative, but only if no scheme hides in it.
    const url = new URL(resource.uri, "https://relative.invalid/");
    if (url.origin === "https://relative.invalid") continue;
    assert.ok(url.protocol === "https:" || url.protocol === "http:", `${id}: resource scheme ${url.protocol}`);
    assert.equal(url.username + url.password, "", `${id}: resource keeps credentials`);
    assert.equal(/token|secret|password/iu.test(url.search), false, `${id}: resource keeps a secret-bearing query`);
  }
}

test("the manifest lists exactly the corpus files", () => {
  const files = readdirSync(DIRECTORY).filter((name) => name.endsWith(".html")).sort();
  assert.deepEqual(manifest.cases.map((entry) => entry.file).sort(), files);
  assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, manifest.cases.length);
  assert.ok(manifest.cases.length >= 42);
  for (const category of ["html", "url", "css", "svg", "mxss"]) {
    assert.ok(manifest.cases.some((entry) => entry.category === category), `category ${category} is represented`);
  }
});

for (const entry of manifest.cases) {
  test(`corpus ${entry.id}: ${entry.description}`, () => {
    const input = html(entry);
    if (entry.outcome.startsWith("rejected:")) {
      assert.throws(() => importHtmlSnapshot(request(entry), input), (error) => error.name === entry.outcome.slice("rejected:".length));
      return;
    }
    const proposal = importHtmlSnapshot(request(entry), input);
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
  const proposal = importHtmlSnapshot(request({ id: "use" }), html(manifest.cases.find((entry) => entry.id === "svg-use-external")));
  const external = proposal.resources.filter((resource) => resource.uri.startsWith("https://evil.test/"));
  assert.equal(external.length, 1);
  assert.equal(external[0].kind, "image");
  const subresources = importHtmlSnapshot(request({ id: "svg-sub" }), html(manifest.cases.find((entry) => entry.id === "svg-href-subresources")));
  const kinds = subresources.resources.filter((resource) => resource.uri.startsWith("https://evil.test/")).map((resource) => resource.kind);
  assert.deepEqual(kinds, ["image", "image", "image", "image"], "pattern, filter, textPath and cursor references are subresources");
});

test("the static design scan treats every corpus case as data", async () => {
  for (const entry of manifest.cases) {
    const report = await scanStaticHtml({ html: html(entry), filePath: `corpus/${entry.file}` });
    assert.ok(Array.isArray(report.findings), entry.id);
    assert.ok(report.findings.every((finding) => finding.location?.path === undefined || finding.location.path === `corpus/${entry.file}`), `${entry.id}: findings stay bound to the case`);
  }
});

test("the independent CSS view sees escapes the way a browser does", () => {
  assert.match(cssView("background:\\75\r\nrl(x)"), /url\(/u, "hex escape consumes CR LF as one newline");
  assert.match(cssView("u\\\nrl(x)"), /url\(/u, "escaped newline is removed");
  assert.match(cssView("u/**/rl(x)"), /url\(/u);
  assert.match(cssView("\\40 import 'x'"), /@import/u);
  assert.match(cssView("content:'/*';background:url(x);/*'*/"), /url\(/u, "a comment marker inside a string is not a comment");
  assert.match(cssView("a:\\/* x;background:url(x) */"), /url\(/u, "an escaped slash does not start a comment");
  assert.doesNotMatch(cssView("color: red; width: 10px"), CSS_AUTHORITY);
});

test("markup imported without a base URL keeps only inert relative links", () => {
  const entry = manifest.cases.find((item) => item.id === "no-base-control-scheme");
  const proposal = importHtmlSnapshot(request(entry), html(entry));
  assert.deepEqual(proposal.resources.map((resource) => resource.uri), ["relative/page.html"]);
});
