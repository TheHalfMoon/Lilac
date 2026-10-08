import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCodeIr, codeToDesign } from "../packages/code-ir/src/index.ts";
import { createDocument } from "../packages/document-model/src/index.mjs";
import { exportJsx, importJsx, startStudioHost } from "../packages/studio-host/src/index.ts";
import { browserTestOptions } from "./support/browser.mjs";
import { layerCount, openEditor, rendered, waitRevision } from "./support/editor.mjs";

// PC6 (#163): the design/code workflow through the product, over @ninerr/code-ir. A layer is
// exported as a JSX component exactly as the canvas draws it (the renderer's own
// sanitizer decides what is in it), and JSX is brought into the design as one undoable
// transaction. Closes PC gate 11.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

const card = () => createDocument({
  id: "doc",
  nodes: [
    { id: "card", type: "element", children: ["title", "buy", "note"], props: { name: "Price card", tag: "section", attributes: { class: "card", onclick: "steal()" }, style: { padding: "8px", color: "#123456", background: "url(https://evil.example/x)" } } },
    { id: "title", type: "element", parentId: "card", children: ["title-text"], props: { tag: "h2" } },
    { id: "title-text", type: "text", parentId: "title", props: { text: "Pro & Team" } },
    { id: "buy", type: "element", parentId: "card", props: { tag: "a", text: "Buy", attributes: { href: "https://example.com/buy" } } },
    { id: "note", type: "element", parentId: "card", props: { tag: "script", text: "x" } },
  ],
});

test("a layer exports as the JSX the canvas draws: sanitized, deterministic, round-trippable", () => {
  const exported = exportJsx(card(), "card");
  assert.equal(exported.componentName, "PriceCard");
  assert.equal(exported.layers, 4);
  assert.equal(exported.code, [
    "export function PriceCard() {",
    "  return (",
    "    <section className=\"card\" style=\"padding: 8px; color: #123456\">",
    "      <h2>Pro &amp; Team</h2>",
    "      <a href=\"https://example.com/buy\">Buy</a>",
    "      <div>x</div>",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n"), "no handler, no url() style, and a script becomes the inert element the canvas shows");
  assert.equal(exportJsx(card(), "card").code, exported.code, "deterministic");
  // code-ir reads it back to the same design.
  const ir = buildCodeIr([{ path: "PriceCard.jsx", content: exported.code }]);
  const design = codeToDesign(ir, ir.rootIds[0], "PriceCard");
  assert.equal(design.root.tag, "section");
  assert.deepEqual(design.root.children.map((child) => child.tag), ["h2", "a", "div"]);
  assert.equal(design.root.children[0].text, "Pro & Team", "entities read back as the text");
  assert.throws(() => exportJsx(card(), "missing"), /no such layer/u);
});

test("JSX comes into the design as layers, and refused code is reported, not guessed", () => {
  const { operations, componentName, layers } = importJsx(`export function Hero() {
  return (
    <header className="hero" style="background: #eef; padding: 24px">
      <h1 title="Main">Hello</h1>
      <Button variant="primary">Start</Button>
    </header>
  );
}
`);
  assert.equal(componentName, "Hero");
  assert.equal(layers, 3, "header, heading and button; the page frame holds them");
  assert.equal(operations.length, 1);
  const nodes = operations[0].nodes;
  const header = nodes[1];
  assert.deepEqual([header.props.tag, header.props.attributes, header.props.style], ["header", { class: "hero" }, { background: "#eef", padding: "24px" }]);
  assert.deepEqual([nodes[2].props.tag, nodes[2].props.text, nodes[2].props.attributes], ["h1", "Hello", { title: "Main" }]);
  assert.deepEqual([nodes[3].props.tag, nodes[3].props.name, nodes[3].props.attributes.variant], ["div", "Button", "primary"], "a component is kept as a named layer");
  assert.equal(header.props.name, "Hero", "the root layer carries the component's name");
  // The declared export's own element, by name.
  const pick = importJsx("function Icon() { return <svg />; }\nexport function Card() { return <div>card</div>; }");
  assert.equal(pick.componentName, "Card");
  assert.deepEqual([pick.operations[0].nodes[1].props.tag, pick.operations[0].nodes[1].props.text], ["div", "card"]);
  // A use of the name (<Button>) earlier in the file is not its definition.
  const used = importJsx("function App() { return <Button><span>x</span></Button>; }\nexport function Button() { return <button>b</button>; }");
  assert.deepEqual([used.componentName, used.operations[0].nodes[1].props.tag, used.operations[0].nodes[1].props.text], ["Button", "button", "b"]);
  // A commented-out export does not shadow the real one.
  assert.equal(importJsx("// export function Old() {}\nexport function New() { return <p>n</p>; }").componentName, "New");
  const second = importJsx("export function A() { return <p>a</p>; }\nfunction B() { return <i>b</i>; }");
  assert.equal(second.operations[0].nodes[1].props.tag, "p");
  // Code with anything code-ir cannot read is refused whole, never partly imported.
  for (const partial of [
    "export function A() { return <div onClick={go}>a</div>; }\nexport function B() { return <p>b</p>; }",
    "export function X() { return <p>a</p>; }\n<div {...rest}>b</div>",
  ]) assert.throws(() => importJsx(partial), (error) => error.code === "code-refused", partial);
  // Mixed text keeps its order around the elements.
  const mixed = importJsx("export function T() { return <p>Click <a href=\"https://example.com\">here</a> to start</p>; }").operations[0].nodes;
  const paragraph = mixed[1];
  assert.deepEqual(paragraph.children.map((id) => mixed.find((node) => node.id === id)).map((node) => node.props.tag ?? node.props.text), ["Click ", "a", " to start"]);
  // Booleans read as JSX means them; custom properties survive.
  const flags = importJsx("export function F() { return <div hidden={false} draggable={true} style=\"--brand: red; color: var(--brand)\">x</div>; }").operations[0].nodes[1].props;
  assert.deepEqual(flags.attributes, { draggable: "" });
  assert.deepEqual(flags.style, { "--brand": "red", color: "var(--brand)" });
  assert.throws(() => importJsx(""), /non-empty/u);
  assert.throws(() => importJsx("export function A() { return <>x</>; }"), (error) => error.code === "code-refused");
  assert.throws(() => importJsx("x".repeat(256 * 1024 + 1)), (error) => error.status === 413);
});

test("design and code through the editor: export the selection, bring code in, undo", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-code-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#new-project-name").fill("code");
    await page.keyboard.press("Enter");
    await waitRevision(page, 0);
    // Bring a component in from code.
    await page.locator("#action-code").click();
    assert.match(await page.locator("#dialog[open]").textContent(), /Select one layer to see it as code/u);
    await page.locator("#code-import").fill(`export function Hero() {
  return (
    <header className="hero" style="background: #eeeeff; padding: 24px">
      <h1>Hello from code</h1>
    </header>
  );
}`);
    await page.locator("#dialog[open] button.primary", { hasText: "Add to design" }).click();
    await waitRevision(page, 1);
    assert.equal(await layerCount(page), 3);
    const header = Object.values(host.session.document.nodes).find((node) => node.props.tag === "header").id;
    assert.equal(await rendered(page, header, "background-color"), "rgb(238, 238, 255)");
    assert.equal(await rendered(page, header, "text"), "Hello from code");
    // Edit it on the design side, then export the selected layer: the code follows.
    await page.locator(`[role=treeitem][data-node-id="${header}"] > .row`).click();
    await page.locator("#inspect-style-width").fill("600");
    await page.keyboard.press("Tab");
    await waitRevision(page, 2);
    await page.locator("#action-code").click();
    await page.locator("#dialog[open]").waitFor();
    const code = await page.locator("#code-export").inputValue();
    assert.match(code, /^export function [A-Z][A-Za-z0-9]*\(\) \{/u);
    assert.match(code, /<header className="hero" style="background: #eeeeff; padding: 24px; width: 600px">/u);
    assert.match(code, /<h1>Hello from code<\/h1>/u);
    // The exported code brought back in is the same design again.
    await page.locator("#code-import").fill(code);
    await page.locator("#dialog[open] button.primary", { hasText: "Add to design" }).click();
    await waitRevision(page, 3);
    const headers = Object.values(host.session.document.nodes).filter((node) => node.props.tag === "header");
    assert.equal(headers.length, 2);
    assert.deepEqual(headers[0].props.style, headers[1].props.style);
    // Undo removes the code that was brought in, in one step.
    await page.locator("[role=application]").focus();
    await page.keyboard.press("Control+z");
    await waitRevision(page, 4);
    assert.equal(Object.values(host.session.document.nodes).filter((node) => node.props.tag === "header").length, 1);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents read a layer as JSX through MCP get_jsx", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-code-mcp-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  try {
    const call = (path, body) => fetch(`${host.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
    await call("/api/projects/create", { name: "p" });
    const { token } = await call("/api/agents/create", { name: "Agent" });
    const added = await call("/api/code/import", { code: "export function Note() { return <p className=\"note\">Hi</p>; }" });
    assert.equal(added.tool, "ninerr:code");
    assert.equal(added.intent, "Bring in Note");
    const paragraph = Object.values(host.session.document.nodes).find((node) => node.props.tag === "p").id;
    const answer = await fetch(host.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_jsx", arguments: { nodeId: paragraph } } }) }).then((response) => response.json());
    assert.match(answer.result.structuredContent.code, /<p className="note">Hi<\/p>/u);
    assert.equal(answer.result.structuredContent.layers, 1);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
