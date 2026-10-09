import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { hostPool, ok } from "./support/host-api.mjs";

// P08-G3d (#230, founder section P08.3): hostile names and paths. Project names that try to
// leave the projects folder, name a device, end in a dot or a space, use a separator, a drive,
// a control character or a letter outside ASCII, or differ from a project's only by case; and
// codebase folders and source files with long, non-ASCII, relative, overlapping, hidden or
// deeply nested paths. Whatever the name or path:
// - the host never answers 500, and every refusal names a typed error;
// - a project is created only exactly inside the projects folder, opens only by its exact name,
//   and nothing appears outside the projects folder;
// - a codebase folder is connected only when it is an existing folder apart from the projects
//   folder, a scan lists exactly the components a person would expect (no hidden, skipped,
//   oversized, too-deep or non-source files), and a write-back changes only its own file.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + clock++ * 1000).toISOString();
const component = (name, heading) => `export function ${name}() {\n  return (\n    <section className="card">\n      <h2>${heading}</h2>\n    </section>\n  );\n}\n`;

/** Every entry under `root`, as relative paths, sorted. */
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort();
/** Whether a relative path is the projects folder or inside it (and not a sibling named like it). */
const inProjects = (entry) => entry === "projects" || entry.startsWith(`projects${sep}`);

const VALID = ["a", "site-2", "Plans.v2", "under_score", "x".repeat(64)];
const INVALID = [
  "", ".", "..", "a..b", "../outside", "..\\outside", "a/b", "a\\b", "C:", "C:x", "\\\\server\\share", "/abs",
  "con", "CON", "nul.txt", "com1", "LPT9.log", "aux", "trailing.", "trailing ", " leading", "-dash", ".hidden", "_under",
  "x".repeat(65), "é", "名前", "emoji😀", "a\u0000b", "a\tb", "a\nb", "a:b", "a*b", "a?b", "a|b", "a\"b", "a<b", "a>b", "%2e%2e", "~",
];

test("project names: only names that stay exactly inside the projects folder, opened by their exact name", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-names-")));
  const projects = join(base, "projects");
  mkdirSync(projects);
  const pool = hostPool(now);
  try {
    const { call } = await pool.open(projects);
    const outside = tree(base).filter((entry) => !inProjects(entry));
    for (const name of VALID) {
      const created = await call("POST", "/api/projects/create", { name });
      assert.equal(created.status, 200, `${JSON.stringify(name)}: ${JSON.stringify(created.json)}`);
      assert.ok(readdirSync(projects).includes(name), `${name} is a folder of exactly that name inside the projects folder`);
      await ok(call("POST", "/api/projects/close"), "close");
      assert.equal((await ok(call("POST", "/api/projects/open", { name }), `open ${name}`)).project, name);
      await ok(call("POST", "/api/projects/close"), "close");
    }
    for (const name of INVALID) {
      const created = await call("POST", "/api/projects/create", { name });
      assert.deepEqual([created.status, created.json?.error?.code], [400, "invalid-project-name"], `${JSON.stringify(name)} is refused as a name: ${JSON.stringify(created.json)}`);
      const opened = await call("POST", "/api/projects/open", { name });
      assert.deepEqual([opened.status, opened.json?.error?.code], [400, "invalid-project-name"], `${JSON.stringify(name)} cannot be opened: ${JSON.stringify(opened.json)}`);
    }
    // A name that differs from an existing project's only by case: neither created nor opened (#247).
    for (const name of ["A", "SITE-2", "plans.V2"]) {
      assert.deepEqual([(await call("POST", "/api/projects/create", { name })).json.error?.code, (await call("POST", "/api/projects/open", { name })).json.error?.code], ["project-exists", "project-not-found"], name);
    }
    // Only the host's own registry files (.ninerr-*) are not projects.
    assert.deepEqual(readdirSync(projects).filter((entry) => !/^\.ninerr-/u.test(entry)).sort(), [...VALID].sort(), "exactly the valid projects, and nothing else, were created");
    assert.deepEqual(tree(base).filter((entry) => !inProjects(entry)), outside, "nothing appeared outside the projects folder");
    assert.deepEqual((await ok(call("GET", "/api/projects"), "list")).projects.sort(), [...VALID].sort());
  } finally {
    await pool.closeAll();
    rmSync(base, { recursive: true, force: true });
  }
});

test("codebase folders and source files: hostile paths are refused, and a scan and a write-back stay exact", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-paths-")));
  const projects = join(base, "projects");
  mkdirSync(projects);
  const pool = hostPool(now);
  try {
    const { call } = await pool.open(projects);
    await ok(call("POST", "/api/projects/create", { name: "linked" }), "create");
    // Folders: refused when not an existing absolute folder apart from the projects folder.
    writeFileSync(join(base, "Card.jsx"), component("Card", "Pro"));
    for (const [folder, code] of [
      [projects, "folder-overlaps-projects"], [base, "folder-overlaps-projects"], [join(projects, "linked"), "folder-overlaps-projects"],
      ["code", "invalid-folder"], ["./code", "invalid-folder"], ["", "invalid-folder"], [join(base, "Card.jsx"), "not-a-folder"],
    ]) {
      const connected = await call("POST", "/api/codebase/connect", { folder });
      assert.equal(connected.json?.error?.code, code, `${JSON.stringify(folder)}: ${JSON.stringify(connected.json)}`);
      assert.ok(connected.status >= 400 && connected.status < 500);
    }
    const missing = await call("POST", "/api/codebase/connect", { folder: join(base, "missing") });
    assert.deepEqual([missing.status, missing.json.error.code], [404, "folder-not-found"]);

    // A folder with a long, non-ASCII path, past the 260 characters Windows once allowed.
    const folder = join(base, "Código コード", ...Array.from({ length: 5 }, (_, index) => `segment-${index}-${"x".repeat(50)}`));
    mkdirSync(folder, { recursive: true });
    assert.ok(folder.length > 260, `the folder path is ${folder.length} characters`);
    const listed = {
      "Card.jsx": component("Card", "Pro"),
      "カード.jsx": component("Kaado", "Pro"),
      "With Space.jsx": component("Spaced", "Pro"),
      [`${"L".repeat(150)}.tsx`]: component("Long", "Pro"),
      "nested/deeper/Deep.jsx": component("Deep", "Pro"),
      // Exactly at the scan's depth limit (8 folders deep): still listed.
      [`${Array.from({ length: 8 }, (_, index) => `d${index}`).join("/")}/AtLimit.jsx`]: component("AtLimit", "Pro"),
    };
    const unlisted = {
      ".hidden.jsx": component("Hidden", "Pro"),
      "node_modules/pkg/Dep.jsx": component("Dep", "Pro"),
      "dist/Built.jsx": component("Built", "Pro"),
      "Upper.JSX": component("Upper", "Pro"),
      "notes.md": "# notes",
      "Plain.jsx": "export const x = 1;\n",
      "Big.jsx": `${component("Big", "Pro")}// ${"x".repeat(256 * 1024)}\n`,
      // One folder past the scan's depth limit (8): just past it.
      [`${Array.from({ length: 9 }, (_, index) => `d${index}`).join("/")}/TooDeep.jsx`]: component("TooDeep", "Pro"),
    };
    for (const [file, content] of Object.entries({ ...listed, ...unlisted })) {
      mkdirSync(join(folder, file, ".."), { recursive: true });
      writeFileSync(join(folder, file), content);
    }
    // As is, with a trailing separator, and through a real ".." segment (join would remove it).
    for (const variant of [folder, `${folder}${sep}`, `${folder}${sep}nested${sep}..`]) {
      await ok(call("POST", "/api/codebase/connect", { folder: variant }), `connect ${variant.slice(-40)}`);
      const scan = await ok(call("GET", "/api/codebase"), "scan");
      assert.deepEqual(scan.components.map(({ file, component: name }) => `${file} ${name}`).sort(), ["Card.jsx Card", "With Space.jsx Spaced", "nested/deeper/Deep.jsx Deep", "d0/d1/d2/d3/d4/d5/d6/d7/AtLimit.jsx AtLimit", "カード.jsx Kaado", `${"L".repeat(150)}.tsx Long`].sort(), `a scan lists exactly the expected components (connected as ${variant.slice(-30)})`);
    }
    // Source file paths that leave the folder, or are not source files, are refused by name.
    for (const file of ["../Card.jsx", "/Card.jsx", "C:/Card.jsx", "nested\\deeper\\Deep.jsx", "Card.jsx:stream", "./Card.jsx", "notes.md", "Upper.JSX", "a\u0000.jsx", ""]) {
      const brought = await call("POST", "/api/codebase/import", { file, component: "Card" });
      assert.deepEqual([brought.status, brought.json?.error?.code], [400, "invalid-file"], `${JSON.stringify(file)}: ${JSON.stringify(brought.json)}`);
    }
    const absent = await call("POST", "/api/codebase/import", { file: "missing.jsx", component: "Card" });
    assert.deepEqual([absent.status, absent.json.error.code], [404, "file-not-found"]);
    // Every listed component comes in; a write-back to the non-ASCII file changes only that file.
    for (const [file, content] of Object.entries(listed)) {
      const name = /export function (\w+)/u.exec(content)[1];
      await ok(call("POST", "/api/codebase/import", { file, component: name }), `bring in ${file}`);
    }
    const { document, revision } = await ok(call("GET", "/api/document"), "document");
    const heading = Object.values(document.nodes).find((node) => node.props?.codeSource?.file === "カード.jsx" && node.props.tag === "h2");
    const section = Object.values(document.nodes).find((node) => node.props?.codeSource?.file === "カード.jsx" && node.props.tag === "section");
    const before = Object.fromEntries(Object.keys({ ...listed, ...unlisted }).map((file) => [file, readFileSync(join(folder, file))]));
    await ok(call("POST", "/api/edit", { baseRevision: revision, intent: "Retitle", operations: [{ type: "set-props", nodeId: heading.id, set: { text: "Équipe" } }] }), "edit");
    const preview = await ok(call("POST", "/api/codebase/preview", { nodeId: section.id }), "preview");
    await ok(call("POST", "/api/codebase/write", { nodeId: section.id, token: preview.token }), "write back");
    for (const [file, bytes] of Object.entries(before)) {
      if (file === "カード.jsx") assert.equal(readFileSync(join(folder, file), "utf8"), component("Kaado", "Équipe"), "the non-ASCII file got exactly the edit");
      else assert.deepEqual(readFileSync(join(folder, file)), bytes, `${file} is untouched`);
    }
  } finally {
    await pool.closeAll();
    rmSync(base, { recursive: true, force: true });
  }
});
