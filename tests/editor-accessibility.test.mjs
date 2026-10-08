import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCodeIr, codeToDesign } from "../packages/code-ir/src/index.ts";
import { accessibilityTreeFromDesignDoc, auditAccessibility } from "../packages/design-assurance/src/index.mjs";
import { exportJsx, importJsx, startStudioHost } from "../packages/studio-host/src/index.ts";
import { browserTestOptions } from "./support/browser.mjs";
import { layerCount, openEditor, waitRevision } from "./support/editor.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

// PC8 (#146): accessibility qualification of the editor UI and its generated output. Every
// editor state is audited with design-assurance's auditAccessibility, using the colours the
// browser actually paints; every editor action is done from the keyboard; the layout
// reflows at 320 px; targets are at least 24 px; exported code audits clean. Closes PC gate
// 12 with docs/evidence/PC8A_WCAG22_AA_CHECKLIST_2026-10-07.md.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

// The page's body as auditAccessibility's tree, skipping the canvas frame's content (it is
// inert and not exposed; the layers tree is its accessible form) and closed dialogs.
const snapshot = (page) => page.evaluate(() => {
  // Colours the contrast check cannot resolve (gradients, images, translucency, colour
  // spaces other than rgb) are reported, so a finding can never be masked by them.
  const unresolved = [];
  const opaque = (value) => value && value !== "transparent" && !/rgba\([^)]*,\s*0\)$/u.test(value);
  const backgroundOf = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor;
      if (opaque(background)) return background;
    }
    return "rgb(255, 255, 255)";
  };
  const visit = (element) => {
    const attributes = {};
    for (const attribute of element.attributes) attributes[attribute.name] = attribute.value;
    const computed = getComputedStyle(element);
    if (computed.display === "none" || computed.visibility === "hidden" || (element.localName === "dialog" && !element.open)) attributes.hidden = "";
    if (!attributes.hidden && (computed.backgroundImage !== "none" || Number(computed.opacity) < 1 || !/^rgba?\(/u.test(computed.color) || !/^rgba?\(/u.test(computed.backgroundColor))) unresolved.push(`${element.localName}#${element.id} ${computed.backgroundImage} ${computed.opacity} ${computed.color}`);
    if (element.inert || element.closest("[inert]")) attributes.hidden = "";
    const node = { tag: element.localName, attributes, children: [], style: `color: ${computed.color}; background-color: ${backgroundOf(element)}; font-size: ${computed.fontSize}; font-weight: ${computed.fontWeight}` };
    let text = "";
    for (const child of element.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1 && !["iframe", "script", "style"].includes(child.localName)) node.children.push(visit(child));
    }
    if (text.trim() !== "") node.text = text.trim();
    return node;
  };
  const tree = visit(document.body);
  return { tree, unresolved };
});

async function audit(page, state) {
  const { tree, unresolved } = await snapshot(page);
  assert.deepEqual(unresolved, [], `every colour is resolvable in: ${state}`);
  const { findings } = auditAccessibility(tree);
  assert.deepEqual(findings.map((finding) => `${finding.ruleId} at ${finding.path}: ${finding.message}`), [], `no findings in: ${state}`);
}

test("every editor state audits clean, with the colours actually painted", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-a11y-")));
  const host = await startStudioHost({ projectsRoot: root, now, confirmationWaitMs: 20_000 });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await audit(page, "the projects dialog");
    await page.locator("#new-project-name").fill("a11y");
    await page.keyboard.press("Enter");
    await waitRevision(page, 0);
    await audit(page, "an empty project");
    await page.locator("#action-insert-box").click();
    await waitRevision(page, 1);
    await page.locator("#action-insert-text").click();
    await waitRevision(page, 2);
    await audit(page, "layers, inspector and history");
    await page.locator("#action-agents").click();
    await audit(page, "the agents dialog");
    await page.locator("#agent-name").fill("Checker");
    await page.keyboard.press("Enter");
    await audit(page, "the agent credential dialog");
    const token = await page.locator("#agent-credential").inputValue();
    await page.locator("#dialog[open] button.primary").click();
    await page.locator("#action-import").click();
    await audit(page, "the import dialog");
    await page.locator("#import-html").fill("<main><h1>Hi</h1><img src=\"https://example.com/x.png\"></main>");
    await page.locator("#dialog[open] button.primary").click();
    await page.locator("#import-review").waitFor();
    await audit(page, "the import review");
    await page.locator("#dialog[open] button", { hasText: "Discard" }).click();
    await page.locator("#layers [role=treeitem] > .row").first().click();
    await page.locator("#action-code").click();
    await page.locator("#code-export").waitFor();
    await audit(page, "the code dialog");
    await page.keyboard.press("Escape");
    // An agent's request for approval.
    const box = Object.values(host.session.document.nodes).find((node) => node.id.startsWith("box-")).id;
    const pending = fetch(host.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_nodes", arguments: { nodeIds: [box] } } }) });
    await page.waitForFunction(() => /asks for your approval/u.test(document.getElementById("dialog-title")?.textContent ?? ""));
    await audit(page, "the approval dialog");
    await page.locator("#dialog[open] button", { hasText: "Decline" }).click();
    await pending;
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lock and recovery dialogs audit clean", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-a11y-lock-")));
  const setup = await startStudioHost({ projectsRoot: root, now });
  await fetch(`${setup.url}/api/projects/create`, { method: "POST", headers: { authorization: `Bearer ${setup.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "locked" }) });
  await setup.close();
  writeFileSync(join(root, "locked", PROJECT_FILES.directory, "lock"), JSON.stringify({ owner: "gone", pid: 2 ** 22 + 4321, at: "2026-10-07T11:00:00.000Z", nonce: "dead" }));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#dialog[open] [data-project=locked]").click();
    await page.locator("#lock-reason").waitFor();
    await audit(page, "the lock dialog");
    await page.locator("#lock-reason").fill("crashed");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Lilac recovered this project");
    await audit(page, "the recovery report");
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("every editor action works from the keyboard, with visible focus", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-a11y-keys-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    const focused = () => page.evaluate(() => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      return { id: element.id, label: element.getAttribute("aria-label") ?? element.textContent.trim().slice(0, 30), outline: style.outlineStyle !== "none" && style.outlineWidth !== "0px" };
    });
    // The projects dialog takes focus; create a project by typing.
    assert.equal((await focused()).id, "new-project-name");
    await page.keyboard.type("keys");
    await page.keyboard.press("Enter");
    await waitRevision(page, 0);
    // Tab reaches every toolbar control in order, each with a visible focus ring.
    await page.evaluate(() => document.activeElement.blur());
    const order = [];
    for (let index = 0; index < 16; index += 1) {
      await page.keyboard.press("Tab");
      const now = await focused();
      order.push(now.id || now.label);
      if (now.id !== "") assert.ok(now.outline, `${now.id} shows focus`);
    }
    for (const id of ["action-projects", "action-insert-box", "action-insert-text", "action-zoom-out", "action-zoom-in", "action-fit", "action-save", "action-import", "action-code", "action-agents"]) {
      assert.ok(order.includes(id), `${id} is reachable by Tab (order: ${order.join(", ")})`);
    }
    // Insert from the toolbar, then work in the layers tree.
    await page.locator("#action-insert-box").focus();
    await page.keyboard.press("Enter");
    await waitRevision(page, 1);
    await page.locator("#action-insert-text").focus();
    await page.keyboard.press("Enter");
    await waitRevision(page, 2);
    await page.locator("#layers [role=treeitem][tabindex='0']").focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowLeft"); // collapse the page
    assert.equal(await layerCount(page), 1);
    await page.keyboard.press("ArrowRight"); // expand it again
    assert.equal(await layerCount(page), 3);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    // The inspector by Tab: rename, then move with the step buttons (no dragging).
    await page.locator("#inspect-name").focus();
    await page.keyboard.type("Card");
    await page.keyboard.press("Tab");
    await waitRevision(page, 3);
    await page.locator("[aria-label='Move right 10 pixels']").focus();
    await page.keyboard.press("Enter");
    await waitRevision(page, 4);
    await page.locator(".steps button", { hasText: "Wider" }).focus();
    await page.keyboard.press("Space");
    await waitRevision(page, 5);
    const card = Object.values(host.session.document.nodes).find((node) => node.props.name === "Card");
    assert.deepEqual([card.props.style.left, card.props.style.width], ["42px", "170px"]);
    // The skip link reaches the canvas; arrows nudge; Delete removes; undo restores.
    // The skip link is the first thing in the tab order, is shown when focused, and lands
    // on the canvas, which shows its focus.
    const first = await page.evaluate(() => [...document.querySelectorAll("a[href], button, input, textarea, [tabindex]")].find((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)?.className);
    assert.equal(first, "skip-link");
    await page.locator(".skip-link").focus();
    assert.ok(await page.evaluate(() => document.querySelector(".skip-link").getBoundingClientRect().top >= 0), "visible on focus");
    await page.keyboard.press("Enter");
    const landed = await page.evaluate(() => ({ role: document.activeElement.getAttribute("role") }));
    assert.deepEqual(landed, { role: "application" }, "focus lands on the canvas");
    // The ring is painted on top of the design, even zoomed in so the design fills the canvas.
    for (let index = 0; index < 6; index += 1) await page.keyboard.press("Control+=");
    const stageBox = await page.locator("[role=application]").boundingBox();
    const shot = await page.screenshot({ clip: { x: stageBox.x, y: stageBox.y + stageBox.height / 2, width: 2, height: 1 } });
    const { PNG } = await import("./support/png.mjs");
    const pixel = PNG.firstPixel(shot);
    assert.deepEqual(pixel, [26, 95, 208], `the ring is visible at the canvas edge (got ${pixel})`);
    // The design frame is not a tab stop: Tab leaves the canvas for the next control.
    await page.keyboard.press("Tab");
    assert.notEqual(await page.evaluate(() => document.activeElement.localName), "iframe", "Tab does not stop on the design frame");
    await page.locator("[role=application]").focus();
    // With nothing selected, the arrows pan the view.
    await page.keyboard.press("Escape");
    const before = await page.evaluate(() => document.querySelector("[role=application] > div").style.transform);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    assert.notEqual(await page.evaluate(() => document.querySelector("[role=application] > div").style.transform), before, "arrow keys pan the canvas");
    // Select the card again from the tree, then nudge it on the canvas.
    await page.locator(`#layers [role=treeitem][data-node-id="${card.id}"]`).focus();
    await page.keyboard.press("Enter");
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await waitRevision(page, 6);
    await page.keyboard.press("Delete");
    await waitRevision(page, 7);
    await page.keyboard.press("Control+z");
    await waitRevision(page, 8);
    await page.keyboard.press("Control+Shift+z");
    await waitRevision(page, 9);
    await page.keyboard.press("Control+z");
    await waitRevision(page, 10);
    // Dialogs: open from the keyboard, Escape closes, focus returns to the opener.
    await page.locator("#action-agents").focus();
    await page.keyboard.press("Enter");
    await page.locator("#dialog[open]").waitFor();
    assert.equal((await focused()).id, "agent-name", "the dialog takes focus");
    await page.keyboard.press("Escape");
    assert.equal((await focused()).id, "action-agents", "focus returns to the opener");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Saved."));
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the editor reflows at 320 px and every target is at least 24 by 24 px", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-a11y-reflow-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#new-project-name").fill("small");
    await page.keyboard.press("Enter");
    await waitRevision(page, 0);
    await page.locator("#action-insert-box").click();
    await waitRevision(page, 1);
    await page.setViewportSize({ width: 320, height: 640 });
    const layout = await page.evaluate(() => {
      const visible = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= 321;
      };
      const rects = JSON.stringify(["layers","inspector","history","canvas"].map((id) => document.getElementById(id).getBoundingClientRect()));
      return { rects, scroll: document.documentElement.scrollWidth, layers: visible("layers"), inspector: visible("inspector"), history: visible("history"), canvas: visible("canvas") };
    });
    assert.ok(layout.scroll <= 320, `no horizontal scrolling at 320 px (width ${layout.scroll}) ${layout.rects}`);
    assert.deepEqual([layout.layers, layout.inspector, layout.history, layout.canvas], [true, true, true, true], `every panel is reachable without horizontal scrolling ${layout.rects}`);
    // Every dialog fits too.
    const fits = async (name) => {
      const box = await page.evaluate(() => {
        const dialog = document.querySelector("dialog[open]");
        return { scroll: dialog.scrollWidth, client: dialog.clientWidth, right: Math.max(...[...dialog.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right)) };
      });
      assert.ok(box.scroll <= box.client && box.right <= 320, `${name} fits at 320 px: ${JSON.stringify(box)}`);
      await page.keyboard.press("Escape");
    };
    for (const [button, name] of [["#action-import", "import"], ["#action-agents", "agents"], ["#action-code", "code"], ["#action-projects", "projects"]]) {
      await page.locator(button).click();
      await page.locator("dialog[open]").waitFor();
      await fits(name);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    const small = await page.evaluate(() => [...document.querySelectorAll("button, input, textarea, [role=treeitem] > .row, a[href]")]
      .filter((element) => element.getClientRects().length > 0 && !element.closest("dialog:not([open])"))
      .map((element) => ({ name: element.id || element.getAttribute("aria-label") || element.textContent.trim().slice(0, 20), rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width < 24 || rect.height < 24)
      .map(({ name, rect }) => `${name} ${Math.round(rect.width)}x${Math.round(rect.height)}`));
    assert.deepEqual(small, [], "WCAG 2.5.8 target size");
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated output audits clean: exported code and code brought into the design", () => {
  // A design made accessibly exports to code whose design audits clean.
  const { operations } = importJsx(`export function Signup() {
  return (
    <form aria-label="Sign up">
      <h1>Join</h1>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" />
      <button type="submit">Create account</button>
      <img src="data:image/png;base64,AA==" alt="Logo" />
    </form>
  );
}`);
  const document = { schemaVersion: 1, id: "d", name: "d", revision: 0, rootIds: [operations[0].rootId], nodes: Object.fromEntries(operations[0].nodes.map((node) => [node.id, node])), metadata: {} };
  const formId = operations[0].nodes[1].id;
  const { code } = exportJsx(document, formId);
  const ir = buildCodeIr([{ path: "Signup.jsx", content: code }]);
  const design = codeToDesign(ir, ir.rootIds[0], "Signup");
  assert.deepEqual(auditAccessibility(accessibilityTreeFromDesignDoc(design)).findings, []);
  // The audit is live: a missing alt and an unnamed button are found in exported output.
  const bad = importJsx("export function Bad() { return <div><img src=\"data:image/png;base64,AA==\" /><button></button></div>; }");
  const badDocument = { ...document, rootIds: [bad.operations[0].rootId], nodes: Object.fromEntries(bad.operations[0].nodes.map((node) => [node.id, node])) };
  const badCode = exportJsx(badDocument, bad.operations[0].nodes[1].id).code;
  const badIr = buildCodeIr([{ path: "Bad.jsx", content: badCode }]);
  const rules = auditAccessibility(accessibilityTreeFromDesignDoc(codeToDesign(badIr, badIr.rootIds[0], "Bad"))).findings.map((finding) => finding.ruleId).sort();
  assert.deepEqual(rules, ["a11y/button-name", "a11y/image-alt"]);
  // Two copies of the form under one parent export each id at most once.
  const twice = { ...document, rootIds: ["both"], nodes: { ...document.nodes, both: { id: "both", type: "element", parentId: null, children: [formId], props: { tag: "div" }, metadata: {} } } };
  const second = importJsx(`export function Again() { return (<form aria-label="Again"><label htmlFor="email">Email</label><input id="email" /></form>); }`).operations[0].nodes.slice(1);
  for (const node of second) twice.nodes[node.id] = { ...node, parentId: node.parentId.startsWith("page-code") ? "both" : node.parentId };
  twice.nodes.both.children.push(second[0].id);
  twice.nodes[formId] = { ...twice.nodes[formId], parentId: "both" };
  const exported = exportJsx(twice, "both").code;
  assert.equal((exported.match(/ id="email"/gu) ?? []).length, 1, "an id appears once");
  assert.match(exported, /htmlFor="email"[\s\S]*id="email"[\s\S]*htmlFor="email-2"[\s\S]*id="email-2"/u, "each copy's label names its own control");
});

test("pairing labels with controls is linear, and an export too large is refused before any work", () => {
  // Alternating labels and inputs that all share one id, so every label has many
  // candidates; in rows of 50 pairs (code-ir bounds the children of one element).
  const flat = (pairs) => {
    const nodes = [{ id: "form", type: "element", parentId: null, children: [], props: { tag: "form" }, metadata: {} }];
    let row = null;
    for (let index = 0; index < pairs; index += 1) {
      if (index % 50 === 0) {
        row = { id: `row${index}`, type: "element", parentId: "form", children: [], props: { tag: "div" }, metadata: {} };
        nodes.push(row);
        nodes[0].children.push(row.id);
      }
      nodes.push({ id: `l${index}`, type: "element", parentId: row.id, children: [], props: { tag: "label", text: "Email", attributes: { for: "x" } }, metadata: {} });
      nodes.push({ id: `i${index}`, type: "element", parentId: row.id, children: [], props: { tag: "input", attributes: { id: "x" } }, metadata: {} });
      row.children.push(`l${index}`, `i${index}`);
    }
    return { id: "doc", rootIds: ["form"], nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) };
  };
  const started = performance.now();
  const code = exportJsx(flat(2_000), "form").code;
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `2,000 label/control pairs export in ${elapsed.toFixed(0)} ms`);
  assert.match(code, /htmlFor="x-2000"[\s\S]*id="x-2000"/u, "each label still names its own (next) control");
  assert.equal((code.match(/ id="x-2000"/gu) ?? []).length, 1);
  // 10,000 layers: refused at once, as the limit says, not after pairing them.
  const refusedAt = performance.now();
  assert.throws(() => exportJsx(flat(5_000), "form"), /at most 5000 layers/u);
  assert.ok(performance.now() - refusedAt < 1_000, "refused before the pairing work");
});
