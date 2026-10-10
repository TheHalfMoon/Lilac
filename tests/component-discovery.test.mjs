import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportedComponents } from "../packages/code-ir/src/index.ts";
import { scanComponents } from "../packages/studio-host/src/index.ts";
import { MAX_SCAN_COMPONENTS } from "../packages/studio-host/src/codebase.ts";
import { hostPool, ok } from "./support/host-api.mjs";

// P08-G11 (#282): components are found as real projects declare them. Only
// `export function Name` was found, so a shadcn/ui file (function Button, then export {
// Button }), an `export const Name = (…) =>` component, a forwardRef or memo component and
// JSX in a .js file were never offered.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 11, 12, 0, 0) + clock++ * 1000).toISOString();

test("every way a file exports a function component is found, and nothing else", () => {
  const source = `import * as React from "react";
export function Declared() { return <p>a</p>; }
export default function Defaulted() { return <p>b</p>; }
export const Arrow = ({ title }: { title: string }) => <h2>{title}</h2>;
export const Forwarded = React.forwardRef<HTMLButtonElement>((props, ref) => <button ref={ref} {...props} />);
export const Memoized = memo(function Memoized() { return <i>m</i>; });
function Listed() { return <b>c</b>; }
const Renamed = () => <u>d</u>;
export { Listed, Renamed as Alias };
function Private() { return <s>e</s>; }
export function Helper() { return 42; }
export const config = { matcher: "/" };
export { Remote } from "./remote";
`;
  assert.deepEqual(exportedComponents("all.tsx", source), ["Declared", "Defaulted", "Arrow", "Forwarded", "Memoized", "Listed", "Renamed"]);
  assert.deepEqual(exportedComponents("default.jsx", "function App() { return <main />; }\nexport default App;\n"), ["App"]);
  assert.deepEqual(exportedComponents("memo.jsx", "export default memo(function Card() { return <p>card</p>; });\n"), ["Card"]);
  // A re-export names another file's component, even when this file has one of that name.
  assert.deepEqual(exportedComponents("shadow.jsx", "function Card() { return <p>local</p>; }\nexport { Card } from \"./card\";\n"), []);
  // A file Ninerr cannot read refuses, as reading it for its JSX does.
  assert.throws(() => exportedComponents("broken.jsx", "export function A() { return <p>; }"), /could not be parsed/u);
});

test("a scan finds components in .js, .jsx and .tsx files, in every export form", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ninerr-discovery-")));
  try {
    mkdirSync(join(root, "ui"));
    writeFileSync(join(root, "ui", "button.tsx"), `function Button({ className, ...props }: React.ComponentProps<"button">) {
  return <button data-slot="button" className={cn("btn", className)} {...props} />;
}
export { Button };
`);
    writeFileSync(join(root, "Header.js"), "import React from 'react';\nconst Header = () => <header>Conduit</header>;\nexport default Header;\n");
    writeFileSync(join(root, "utils.js"), "export function Capitalize(text) { return text.toUpperCase(); }\n");
    writeFileSync(join(root, "index.tsx"), "export { Button } from './ui/button';\n");
    writeFileSync(join(root, "Broken.jsx"), "export function Broken() { return <p>; }\n");
    const { components } = scanComponents(root);
    assert.deepEqual(components, [{ file: "Header.js", component: "Header" }, { file: "ui/button.tsx", component: "Button" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a component found only now is brought in and written back like any other", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ninerr-discovery-host-")));
  const pool = hostPool(now);
  t.after(async () => {
    await pool.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  const projects = join(root, "projects");
  const code = join(root, "app");
  mkdirSync(projects);
  mkdirSync(code);
  const HEADER = "import React from 'react';\nconst Header = () => (\n  <header className=\"navbar\">\n    <a href=\"/\">conduit</a>\n  </header>\n);\nexport default Header;\n";
  writeFileSync(join(code, "Header.js"), HEADER);
  const { call } = await pool.open(projects);
  await ok(call("POST", "/api/projects/create", { name: "site" }), "create");
  const scan = await ok(call("POST", "/api/codebase/connect", { folder: code }), "connect");
  assert.deepEqual(scan.components, [{ file: "Header.js", component: "Header" }]);
  const brought = await ok(call("POST", "/api/codebase/import", { file: "Header.js", component: "Header" }), "bring in");
  const { document, revision } = await ok(call("GET", "/api/document"), "document");
  const header = document.nodes[document.nodes[brought.frameId].children[0]];
  const link = document.nodes[header.children[0]];
  assert.deepEqual([header.props.tag, header.props.attributes, link.props.text], ["header", { class: "navbar" }, "conduit"]);
  await ok(call("POST", "/api/edit", { baseRevision: revision, intent: "Rename", operations: [{ type: "set-props", nodeId: link.id, set: { text: "Conduit" } }] }), "edit");
  const plan = await ok(call("POST", "/api/codebase/preview", { nodeId: header.id }), "preview");
  await ok(call("POST", "/api/codebase/write", { nodeId: header.id, token: plan.token }), "write");
  assert.equal(readFileSync(join(code, "Header.js"), "utf8"), HEADER.replace(">conduit<", ">Conduit<"));
});

test("a component exported through memo(…) or a type assertion by name is found", () => {
  const card = "function Card() { return <p>card</p>; }\n";
  assert.deepEqual(exportedComponents("a.jsx", `${card}export default memo(Card);\n`), ["Card"]);
  assert.deepEqual(exportedComponents("b.tsx", `${card}export default React.memo(Card);\n`), ["Card"]);
  assert.deepEqual(exportedComponents("c.tsx", `${card}export default Card satisfies FC;\n`), ["Card"]);
  assert.deepEqual(exportedComponents("d.jsx", `${card}export default connect(map)(Card);\n`), [], "other wrappers are not followed");
});

test("a scan skips built output and stops at its parse budget, quickly, and sees changed files", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ninerr-discovery-budget-")));
  try {
    const component = (name) => `export function ${name}() { return <p>${name}</p>; }\n`;
    mkdirSync(join(root, "src"));
    for (const folder of ["out", "coverage"]) {
      mkdirSync(join(root, folder));
      writeFileSync(join(root, folder, "Built.jsx"), component("Built"));
    }
    writeFileSync(join(root, "src", "Card.jsx"), component("Card"));
    writeFileSync(join(root, "src", "vendor.min.js"), component("Minified"));
    // One long line: a bundle, not source a person edits.
    writeFileSync(join(root, "src", "bundle.js"), `${component("Bundled").trim()}${";var x=1".repeat(2000)}\n`);
    assert.deepEqual(scanComponents(root).components, [{ file: "src/Card.jsx", component: "Card" }]);
    // A changed file is read again.
    writeFileSync(join(root, "src", "Card.jsx"), `${component("Card")}${component("Badge")}`);
    assert.deepEqual(scanComponents(root).components.map((entry) => entry.component), ["Card", "Badge"]);

    // A folder of near-limit sources is cut short at the budget, in bounded time.
    const many = join(root, "many");
    mkdirSync(many);
    const body = Array.from({ length: 2000 }, (_, index) => `export const C${index} = () => <p title="${"x".repeat(60)}">${index}</p>;`).join("\n");
    for (let index = 0; index < 40; index += 1) writeFileSync(join(many, `F${index}.jsx`), body);
    const started = performance.now();
    const scan = scanComponents(many);
    const elapsed = performance.now() - started;
    assert.equal(scan.truncated, true);
    assert.ok(scan.components.length <= MAX_SCAN_COMPONENTS);
    assert.ok(elapsed < 10_000, `the scan took ${Math.round(elapsed)} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
