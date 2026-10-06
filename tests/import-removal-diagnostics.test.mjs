import test from "node:test";
import assert from "node:assert/strict";

import {
  IMPORT_SCHEMA_VERSION,
  defaultImportPolicy,
  importHtmlSnapshot,
  validateImportProposal,
} from "../packages/import-stack/src/index.ts";
import { reviewImport } from "../packages/intake/src/index.ts";

const AT = "2026-10-07T09:00:00.000Z";

function snapshot(html, policy = defaultImportPolicy("offline")) {
  return importHtmlSnapshot({
    schemaVersion: IMPORT_SCHEMA_VERSION,
    requestId: "removal-1",
    actorId: "user-1",
    intent: "Import bounded content",
    at: AT,
    source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
    policy,
  }, html);
}

const byCode = (proposal, code) => proposal.diagnostics.filter((entry) => entry.code === code);

test("a removed form is counted, diagnosed with node context, and unwrapped into a div", () => {
  const proposal = snapshot('<main><form><span role="link">s</span></form></main>');
  assert.equal(proposal.security.dangerousElementsRemoved, 1);
  const nodes = Object.values(proposal.nodes);
  assert.equal(nodes.some((node) => node.tag === "form"), false);
  const div = nodes.find((node) => node.tag === "div");
  assert.ok(div, "form is neutralized into a div");
  const span = nodes.find((node) => node.tag === "span");
  assert.equal(span.parentId, div.id, "form children are kept under the div");
  assert.equal(span.attributes.role, "link");
  const found = byCode(proposal, "form-element-neutralized");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.equal(found[0].nodeId, div.id);
  assert.equal(found[0].sourceBinding.domPath, div.sourceBinding.domPath);
  assert.match(found[0].message, /1 <form>/u);
  assert.doesNotThrow(() => validateImportProposal(proposal));
});

test("form diagnostics are one per class with first-occurrence context and do not grow with count", () => {
  const forms = Array.from({ length: 40 }, (_, index) => `<form action="/s${index}"><p>f${index}</p></form>`).join("");
  const proposal = snapshot(`<section>${forms}</section>`);
  assert.equal(proposal.security.dangerousElementsRemoved, 40);
  assert.equal(proposal.security.dangerousUrlsRemoved, 40, "form action stripping is still counted separately");
  const found = byCode(proposal, "form-element-neutralized");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /40 <form>/u);
  const firstDiv = Object.values(proposal.nodes).find((node) => node.sourceBinding?.domPath === "/section[1]/form[1]");
  assert.equal(found[0].nodeId, firstDiv.id);
});

test("meta and non-stylesheet link elements are counted with one diagnostic per tag", () => {
  const proposal = snapshot(
    '<div><meta charset="utf-8"><meta name="x" content="y"><meta http-equiv="refresh" content="0;url=https://evil.test">'
    + '<link rel="icon" href="/favicon.ico"><link rel="preload" href="/a.js"><link rel="stylesheet"><p>body</p></div>',
  );
  assert.equal(proposal.security.dangerousElementsRemoved, 6);
  const removed = byCode(proposal, "forbidden-element-removed");
  assert.deepEqual(removed.map((entry) => entry.severity), ["info", "info"]);
  assert.match(removed[0].message, /3 <link>/u);
  assert.equal(removed[0].sourceBinding.domPath, "/div[1]/link[4]");
  assert.match(removed[1].message, /3 <meta>/u);
  assert.equal(removed[1].sourceBinding.domPath, "/div[1]/meta[1]");
  assert.equal(Object.values(proposal.nodes).some((node) => node.tag === "meta" || node.tag === "link"), false);
  assert.doesNotThrow(() => validateImportProposal(proposal));
});

test("converted style and stylesheet links are not counted as removed", () => {
  const proposal = snapshot('<div><style>.a { color: red; }</style><style></style><link rel="stylesheet" href="/site.css"><p>x</p></div>');
  assert.equal(proposal.security.dangerousElementsRemoved, 0);
  assert.equal(proposal.stylesheets.length, 1);
  assert.equal(proposal.resources.some((entry) => entry.kind === "stylesheet" && entry.uri === "https://example.com/site.css"), true);
  assert.equal(byCode(proposal, "forbidden-element-removed").length, 0);
});

test("elements already counted in their own class are counted exactly once", () => {
  const proposal = snapshot(
    '<div><script>x()</script><style>.a { background: url(https://evil.test/x.png); }</style>'
    + '<link rel="stylesheet" href="javascript:alert(1)"><p>x</p></div>',
  );
  assert.equal(proposal.security.scriptsRemoved, 1);
  assert.equal(proposal.security.unsafeStylesRemoved, 1);
  assert.equal(proposal.security.dangerousUrlsRemoved, 1);
  assert.equal(proposal.security.dangerousElementsRemoved, 0);
  assert.equal(byCode(proposal, "forbidden-element-removed").length, 0);
});

test("class diagnostics follow the per-element diagnostics in a fixed order", () => {
  const proposal = snapshot('<div><meta name="a"><link rel="icon" href="/i.png"><form><p>x</p></form><iframe></iframe></div>');
  assert.deepEqual(
    proposal.diagnostics.map((entry) => entry.code),
    ["executable-element-removed", "form-element-neutralized", "forbidden-element-removed", "forbidden-element-removed"],
  );
  assert.equal(proposal.security.dangerousElementsRemoved, 4);
});

test("class diagnostics respect maxDiagnostics", () => {
  const policy = { ...defaultImportPolicy("offline"), maxDiagnostics: 1 };
  assert.doesNotThrow(() => snapshot("<div><form><p>x</p></form></div>", policy));
  assert.throws(() => snapshot('<div><form><p>x</p></form><meta name="a"></div>', policy), /maxDiagnostics/u);
});

test("intake review reflects removal counts and class diagnostics", () => {
  const review = reviewImport(snapshot('<main><form><span role="link">s</span></form><meta name="a"></main>'));
  assert.equal(review.security.dangerousElementsRemoved, 2);
  assert.equal(review.diagnostics.warning, 1);
  assert.equal(review.diagnostics.info, 1);
  assert.deepEqual(review.diagnostics.items.map((entry) => entry.code), ["form-element-neutralized", "forbidden-element-removed"]);
  assert.equal(review.commitReady, true);
});

test("neutralized forms keep inert attributes and the class message states the neutralization", () => {
  const proposal = snapshot('<form class="signup" id="f"><p>x</p></form>');
  const div = Object.values(proposal.nodes).find((node) => node.tag === "div");
  assert.equal(div.attributes.class, "signup");
  assert.equal(div.attributes.id, "f");
  assert.equal(byCode(proposal, "form-element-neutralized")[0].message, "Neutralized 1 <form> element into <div>; children kept, submission removed");
});

test("form-owner and submission override attributes are stripped from every element and rejected at validation", () => {
  const proposal = snapshot(
    '<div><form method="post"><button form="hostform" formmethod="post" formtarget="_top" formenctype="text/plain" formnovalidate>b</button>'
    + '<input form="hostform" name="q"></form><input FORM="hostform"></div>',
  );
  const authority = ["form", "formaction", "formmethod", "formtarget", "formenctype", "formnovalidate", "action"];
  for (const node of Object.values(proposal.nodes)) {
    for (const name of authority) assert.equal(Object.hasOwn(node.attributes, name), false, `${node.tag} kept ${name}`);
  }
  assert.equal(proposal.security.dangerousUrlsRemoved, 7);
  const input = Object.values(proposal.nodes).find((node) => node.tag === "input" && node.attributes.name === "q");
  assert.ok(input, "the control itself is kept");

  for (const name of authority) {
    const forged = structuredClone(snapshot("<div><button>b</button></div>"));
    const button = Object.values(forged.nodes).find((node) => node.tag === "button");
    button.attributes[name] = "hostform";
    assert.throws(() => validateImportProposal(forged), /authority/u, name);
  }
});

test("link attribute lookup ignores a polluted prototype", () => {
  Object.prototype.rel = "stylesheet";
  Object.prototype.href = "https://evil.test/a.css";
  let proposal;
  try {
    proposal = snapshot("<div><link><p>x</p></div>");
  } finally {
    delete Object.prototype.rel;
    delete Object.prototype.href;
  }
  assert.equal(proposal.resources.some((entry) => entry.uri.includes("evil.test")), false);
  assert.equal(proposal.security.dangerousElementsRemoved, 1);
});
