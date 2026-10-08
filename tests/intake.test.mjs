import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { IMPORT_SCHEMA_VERSION, defaultImportPolicy, importHtmlSnapshot } from "../packages/import-stack/src/index.ts";
import { PROJECT_FILES, createProject, openProject } from "../packages/persistence/src/index.ts";
import {
  INTAKE_PROVENANCE,
  IntakeNotReadyError,
  IntakeValidationError,
  commitIntake,
  inferSemantics,
  planNetworkImport,
  reviewImport,
} from "../packages/intake/src/index.ts";

const AT = "2026-10-07T09:00:00.000Z";
const PAGE = `<header><nav aria-label="Main"><ul><li><a href="https://example.com/x">Home</a></li></ul></nav></header>
<main><h2>Title</h2><button type="submit">Go</button><div role="button" aria-label="Fake">x</div>
<input type="checkbox" name="c"><input type="email"><textarea></textarea><select><option>a</option></select>
<img src="https://cdn.example.com/a.png" alt="Logo"><img src="https://cdn.example.com/b.png">
<span role="link">s</span><div role="banana">b</div><button role="tab">Tab</button><ul role="presentation"><li>p</li></ul>
<div role="heading" aria-level="3">H</div><section aria-label="Promo">p</section><section>plain</section></main>
<footer>f</footer><script>alert(1)</script>`;

function proposal(html = PAGE, requestId = "intake-1") {
  return importHtmlSnapshot({
    schemaVersion: IMPORT_SCHEMA_VERSION, requestId, actorId: "user-1", intent: "Import a page", at: AT,
    source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
    policy: defaultImportPolicy("offline"),
  }, html);
}

function byTag(prop, tag, predicate = () => true) {
  return Object.values(prop.nodes).filter((node) => node.tag === tag && predicate(node)).map((node) => node.id);
}

function withProject(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-intake-")));
  try {
    createProject(root, { projectId: "intake-proj", document: createDocument({ id: "doc-1", nodes: [] }), createdAt: AT });
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("provenance and dependencies are composition-only", () => {
  assert.match(INTAKE_PROVENANCE.posture, /creates no second document authority/i);
  const manifest = JSON.parse(readFileSync(new URL("../packages/intake/package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@ninerr/design-assurance", "@ninerr/history", "@ninerr/import-stack", "@ninerr/network-policy", "@ninerr/persistence"].sort());
});

test("web semantics come only from markup and carry OBSERVED evidence", () => {
  const p = proposal();
  const report = inferSemantics(p);
  const roleOf = (id) => report.records.find((record) => record.nodeId === id);
  assert.ok(report.records.every((record) => record.evidence === "OBSERVED" && record.source.length > 0));
  const nav = roleOf(byTag(p, "nav")[0]);
  assert.deepEqual([nav.role, nav.name, nav.source], ["navigation", "Main", "tag:nav"]);
  assert.equal(roleOf(byTag(p, "header")[0]).role, "banner");
  assert.equal(roleOf(byTag(p, "main")[0]).role, "main");
  assert.equal(roleOf(byTag(p, "footer")[0]).role, "contentinfo");
  assert.equal(roleOf(byTag(p, "a")[0]).role, "link");
  assert.deepEqual([roleOf(byTag(p, "h2")[0]).role, roleOf(byTag(p, "h2")[0]).level], ["heading", 2]);
  assert.equal(roleOf(byTag(p, "button", (node) => !node.attributes.role)[0]).source, "tag:button");
  const fake = roleOf(byTag(p, "div", (node) => node.attributes.role === "button")[0]);
  assert.deepEqual([fake.role, fake.source, fake.name], ["button", "aria-role:button", "Fake"]);
  assert.equal(roleOf(byTag(p, "input", (node) => node.attributes.type === "checkbox")[0]).role, "checkbox");
  assert.equal(roleOf(byTag(p, "input", (node) => node.attributes.type === "email")[0]).source, "input-type:email");
  assert.equal(roleOf(byTag(p, "textarea")[0]).role, "textbox");
  assert.equal(roleOf(byTag(p, "select")[0]).role, "combobox");
  const images = Object.values(p.nodes).filter((node) => node.kind === "image").map((node) => roleOf(node.id));
  assert.deepEqual(images.map((record) => record.hasAlt).sort(), [false, true]);
  assert.equal(images.find((record) => record.hasAlt).name, "Logo");
  assert.equal(roleOf(byTag(p, "span", (node) => node.attributes.role === "link")[0]).source, "aria-role:link");
  const headingDiv = roleOf(byTag(p, "div", (node) => node.attributes.role === "heading")[0]);
  assert.deepEqual([headingDiv.role, headingDiv.level], ["heading", 3]);
  const sections = byTag(p, "section");
  assert.deepEqual(sections.map((id) => roleOf(id)?.role ?? null).sort(), [null, "region"].sort());
  assert.equal(roleOf(byTag(p, "ul", (node) => node.attributes.role === "presentation")[0]), undefined, "presentation removes the role");
  assert.deepEqual(report.unknownRoles.map((entry) => entry.role), ["banana"]);
  assert.deepEqual(report.overrides.map((entry) => [entry.native, entry.aria]), [["button", "tab"]]);
});

test("an anchor without an href resource is not a link", () => {
  const p = proposal("<p><a>not a link</a></p>");
  assert.equal(inferSemantics(p).records.some((record) => record.role === "link"), false);
});

test("review summarizes the proposal and blocks on errors", () => {
  const p = proposal();
  const review = reviewImport(p);
  assert.equal(review.commitReady, true);
  assert.deepEqual(review.blockingReasons, []);
  assert.equal(review.counts.nodes, Object.keys(p.nodes).length);
  assert.equal(review.counts.roots, p.rootIds.length);
  assert.equal(review.security.scriptsRemoved, 1);
  assert.ok(review.diagnostics.warning >= 1);
  assert.equal(review.semantics.byRole.navigation, 1);
  assert.equal(review.semantics.unknownRoles, 1);
  assert.equal(review.source.uri, "https://example.com/page");
  assert.deepEqual(reviewImport(p), review, "deterministic");
  const blocked = structuredClone(p);
  blocked.diagnostics.push({ code: "test-error", severity: "error", message: "blocked for test" });
  const blockedReview = reviewImport(blocked);
  assert.equal(blockedReview.commitReady, false);
  assert.match(blockedReview.blockingReasons[0], /1 error diagnostic/);
});

test("reviewed imports commit into a persisted project with semantics and survive reopen", () => withProject((root) => {
  const p = proposal();
  const store = openProject(root, { owner: "user-1", at: AT });
  const result = commitIntake(store, p, { transactionId: "tx-import-1", at: AT });
  assert.equal(result.revision, 1);
  assert.ok(result.semanticNodes > 10);
  store.close();
  const reopened = openProject(root, { owner: "user-1", at: AT });
  const navId = byTag(p, "nav")[0];
  assert.deepEqual(reopened.document.nodes[navId].props.semantics, { role: "navigation", evidence: "OBSERVED", source: "tag:nav", name: "Main" });
  assert.equal(reopened.document.rootIds.length, p.rootIds.length);
  reopened.close();
}));

test("not-ready, stale, and duplicate commits write nothing", () => withProject((root) => {
  const store = openProject(root, { owner: "user-1", at: AT });
  const journal = join(root, PROJECT_FILES.directory, PROJECT_FILES.journal);
  const blocked = structuredClone(proposal());
  blocked.diagnostics.push({ code: "test-error", severity: "error", message: "blocked" });
  assert.throws(() => commitIntake(store, blocked, { transactionId: "tx-bad", at: AT }), IntakeNotReadyError);
  assert.equal(readFileSync(journal).length, 0);
  commitIntake(store, proposal(), { transactionId: "tx-1", at: AT });
  const after = readFileSync(journal);
  assert.throws(() => commitIntake(store, proposal(), { transactionId: "tx-2", at: AT }));
  assert.deepEqual(readFileSync(journal), after);
  assert.equal(store.revision, 1);
  assert.throws(() => commitIntake({}, proposal(), { transactionId: "tx-3", at: AT }), IntakeValidationError);
  store.close();
}));

test("network imports are decided by the project network policy", () => {
  const offline = planNetworkImport({ schemaVersion: 1, mode: "offline", grants: [] }, "https://example.com");
  assert.equal(offline.allowed, false);
  const local = planNetworkImport({ schemaVersion: 1, mode: "local-only", grants: [] }, "http://localhost:5173/");
  assert.equal(local.allowed, true);
  assert.equal(local.importPolicy.mode, "local-app");
  assert.equal(planNetworkImport({ schemaVersion: 1, mode: "local-only", grants: [] }, "https://example.com").allowed, false);
  const grant = { id: "site", capability: "import.fetch", scheme: "https", host: "example.com", port: null, allowPrivateNetwork: false, purpose: "import the marketing site" };
  const remote = planNetworkImport({ schemaVersion: 1, mode: "allowlist", grants: [grant] }, "https://example.com/page");
  assert.equal(remote.allowed, true);
  assert.equal(remote.importPolicy.mode, "remote");
  assert.equal(remote.decision.grantId, "site");
  const wrongCapability = planNetworkImport({ schemaVersion: 1, mode: "allowlist", grants: [{ ...grant, capability: "provider.inference" }] }, "https://example.com/page");
  assert.equal(wrongCapability.allowed, false);
});

test("semantics follow HTML-AAM scoping, input types, decorative images, and list membership", () => {
  const p = proposal(`<article><header>a</header><footer>b</footer></article><header>page</header>
<main><input type="number"><input type="search"><input type="password"><input type="text" list="opts">
<img src="https://cdn.example.com/d.png" alt=""><ul role="presentation"><li>x</li></ul><li>orphan</li>
<div role="banana button">t</div><h2 aria-level="4">h</h2><select multiple><option>o</option></select></main>`);
  const report = inferSemantics(p);
  const roleOf = (id) => report.records.find((record) => record.nodeId === id)?.role ?? null;
  const headers = byTag(p, "header");
  assert.deepEqual(headers.map(roleOf).sort(), [null, "banner"].sort(), "scoped header is not a landmark");
  assert.equal(roleOf(byTag(p, "footer")[0]), null);
  const inputRole = (type) => roleOf(byTag(p, "input", (node) => node.attributes.type === type)[0]);
  assert.equal(inputRole("number"), "spinbutton");
  assert.equal(inputRole("search"), "searchbox");
  assert.equal(inputRole("password"), null);
  assert.equal(inputRole("text"), "combobox");
  assert.equal(Object.values(p.nodes).filter((node) => node.kind === "image").some((node) => roleOf(node.id) !== null), false, "empty alt is decorative");
  assert.deepEqual(byTag(p, "li").map(roleOf), [null, null], "li is a listitem only inside a list role");
  const multi = report.records.find((record) => record.nodeId === byTag(p, "div")[0]);
  assert.deepEqual([multi.role, multi.source], ["button", "aria-role:button"]);
  assert.ok(report.unknownRoles.some((entry) => entry.role === "banana"));
  assert.equal(report.records.find((record) => record.nodeId === byTag(p, "h2")[0]).level, 4);
  assert.equal(roleOf(byTag(p, "select")[0]), "listbox");
});

test("accessible names are cleaned of hidden characters and never split a code point", () => {
  const long = "\u{1F600}".repeat(250);
  const p = proposal(`<nav aria-label="Ma\u{202e}in\u{200b}">n</nav><button aria-label="${long}">b</button>`);
  const report = inferSemantics(p);
  const nav = report.records.find((record) => record.role === "navigation");
  assert.equal(nav.name, "Main");
  const button = report.records.find((record) => record.role === "button");
  assert.equal(Array.from(button.name).length, 200);
  assert.equal(button.name.isWellFormed(), true);
});

test("a commit computed against a stale revision is refused and writes nothing", () => withProject((root) => {
  const store = openProject(root, { owner: "user-1", at: AT });
  const journal = join(root, PROJECT_FILES.directory, PROJECT_FILES.journal);
  const staleView = { document: store.document, revision: store.revision, commit: (transaction) => store.commit(transaction) };
  commitIntake(store, proposal("<p>first</p>", "intake-a"), { transactionId: "tx-first", at: AT });
  const before = readFileSync(journal);
  assert.throws(() => commitIntake(staleView, proposal("<p>second</p>", "intake-b"), { transactionId: "tx-stale", at: AT }), /Stale transaction/);
  assert.deepEqual(readFileSync(journal), before);
  assert.equal(store.revision, 1);
  store.close();
}));

test("malformed and getter-backed proposals fail closed or are read exactly once", () => withProject((root) => {
  const store = openProject(root, { owner: "user-1", at: AT });
  assert.throws(() => commitIntake(store, { schemaVersion: 1, nodes: "nope" }, { transactionId: "tx-bad", at: AT }));
  const clean = proposal("<p>clean</p>", "intake-clean");
  const other = proposal("<p>DIFFERENT</p>", "intake-other");
  let reads = 0;
  const shifty = { ...clean };
  Object.defineProperty(shifty, "nodes", { enumerable: true, get: () => (reads++ === 0 ? clean.nodes : other.nodes) });
  const result = commitIntake(store, shifty, { transactionId: "tx-shifty", at: AT });
  assert.equal(reads, 1, "the proposal is read once into an inert copy");
  assert.equal(result.review.counts.nodes, Object.keys(clean.nodes).length);
  assert.equal(Object.values(store.document.nodes).some((node) => node.props?.text === "DIFFERENT"), false);
  store.close();
}));

test("review lists errors first and reports truncation", () => {
  const p = structuredClone(proposal());
  for (let index = 0; index < 205; index += 1) p.diagnostics.push({ code: `zz-info-${String(index).padStart(3, "0")}`, severity: "info", message: "i" });
  p.diagnostics.push({ code: "aa-error", severity: "error", message: "e" });
  const review = reviewImport(p);
  assert.equal(review.diagnostics.items[0].severity, "error");
  assert.equal(review.diagnostics.truncated, p.diagnostics.length - 200);
});

test("semantics cover invalid input types, menu lists, article scoping, select size, and default heading level", () => {
  const p = proposal(`<div role="article"><header>h</header></div><main><input type="foo"><menu><li>m</li></menu>
<select size="2x"><option>o</option></select><div role="heading">h</div><nav aria-label="Main
Menu   wide">n</nav></main>`);
  const report = inferSemantics(p);
  const roleOf = (id) => report.records.find((record) => record.nodeId === id) ?? null;
  assert.equal(roleOf(byTag(p, "header")[0]), null, "role=article scopes header");
  assert.equal(roleOf(byTag(p, "input")[0]).role, "textbox");
  assert.equal(roleOf(byTag(p, "menu")[0]).role, "list");
  assert.equal(roleOf(byTag(p, "li")[0]).role, "listitem");
  assert.deepEqual([roleOf(byTag(p, "select")[0]).role, roleOf(byTag(p, "select")[0]).source], ["listbox", "tag:select+size"]);
  assert.equal(roleOf(byTag(p, "div", (node) => node.attributes.role === "heading")[0]).level, 2);
  assert.equal(roleOf(byTag(p, "nav")[0]).name, "Main Menu wide");
});

test("semantics follow ARIA token choice for scoping and HTML ASCII parsing rules", () => {
  const long = `${"x".repeat(199)}  y`;
  const p = proposal(`<div role="button article"><header>a</header></div><div role="article navigation"><footer>b</footer></div>
<input type="chec&#x212A;box"><input type="CHECKBOX"><select size=" 3"></select><select size="1"></select><select size="&nbsp;3"></select>
<nav aria-label="a&#x200B; &#x200B;b">n</nav><aside aria-label="${long}">s</aside>`);
  const report = inferSemantics(p);
  const recordOf = (id) => report.records.find((record) => record.nodeId === id) ?? null;
  const buttonDiv = byTag(p, "div", (node) => node.attributes.role === "button article")[0];
  const articleDiv = byTag(p, "div", (node) => node.attributes.role === "article navigation")[0];
  assert.equal(recordOf(buttonDiv).role, "button");
  assert.equal(recordOf(byTag(p, "header")[0]).role, "banner", "a non-chosen article token does not scope");
  assert.equal(recordOf(articleDiv), null, "a chosen article role removes semantics");
  assert.equal(recordOf(byTag(p, "footer")[0]), null, "a chosen article role scopes footer");
  assert.equal(report.unknownRoles.some((entry) => entry.nodeId === articleDiv), false);
  const kelvin = byTag(p, "input", (node) => node.attributes.type !== "CHECKBOX")[0];
  const upper = byTag(p, "input", (node) => node.attributes.type === "CHECKBOX")[0];
  assert.deepEqual([recordOf(kelvin).role, recordOf(kelvin).source], ["textbox", "input-type:invalid"]);
  assert.equal(recordOf(upper).role, "checkbox");
  const selectSource = (size) => recordOf(byTag(p, "select", (node) => node.attributes.size === size)[0]).source;
  assert.deepEqual([selectSource(" 3"), selectSource("1"), selectSource(String.fromCodePoint(0xa0) + "3")], ["tag:select+size", "tag:select", "tag:select"]);
  assert.equal(recordOf(byTag(p, "nav")[0]).name, "a b");
  assert.equal(recordOf(byTag(p, "aside")[0]).name, "x".repeat(199));
});
