import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { createHistoryState } from "../packages/history/src/index.mjs";
import { IMPORT_SCHEMA_VERSION, commitImportProposal, defaultImportPolicy, importHtmlSnapshot } from "../packages/import-stack/src/index.ts";
import { FRAME_CSP, FRAME_SANDBOX, frameSrcdoc, planElement } from "../packages/renderer/src/index.mjs";

// PC2 (#146): the renderer's allowlists, decided without a DOM. Every node the import stack
// produces from the P06 malicious corpus must plan into inert web semantics.

const DIRECTORY = fileURLToPath(new URL("./fixtures/malicious/", import.meta.url));
const manifest = JSON.parse(readFileSync(`${DIRECTORY}manifest.json`, "utf8"));
const AT = "2026-10-07T09:00:00.000Z";

function importedDocument(entry) {
  let proposal;
  try {
    proposal = importHtmlSnapshot({
    schemaVersion: IMPORT_SCHEMA_VERSION, requestId: `render-${entry.id}`, actorId: "corpus", intent: "Render corpus", at: AT,
    policy: defaultImportPolicy("offline"),
    source: entry.baseUrl === null ? { kind: "html-snapshot" } : { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
  }, readFileSync(`${DIRECTORY}${entry.file}`, "utf8"));
  } catch {
    return null; // the import refused the case outright; there is nothing to render
  }
  if (proposal.rootIds.length === 0) return null;
  const history = createHistoryState(createDocument({ id: "doc" }));
  return commitImportProposal(history, proposal, { transactionId: "tx", baseRevision: 0, at: AT }).history.document;
}

function assertInert(plan, label) {
  for (const [name, value] of Object.entries(plan.attributes)) {
    assert.ok(!name.startsWith("on"), `${label}: no event handler (${name})`);
    assert.ok(!["style", "srcdoc", "formaction", "action", "id"].includes(name), `${label}: ${name} is never rendered`);
    assert.notEqual(name, "href", `${label}: links are rendered inert`);
    if (name === "data-lilac-href" || name === "cite") assert.match(value, /^(https?:|mailto:|tel:|#)/iu, `${label}: ${name}`);
    if (name === "src") assert.match(value, /^data:image\/(png|jpeg|gif|webp|avif);base64,/iu, `${label}: src`);
    assert.doesNotMatch(value, /javascript:/iu, `${label}: ${name} value`);
  }
  for (const value of Object.values(plan.style)) assert.doesNotMatch(value, /url\s*\(|expression|javascript:|@import|[\\;{}<>]/iu, `${label}: style`);
  assert.ok(!["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form", "frame", "frameset", "template", "noscript"].includes(plan.tag), `${label}: tag ${plan.tag}`);
}

test("every node imported from the malicious corpus plans into inert web semantics", () => {
  let planned = 0;
  let documents = 0;
  for (const entry of manifest.cases) {
    const document = importedDocument(entry);
    if (document === null) continue;
    documents += 1;
    for (const node of Object.values(document.nodes)) {
      assertInert(planElement(node), `${entry.id}/${node.id}`);
      planned += 1;
    }
  }
  assert.ok(documents >= 30, `${documents} corpus cases produced documents`);
  assert.ok(planned > 100, `planned ${planned} nodes`);
});

test("hand-built hostile props are reduced to the allowlists", () => {
  const plan = planElement({
    id: "x", type: "element",
    props: {
      tag: "SCRIPT",
      text: "hello",
      attributes: { onclick: "alert(1)", ONLOAD: "x", href: "javascript:alert(1)", style: "color:red", id: "spoof", "data-lilac-id": "spoof", srcdoc: "<b>", class: "card", "aria-label": "Card", "data-test": "1" },
      style: { color: "red", background: "url(https://evil.example/x.png)", width: "expression(alert(1))", "font-family": "a\\62 c", "--brand": "#f00", "margin;x": "1px", padding: 4 },
    },
  });
  assert.equal(plan.tag, "div", "an unknown or forbidden tag falls back to the node type's default");
  assert.deepEqual(plan.attributes, { class: "card", "aria-label": "Card", "data-test": "1" });
  assert.deepEqual(plan.style, { color: "red", "--brand": "#f00", padding: "4" });
  assert.equal(plan.text, "hello");
  assert.ok(plan.dropped >= 9);
  const link = planElement({ id: "a", type: "element", props: { tag: "a", attributes: { href: " https://example.com/x ", target: "_top" } } });
  assert.deepEqual(link.attributes, { "data-lilac-href": "https://example.com/x" }, "links are inert, and only _blank survives as a target");
  const image = planElement({ id: "i", type: "image", props: { attributes: { src: "https://evil.example/p.png", alt: "Chart" } } });
  assert.deepEqual([image.tag, image.attributes], ["img", { alt: "Chart" }], "remote images are not rendered");
  assert.equal(planElement({ id: "i2", type: "image", props: { attributes: { src: "data:image/png;base64,iVBORw0KGgo=" } } }).attributes.src, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(planElement({ id: "s", type: "image", props: { attributes: { src: "data:image/svg+xml;base64,PHN2Zy8+" } } }).attributes.src, undefined, "SVG data images are refused");
  const vector = planElement({ id: "v", type: "vector", props: { attributes: { viewBox: "0 0 10 10", onload: "x", fill: "url(#g)" } } });
  assert.equal(vector.namespace, "svg");
  assert.deepEqual(vector.attributes, { viewBox: "0 0 10 10" }, "SVG attributes keep the case the SVG DOM requires");
  const input = planElement({ id: "in", type: "element", props: { tag: "input", attributes: { type: "image", value: "v", formaction: "https://evil.example" } } });
  assert.deepEqual(input.attributes, { value: "v" });
  assert.deepEqual(planElement({ id: "n", type: "frame", props: { name: "Hero", other: { a: 1 } } }), { tag: "div", namespace: "html", attributes: {}, style: {}, text: null, dropped: 0 });
});

test("the frame is sandboxed without scripts and has a no-network policy", () => {
  assert.equal(FRAME_SANDBOX, "allow-same-origin", "no allow-scripts, allow-forms, allow-popups or allow-top-navigation");
  assert.match(FRAME_CSP, /^default-src 'none';/u);
  assert.doesNotMatch(FRAME_CSP, /script-src|https?:/u);
  assert.ok(frameSrcdoc().includes(FRAME_CSP));
});
