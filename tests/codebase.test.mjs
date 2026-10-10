import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodebaseLinks, MAX_SCAN_FILES, MAX_SOURCE_BYTES, assertFolder, readSourceFile, scanComponents, startStudioHost } from "../packages/studio-host/src/index.ts";
import { linkDirectory, tryLinkFile } from "./support/links.mjs";
import { writableMode } from "./support/platform.mjs";

// PC11a (#182): a connected codebase. One local folder per project, whose JSX and TSX
// components the person brings into the design with their source and writes edits back
// to as a reviewed, three-way, atomic patch, confined to the folder.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + clock++ * 1000).toISOString();
const scratch = () => realpathSync.native(mkdtempSync(join(tmpdir(), "ninerr-codebase-")));
const CARD = `export function PriceCard() {
  return (
    <section className="card" style="padding: 16px; background: #f4f0ff">
      <h2>Pro</h2>
      <p title="Plan">Everything in Free, and more.</p>
    </section>
  );
}
`;

test("the links are kept owner-only, and a file others could change is not trusted", () => {
  const root = scratch();
  try {
    const links = new CodebaseLinks(root);
    assert.equal(links.get("site"), null);
    links.set("site", "/home/someone/site/src");
    assert.equal(new CodebaseLinks(root).get("site"), "/home/someone/site/src");
    if (typeof process.getuid === "function") {
      assert.equal(statSync(join(root, ".ninerr-codebases.json")).mode & 0o777, 0o600);
      chmodSync(join(root, ".ninerr-codebases.json"), 0o666);
      assert.equal(new CodebaseLinks(root).get("site"), null, "a links file others can write is ignored");
    }
    links.set("site", null);
    assert.equal(new CodebaseLinks(root).get("site"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a codebase folder is an existing directory outside the projects folder, and files stay inside it", (t) => {
  const root = scratch();
  try {
    const projects = join(root, "projects");
    const code = join(root, "code");
    mkdirSync(join(projects, "site"), { recursive: true });
    mkdirSync(join(code, "src"), { recursive: true });
    writeFileSync(join(code, "src", "Card.jsx"), CARD);
    writeFileSync(join(root, "secret.jsx"), "export function Secret() { return <p>secret</p>; }");
    assert.equal(assertFolder(code, projects), code);
    assert.throws(() => assertFolder("code", projects), /full path/u);
    assert.throws(() => assertFolder(join(root, "nope"), projects), /does not exist/u);
    assert.throws(() => assertFolder(join(code, "src", "Card.jsx"), projects), /a file, not a folder/u);
    assert.throws(() => assertFolder(projects, projects), /outside Ninerr's projects folder/u);
    assert.throws(() => assertFolder(join(projects, "site"), projects), /outside Ninerr's projects folder/u);
    assert.throws(() => assertFolder(root, projects), /outside Ninerr's projects folder/u, "nor a folder that holds it");
    assert.throws(() => assertFolder("/", projects), /not the whole disk|outside/u);

    assert.equal(readSourceFile(code, "src/Card.jsx").content, CARD);
    for (const file of ["../secret.jsx", "src/../../secret.jsx", join(root, "secret.jsx"), "src//Card.jsx", "./src/Card.jsx", "src\\..\\..\\secret.jsx", "C:secret.jsx", "src/Card.jsx:stream.jsx", "src/Card.js", ""]) {
      assert.throws(() => readSourceFile(code, file), /inside the connected folder|outside|not in/u, file);
    }
    if (tryLinkFile(t, join(root, "secret.jsx"), join(code, "src", "Linked.jsx"))) assert.throws(() => readSourceFile(code, "src/Linked.jsx"), /not a regular file/u, "a link is not followed");
    writeFileSync(join(code, "src", "Big.jsx"), `export function Big() { return <p>${"x".repeat(MAX_SOURCE_BYTES)}</p>; }`);
    assert.throws(() => readSourceFile(code, "src/Big.jsx"), /larger than/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scan lists exported components, skips what it must, follows no link, and is bounded", () => {
  const root = scratch();
  try {
    const code = join(root, "code");
    for (const folder of ["src/ui", "node_modules/pkg", ".git", "dist", "elsewhere"]) mkdirSync(join(code, folder), { recursive: true });
    writeFileSync(join(code, "src", "Card.jsx"), CARD);
    writeFileSync(join(code, "src", "ui", "Buttons.tsx"), "export function Primary() { return <button>Go</button>; }\nexport function Quiet() { return <button>Later</button>; }\nfunction Hidden() { return <i />; }\n");
    writeFileSync(join(code, "src", "util.js"), "export function Card() {}");
    for (const folder of ["node_modules/pkg", ".git", "dist"]) writeFileSync(join(code, folder, "X.jsx"), "export function Skipped() { return <p />; }");
    writeFileSync(join(code, "elsewhere", "Far.jsx"), "export function Far() { return <p />; }");
    linkDirectory(join(code, "elsewhere"), join(code, "src", "linked"));
    const { components, truncated } = scanComponents(join(code, "src"));
    assert.deepEqual(components, [{ file: "Card.jsx", component: "PriceCard" }, { file: "ui/Buttons.tsx", component: "Primary" }, { file: "ui/Buttons.tsx", component: "Quiet" }]);
    assert.equal(truncated, false);
    assert.deepEqual(scanComponents(code).components.map((entry) => entry.file).sort(), ["elsewhere/Far.jsx", "src/Card.jsx", "src/ui/Buttons.tsx", "src/ui/Buttons.tsx"]);
    // Bounded.
    const many = join(root, "many");
    mkdirSync(many);
    for (let index = 0; index < MAX_SCAN_FILES + 5; index += 1) writeFileSync(join(many, `C${index}.jsx`), `export function C${index}() { return <p />; }`);
    const big = scanComponents(many);
    assert.equal(big.truncated, true);
    assert.equal(big.files, MAX_SCAN_FILES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bring a component in, edit it, preview and write back: three-way, atomic, only the previewed file", async () => {
  const root = scratch();
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const cardPath = join(code, "Card.jsx");
  writeFileSync(cardPath, CARD);
  const host = await startStudioHost({ projectsRoot: projects, now });
  const call = async (method, path, body) => {
    const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  try {
    await call("POST", "/api/projects/create", { name: "site" });
    assert.equal((await call("GET", "/api/codebase")).json.folder, null);
    assert.equal((await call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" })).status, 409, "nothing is connected yet");
    assert.equal((await call("POST", "/api/codebase/connect", { folder: projects })).status, 400);
    const connected = await call("POST", "/api/codebase/connect", { folder: code });
    assert.deepEqual(connected.json.components, [{ file: "Card.jsx", component: "PriceCard" }]);
    assert.equal((await call("GET", "/api/codebase")).json.folder, code, "the link is kept");

    const imported = await call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    const nodes = Object.values(host.session.document.nodes);
    const section = nodes.find((node) => node.props.tag === "section");
    const h2 = nodes.find((node) => node.props.tag === "h2");
    const p = nodes.find((node) => node.props.tag === "p");
    assert.deepEqual(section.props.codeSource, { file: "Card.jsx", component: "PriceCard", path: "", tag: "section", base: { props: { className: "card", style: "padding: 16px; background: #f4f0ff" } } });
    assert.deepEqual(h2.props.codeSource.base, { text: "Pro", props: {} });
    assert.equal(p.props.codeSource.path, "1");

    // Nothing changed yet: nothing to write.
    let preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    assert.deepEqual(preview.changes, []);
    assert.equal(preview.diff, "");

    // The person edits the heading's text, the card's fill, and the paragraph's title.
    const edit = (operations) => call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Edit", operations });
    await edit([
      { type: "set-props", nodeId: h2.id, set: { text: "Pro & Team" } },
      { type: "set-props", nodeId: section.id, set: { style: { padding: "16px", background: "#ffe4e6" } } },
      { type: "set-props", nodeId: p.id, set: { attributes: { title: "Plan \"B\"" } } },
    ]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    assert.deepEqual(preview.changes.map((change) => change.field).sort(), ["style", "text", "title"]);
    assert.deepEqual(preview.conflicts, []);
    assert.match(preview.diff, /^--- a\/Card\.jsx\n\+\+\+ b\/Card\.jsx\n@@ /u);
    assert.match(preview.diff, /\n\+      <h2>Pro &amp; Team<\/h2>\n/u);
    assert.equal(readFileSync(cardPath, "utf8"), CARD, "a preview writes nothing");

    // A stale preview is refused; the previewed one is written.
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: "0".repeat(64) })).status, 409);
    const written = await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token });
    assert.equal(written.status, 200, JSON.stringify(written.json));
    assert.equal(written.json.written, 3);
    assert.equal(readFileSync(cardPath, "utf8"), CARD
      .replace("<h2>Pro</h2>", "<h2>Pro &amp; Team</h2>")
      .replace('style="padding: 16px; background: #f4f0ff"', 'style="padding: 16px; background: #ffe4e6"')
      .replace('title="Plan"', 'title="Plan &quot;B&quot;"'), "exactly the previewed change");
    // The bases follow the file: nothing more to write.
    assert.deepEqual((await call("POST", "/api/codebase/preview", { nodeId: section.id })).json.changes, []);

    // Three-way: a field changed only in the file is kept; a field changed only here is
    // written; a field changed in both is a conflict, never written.
    writeFileSync(cardPath, readFileSync(cardPath, "utf8").replace("Everything in Free, and more.", "All of Free, plus more.").replace('className="card"', 'className="card wide"'));
    const h2Now = host.session.document.nodes[h2.id];
    await edit([
      { type: "set-props", nodeId: h2Now.id, set: { text: "Team" } },
      { type: "set-props", nodeId: section.id, set: { attributes: { class: "card narrow" } } },
    ]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    assert.deepEqual(preview.changes.map((change) => `${change.field}:${change.to}`), ["text:Team"]);
    assert.deepEqual(preview.conflicts.map((conflict) => conflict.field), ["className"]);
    await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token });
    const after = readFileSync(cardPath, "utf8");
    assert.match(after, /<h2>Team<\/h2>/u);
    assert.match(after, /All of Free, plus more\./u, "the file's own change is kept");
    assert.match(after, /className="card wide"/u, "the conflict is not written");

    // The file changing between the preview and the write is refused.
    await edit([{ type: "set-props", nodeId: h2Now.id, set: { text: "Teams" } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    writeFileSync(cardPath, `${readFileSync(cardPath, "utf8")}\n`);
    const stale = await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "plan-changed");
    assert.match(readFileSync(cardPath, "utf8"), /<h2>Team<\/h2>/u, "nothing was written");

    // What is not written back is said, not done.
    await edit([{ type: "set-props", nodeId: p.id, set: { attributes: { title: "Plan \"B\"", "data-new": "x" } } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    assert.ok(preview.notWritten.some((entry) => /data-new/u.test(entry.reason)), JSON.stringify(preview.notWritten));
    // A layer that did not come from the codebase cannot be written back.
    await edit([{ type: "insert-node", node: { id: "plain", type: "element", props: { tag: "div" } }, parentId: null, index: 0 }]);
    assert.equal((await call("POST", "/api/codebase/preview", { nodeId: "plain" })).status, 409);

    // Disconnecting ends it.
    const disconnect = await call("POST", "/api/codebase/disconnect", {});
    assert.equal(disconnect.json.folder, null);
    assert.equal((await call("POST", "/api/codebase/preview", { nodeId: section.id })).status, 409);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-back keeps the file's own changes, writes only the previewed plan, and lists what it leaves", async () => {
  const root = scratch();
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const path = join(code, "Note.jsx");
  const NOTE = `export function Note() {
  return (
    <article className="note" data-kind="tip" disabled>
      <h3>Title</h3>
      <p>Hello <b>you</b> there</p>
      <span>Footer</span>
    </article>
  );
}
`;
  writeFileSync(path, NOTE);
  chmodSync(path, 0o664);
  const host = await startStudioHost({ projectsRoot: projects, now });
  const call = async (method, route, body) => {
    const response = await fetch(`${host.url}${route}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  const edit = (operations) => call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Edit", operations });
  const find = (predicate) => Object.values(host.session.document.nodes).find(predicate);
  try {
    await call("POST", "/api/projects/create", { name: "notes" });
    await call("POST", "/api/codebase/connect", { folder: code });
    await call("POST", "/api/codebase/import", { file: "Note.jsx", component: "Note" });
    const article = find((node) => node.props.tag === "article");
    const h3 = find((node) => node.props.tag === "h3");
    const hello = find((node) => node.type === "text" && node.props.text.trim() === "Hello");
    const span = find((node) => node.props.tag === "span");
    assert.deepEqual(hello.props.codeSource, { file: "Note.jsx", component: "Note", path: "1", tag: "#text", textIndex: 0, base: { text: hello.props.text, props: {} } }, "a run of text is bound too");

    // Nothing changed: no spurious notes for the source's boolean prop.
    let preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    assert.deepEqual(preview.changes, []);
    assert.deepEqual(preview.notWritten, [], JSON.stringify(preview.notWritten));

    // A change in the file to a field the person did not touch is never undone.
    writeFileSync(path, readFileSync(path, "utf8").replace("<span>Footer</span>", "<span>Footer from the file</span>"));
    await edit([{ type: "set-props", nodeId: h3.id, set: { text: "Heading" } }, { type: "set-props", nodeId: hello.id, set: { text: "Hi " } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    assert.deepEqual(preview.changes.map((change) => `${change.field}:${change.to}`).sort(), ["text:Heading", "text:Hi "], "the run of text is written too");
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: article.id, token: preview.token })).status, 200);
    let after = readFileSync(path, "utf8");
    assert.match(after, /<h3>Heading<\/h3>/u);
    assert.match(after, /<p>Hi <b>you<\/b> there<\/p>/u, "the text's surroundings are kept");
    assert.match(after, /Footer from the file/u);
    assert.equal(statSync(path).mode & 0o777, writableMode(0o664), "the file keeps its permissions");
    preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    assert.deepEqual(preview.changes, [], "and nothing reverts it later");
    assert.equal(find((node) => node.id === span.id).props.codeSource.base.text, "Footer", "the untouched field keeps its base");

    // Only the previewed plan is written: a layer changed after the preview is refused.
    await edit([{ type: "set-props", nodeId: h3.id, set: { text: "Reviewed" } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    await edit([{ type: "set-props", nodeId: h3.id, set: { text: "Not reviewed" } }]);
    const refused = await call("POST", "/api/codebase/write", { nodeId: article.id, token: preview.token });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "plan-changed");
    assert.match(readFileSync(path, "utf8"), /<h3>Heading<\/h3>/u, "nothing was written");

    // What is not written is listed: an added layer, a moved one, a copied one.
    await edit([{ type: "insert-node", node: { id: "extra", type: "element", props: { tag: "em", text: "new" } }, parentId: article.id, index: 0 }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    assert.ok(preview.notWritten.some((entry) => entry.nodeId === "extra" && /added here/u.test(entry.reason)), JSON.stringify(preview.notWritten));
    await edit([{ type: "remove-node", nodeId: "extra" }, { type: "move-node", nodeId: span.id, parentId: article.id, index: 0 }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    assert.ok(preview.notWritten.some((entry) => /moved or reordered/u.test(entry.reason)), JSON.stringify(preview.notWritten));
    await edit([{ type: "move-node", nodeId: span.id, parentId: article.id, index: 2 }]);
    await edit([{ type: "insert-node", node: { id: "copy", type: "element", props: { ...find((node) => node.id === h3.id).props } }, parentId: article.id, index: 3 }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: article.id })).json;
    assert.deepEqual(preview.conflicts.filter((conflict) => /a copy/u.test(conflict.reason)).map((conflict) => conflict.nodeId).sort(), [h3.id, "copy"].sort());
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs of text: an expression is left alone, moved or removed runs are listed, and a child plans for its component", async () => {
  const root = scratch();
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const path = join(code, "Line.jsx");
  const LINE = `export function Line() {
  return (
    <div>
      <p>Hello <b>x</b>{" "}and more</p>
      <h2>Title</h2>
    </div>
  );
}
`;
  writeFileSync(path, LINE);
  const host = await startStudioHost({ projectsRoot: projects, now });
  const call = async (method, route, body) => {
    const response = await fetch(`${host.url}${route}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  const edit = (operations) => call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Edit", operations });
  const nodes = () => Object.values(host.session.document.nodes);
  try {
    await call("POST", "/api/projects/create", { name: "lines" });
    await call("POST", "/api/codebase/connect", { folder: code });
    await call("POST", "/api/codebase/import", { file: "Line.jsx", component: "Line" });
    const runs = nodes().filter((node) => node.props.codeSource?.tag === "#text").sort((a, b) => a.props.codeSource.textIndex - b.props.codeSource.textIndex);
    const h2 = nodes().find((node) => node.props.tag === "h2");
    const div = nodes().find((node) => node.props.tag === "div" && node.props.codeSource?.path === "");
    assert.equal(runs.length, 3, runs.map((run) => JSON.stringify(run.props.text)).join(","));

    // A child plans for its whole component: nothing spurious is listed.
    let preview = (await call("POST", "/api/codebase/preview", { nodeId: h2.id })).json;
    assert.deepEqual(preview.notWritten, [], JSON.stringify(preview.notWritten));

    // The {" "} run is an expression: left as it is, and listed. The others are written,
    // and read back as written.
    await edit(runs.map((run, index) => ({ type: "set-props", nodeId: run.id, set: { text: ["Z ", " plus ", "Z more"][index] } })));
    preview = (await call("POST", "/api/codebase/preview", { nodeId: h2.id })).json;
    assert.deepEqual(preview.changes.map((change) => change.to).sort(), ["Z ", "Z more"]);
    assert.ok(preview.notWritten.some((entry) => entry.nodeId === runs[1].id && /expression/u.test(entry.reason)), JSON.stringify(preview.notWritten));
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: h2.id, token: preview.token })).status, 200);
    assert.match(readFileSync(path, "utf8"), /<p>Z <b>x<\/b>\{" "\}Z more<\/p>/u, "the expression stays");
    preview = (await call("POST", "/api/codebase/preview", { nodeId: div.id })).json;
    assert.deepEqual(preview.conflicts, [], "the bindings still hold");
    assert.deepEqual(preview.changes, []);

    // A run moved into another element is listed, and never written to its old place.
    await edit([{ type: "move-node", nodeId: runs[2].id, parentId: h2.id, index: 0 }, { type: "set-props", nodeId: runs[2].id, set: { text: "Moved" } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: div.id })).json;
    assert.ok(preview.notWritten.some((entry) => entry.nodeId === runs[2].id && /moved or reordered/u.test(entry.reason)), JSON.stringify(preview.notWritten));
    assert.ok(!preview.changes.some((change) => change.to === "Moved"));
    // A run moved past an element sibling is out of place too.
    const hello = runs[0];
    const bold = nodes().find((node) => node.props.tag === "b");
    await edit([{ type: "move-node", nodeId: hello.id, parentId: hello.parentId, index: host.session.document.nodes[hello.parentId].children.indexOf(bold.id) + 1 }, { type: "set-props", nodeId: hello.id, set: { text: "Hi " } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: div.id })).json;
    assert.ok(preview.notWritten.some((entry) => entry.nodeId === hello.id && /moved or reordered/u.test(entry.reason)), JSON.stringify(preview.notWritten));
    assert.ok(!preview.changes.some((change) => change.to === "Hi "));
    // A run removed is listed.
    await edit([{ type: "remove-node", nodeId: runs[2].id }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: div.id })).json;
    assert.ok(preview.notWritten.some((entry) => /text removed/u.test(entry.reason)), JSON.stringify(preview.notWritten));
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one write-back carries many changed fields, and too many are refused by count (#256)", async () => {
  const root = scratch();
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const list = (items) => `export function List() {\n  return (\n    <section>\n${Array.from({ length: items }, (_, index) => `      <p title="Title ${index}">Item ${index}</p>`).join("\n")}\n    </section>\n  );\n}\n`;
  const host = await startStudioHost({ projectsRoot: projects, now });
  const call = async (method, path, body) => {
    const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  // Bring the list in, change the text of its first `changed` items (and their titles too
  // with `titles`) in one edit, and preview writing the section back.
  const changeAndPreview = async (file, changed, titles) => {
    assert.equal((await call("POST", "/api/codebase/import", { file, component: "List" })).status, 200);
    // The session hands out a fresh copy of the document on each read: read it once.
    const { document } = host.session;
    const section = Object.values(document.nodes).find((node) => node.props.tag === "section" && node.props.codeSource?.file === file);
    const items = section.children.map((id) => document.nodes[id]).slice(0, changed);
    const set = (node) => (titles ? { text: `Changed ${node.props.text}`, attributes: { ...node.props.attributes, title: `New ${node.props.attributes.title}` } } : { text: `Changed ${node.props.text}` });
    const edit = await call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Retext", operations: items.map((node) => ({ type: "set-props", nodeId: node.id, set: set(node) })) });
    assert.equal(edit.status, 200, JSON.stringify(edit.json));
    return { section, preview: await call("POST", "/api/codebase/preview", { nodeId: section.id }) };
  };
  try {
    await call("POST", "/api/projects/create", { name: "lists" });
    writeFileSync(join(code, "List.jsx"), list(300));
    writeFileSync(join(code, "Long.jsx"), list(2_501));
    assert.equal((await call("POST", "/api/codebase/connect", { folder: code })).status, 200);
    // 300 changed texts: more than the 128 one write-back used to carry.
    const { section, preview } = await changeAndPreview("List.jsx", 300, false);
    assert.equal(preview.status, 200, JSON.stringify(preview.json).slice(0, 300));
    const written = await call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.json.token });
    assert.equal(written.status, 200, JSON.stringify(written.json).slice(0, 300));
    const after = readFileSync(join(code, "List.jsx"), "utf8");
    for (let index = 0; index < 300; index += 1) assert.ok(after.includes(`<p title="Title ${index}">Changed Item ${index}</p>`), `item ${index}`);
    // 2,501 texts and titles are 5,002 changed fields: refused by count, and nothing is written.
    const before = readFileSync(join(code, "Long.jsx"), "utf8");
    const long = await changeAndPreview("Long.jsx", 2_501, true);
    const refused = long.preview;
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "patch-refused");
    assert.match(refused.json.error.message, /5002 changed fields, more than the 5000 one write-back can carry/u);
    const write = await call("POST", "/api/codebase/write", { nodeId: long.section.id, token: "0".repeat(64) });
    // Writing plans the change again before it checks the token, so the count refuses it too.
    assert.equal(write.status, 409, JSON.stringify(write.json));
    assert.equal(write.json.error.code, "patch-refused");
    assert.equal(readFileSync(join(code, "Long.jsx"), "utf8"), before);
    assert.deepEqual(readdirSync(code).sort(), ["List.jsx", "Long.jsx"], "no temporary file is left");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
