import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodebaseLinks, MAX_SCAN_FILES, MAX_SOURCE_BYTES, assertFolder, readSourceFile, scanComponents, startStudioHost } from "../packages/studio-host/src/index.ts";

// PC11a (#182): a connected codebase. One local folder per project, whose JSX and TSX
// components the person brings into the design with their source and writes edits back
// to as a reviewed, three-way, atomic patch, confined to the folder.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + clock++ * 1000).toISOString();
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "lilac-codebase-")));
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
      assert.equal(statSync(join(root, ".lilac-codebases.json")).mode & 0o777, 0o600);
      chmodSync(join(root, ".lilac-codebases.json"), 0o666);
      assert.equal(new CodebaseLinks(root).get("site"), null, "a links file others can write is ignored");
    }
    links.set("site", null);
    assert.equal(new CodebaseLinks(root).get("site"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a codebase folder is an existing directory outside the projects folder, and files stay inside it", () => {
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
    assert.throws(() => assertFolder(projects, projects), /outside Lilac's projects folder/u);
    assert.throws(() => assertFolder(join(projects, "site"), projects), /outside Lilac's projects folder/u);
    assert.throws(() => assertFolder(root, projects), /outside Lilac's projects folder/u, "nor a folder that holds it");
    assert.throws(() => assertFolder("/", projects), /not the whole disk|outside/u);

    assert.equal(readSourceFile(code, "src/Card.jsx").content, CARD);
    for (const file of ["../secret.jsx", "src/../../secret.jsx", join(root, "secret.jsx"), "src//Card.jsx", "src/Card.js", ""]) {
      assert.throws(() => readSourceFile(code, file), /inside the connected folder|outside|not in/u, file);
    }
    symlinkSync(join(root, "secret.jsx"), join(code, "src", "Linked.jsx"));
    assert.throws(() => readSourceFile(code, "src/Linked.jsx"), /not a regular file/u, "a link is not followed");
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
    symlinkSync(join(code, "elsewhere"), join(code, "src", "linked"));
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
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, sha256: "0".repeat(64) })).status, 409);
    const written = await call("POST", "/api/codebase/write", { nodeId: section.id, sha256: preview.sha256 });
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
    await call("POST", "/api/codebase/write", { nodeId: section.id, sha256: preview.sha256 });
    const after = readFileSync(cardPath, "utf8");
    assert.match(after, /<h2>Team<\/h2>/u);
    assert.match(after, /All of Free, plus more\./u, "the file's own change is kept");
    assert.match(after, /className="card wide"/u, "the conflict is not written");

    // The file changing between the preview and the write is refused.
    await edit([{ type: "set-props", nodeId: h2Now.id, set: { text: "Teams" } }]);
    preview = (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;
    writeFileSync(cardPath, `${readFileSync(cardPath, "utf8")}\n`);
    const stale = await call("POST", "/api/codebase/write", { nodeId: section.id, sha256: preview.sha256 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "file-changed");
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
