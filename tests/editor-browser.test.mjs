import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { browserTestOptions, findBrowser } from "./support/browser.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

// PC4 (#146): the editor end to end, in Chromium, against a real studio host on loopback.
// Creating and reopening projects, editing through the canvas, layers tree and inspector,
// attributed history with undo and redo, and the lock and recovery dialogs, all driven
// through the editor's own UI (mostly from the keyboard). Closes PC gates 1, 3, 4 and 9.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

async function openEditor(host) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const foreign = [];
  const errors = [];
  // Nothing may leave the host's origin.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${host.url}/`)) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(host.launchUrl());
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  return { browser, page, foreign, errors, close: () => browser.close() };
}

// A rendered layer's centre in page coordinates, through the canvas's transformed frame.
const screenOf = (page, id) => page.evaluate((nodeId) => {
  const frame = document.querySelector("iframe");
  const outer = frame.getBoundingClientRect();
  const zoom = outer.width / frame.offsetWidth;
  const inner = frame.contentDocument.querySelector(`[data-ninerr-id="${nodeId}"]`).getBoundingClientRect();
  return { x: outer.left + (inner.left + inner.width / 2) * zoom, y: outer.top + (inner.top + inner.height / 2) * zoom };
}, id);
const layerCount = (page) => page.locator("#layers [role=treeitem]").count();
const waitRevision = (page, revision) => page.waitForFunction((r) => document.getElementById("revision").textContent === `Revision ${r}`, revision);
const historyIntents = (page) => page.locator("#history li .intent").allTextContents();

test("create, edit, undo and redo, save and reopen a project through the editor", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-")));
  let host = await startStudioHost({ projectsRoot: root, now });
  let editor = await openEditor(host);
  try {
    let { page } = editor;
    // The launch ticket is gone from the address bar and is single-use.
    assert.equal(new URL(page.url()).search, "");
    // No project yet: the projects dialog opens; create one from the keyboard.
    await page.locator("#dialog[open]").waitFor();
    await page.locator("#new-project-name").focus();
    await page.keyboard.type("alpha");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("project-name").textContent === "alpha");
    await waitRevision(page, 0);
    assert.equal(await page.locator("#dialog[open]").count(), 0);

    // Insert a box from the toolbar with the keyboard: the empty project gets a page too.
    await page.locator("#action-insert-box").focus();
    await page.keyboard.press("Enter");
    await waitRevision(page, 1);
    assert.equal(await layerCount(page), 2);
    const boxId = await page.locator("#layers [role=treeitem][aria-selected=true]").getAttribute("data-node-id");
    assert.match(boxId, /^box-/u, "the new box is selected");

    // Restyle it in the inspector: Tab commits the field.
    await page.locator("#inspect-style-width").fill("200");
    await page.keyboard.press("Tab");
    await waitRevision(page, 2);
    assert.equal(host.session.document.nodes[boxId].props.style.width, "200px");
    // Drag it on the canvas, then resize it from the handle: one transaction each.
    const centre = await screenOf(page, boxId);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 20, centre.y + 10, { steps: 4 });
    await page.mouse.up();
    await waitRevision(page, 3);
    assert.deepEqual([host.session.document.nodes[boxId].props.style.left, host.session.document.nodes[boxId].props.style.top], ["52px", "42px"]);
    const handle = await page.locator("[data-ninerr-handle]").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 20, handle.y + handle.height / 2 + 10, { steps: 4 });
    await page.mouse.up();
    await waitRevision(page, 4);
    assert.deepEqual([host.session.document.nodes[boxId].props.style.width, host.session.document.nodes[boxId].props.style.height], ["180px", "110px"]);
    // Put it back from the inspector.
    await page.locator("#inspect-style-left").fill("32");
    await page.keyboard.press("Tab");
    await waitRevision(page, 5);
    await page.locator("#inspect-style-top").fill("32");
    await page.keyboard.press("Tab");
    await waitRevision(page, 6);
    await page.locator("#inspect-style-width").fill("200");
    await page.keyboard.press("Tab");
    await waitRevision(page, 7);
    await page.locator("#inspect-name").fill("Hero card");
    await page.keyboard.press("Tab");
    await waitRevision(page, 8);
    assert.equal(await page.locator(`#layer-${boxId} .label`).textContent(), "Hero card", "the layers tree shows the new name");

    // Insert text inside the box (it is selected) and edit the text.
    await page.locator("#action-insert-text").focus();
    await page.keyboard.press("Enter");
    await waitRevision(page, 9);
    const textId = await page.locator("#layers [role=treeitem][aria-selected=true]").getAttribute("data-node-id");
    assert.equal(host.session.document.nodes[textId].parentId, boxId);
    await page.locator("#inspect-text").fill("Hello from Ninerr");
    await page.keyboard.press("Tab");
    await waitRevision(page, 10);
    assert.equal(host.session.document.nodes[textId].props.text, "Hello from Ninerr");

    // Select the box from the layers tree with the keyboard, then nudge it on the canvas.
    await page.locator(`#layer-${textId}`).focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(`#layer-${boxId}`).getAttribute("aria-selected"), "true");
    await page.locator("[role=application]").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await waitRevision(page, 11);
    assert.equal(host.session.document.nodes[boxId].props.style.left, "42px");
    // The canvas shows it: the rendered element moved with the document.
    const left = await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${id}"]`).style.left, boxId);
    assert.equal(left, "42px");

    // Undo and redo from the keyboard are committed, attributed transactions.
    await page.keyboard.press("Control+z");
    await waitRevision(page, 12);
    assert.equal(host.session.document.nodes[boxId].props.style.left, "32px");
    await page.keyboard.press("Control+Shift+z");
    await waitRevision(page, 13);
    assert.equal(host.session.document.nodes[boxId].props.style.left, "42px");
    assert.deepEqual(await historyIntents(page), ["Nudge layer", "Undo: Nudge layer", "Nudge layer", "Edit text", "Insert text", "Rename layer", "Change style", "Change style", "Change style", "Resize layer", "Move layer", "Change style", "Insert box"]);
    assert.equal(await page.locator("#history li").first().locator(".who").textContent(), "You · revision 13");

    // Delete the text from the layers tree.
    await page.locator(`#layer-${boxId}`).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Delete");
    await waitRevision(page, 14);
    assert.equal(host.session.document.nodes[textId], undefined);
    assert.equal(await layerCount(page), 2);

    // Save, then reload the page: the tab keeps its session, and the document is unchanged.
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Saved."));
    const saved = JSON.stringify(host.session.document);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    await waitRevision(page, 14);
    assert.equal(await layerCount(page), 2);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
    await editor.close();

    // Quit and start Ninerr again: the project reopens from disk exactly as it was.
    await host.close();
    host = await startStudioHost({ projectsRoot: root, now });
    editor = await openEditor(host);
    page = editor.page;
    await page.locator("#dialog[open] [data-project=alpha]").click();
    await waitRevision(page, 14);
    assert.deepEqual(host.session.document, JSON.parse(saved));
    assert.equal(await page.locator(`#layer-${boxId} .label`).textContent(), "Hero card");
    // The renderer shows the reopened document.
    assert.equal(await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${id}"]`).style.width, boxId), "200px");
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changes made elsewhere appear live, typing in progress is kept, and undo follows them", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-live-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#new-project-name").fill("live");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("project-name").textContent === "live");
    await waitRevision(page, 0);
    await page.locator("#action-insert-box").click();
    await waitRevision(page, 1);
    const boxId = await page.locator("#layers [role=treeitem][aria-selected=true]").getAttribute("data-node-id");

    // Another client of the same host edits the document: the editor applies the event.
    const call = (path, body) => fetch(`${host.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
    await call("/api/edit", { baseRevision: 1, intent: "Recolour from script", operations: [{ type: "set-props", nodeId: boxId, set: { style: { ...host.session.document.nodes[boxId].props.style, background: "#ff0000" } } }] });
    await waitRevision(page, 2);
    assert.equal(await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${id}"]`).style.background, boxId), "rgb(255, 0, 0)");
    assert.equal((await historyIntents(page))[0], "Recolour from script");
    assert.equal(await page.locator("#inspect-style-background").inputValue(), "#ff0000", "the inspector shows the new value");

    // Someone is typing in the inspector when another change arrives: the typing is kept.
    await page.locator("#inspect-style-color").fill("navy");
    await call("/api/edit", { baseRevision: 2, intent: "Resize from script", operations: [{ type: "set-props", nodeId: boxId, set: { style: { ...host.session.document.nodes[boxId].props.style, height: "120px" } } }] });
    await waitRevision(page, 3);
    assert.equal(await page.locator("#inspect-style-color").inputValue(), "navy");
    await page.keyboard.press("Tab");
    await waitRevision(page, 4);
    assert.equal(host.session.document.nodes[boxId].props.style.color, "navy");
    assert.equal(host.session.document.nodes[boxId].props.style.height, "120px", "the typed edit did not overwrite the other change");

    await call("/api/edit", { baseRevision: 4, intent: "Script", operations: [{ type: "set-props", nodeId: boxId, set: { name: "From script" } }] });
    await waitRevision(page, 5);
    assert.equal(await page.locator(`#layer-${boxId} .label`).textContent(), "From script");

    // A client using the same identity deletes the box: the canvas drops it live, and the
    // editor's undo (the same person's latest change) brings it back, in the canvas too.
    await call("/api/edit", { baseRevision: 5, intent: "Delete from script", operations: [{ type: "remove-node", nodeId: boxId }] });
    await waitRevision(page, 6);
    assert.equal(await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${id}"]`), boxId), null);
    assert.equal(await layerCount(page), 1);
    await page.locator("[role=application]").focus();
    await page.keyboard.press("Control+z");
    await waitRevision(page, 7);
    assert.equal(await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${id}"]`)?.style.color, boxId), "navy");
    assert.equal((await historyIntents(page))[0], "Undo: Delete from script");
    assert.equal(await page.locator("#revision").textContent(), "Revision 7");
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock takeover, crash recovery and reopen-after-failure are handled in the editor", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-recovery-")));
  const setup = await startStudioHost({ projectsRoot: root, now });
  const token = { authorization: `Bearer ${setup.token}`, "content-type": "application/json" };
  await fetch(`${setup.url}/api/projects/create`, { method: "POST", headers: token, body: JSON.stringify({ name: "crashed" }) });
  await setup.close();
  // A crash leaves a lock from a process that no longer exists and a torn journal tail.
  writeFileSync(join(root, "crashed", PROJECT_FILES.directory, "lock"), JSON.stringify({ owner: "crashed-studio", pid: 2 ** 22 + 4321, at: "2026-10-07T11:00:00.000Z", nonce: "dead" }));
  appendFileSync(join(root, "crashed", PROJECT_FILES.directory, "journal.log"), '{"digest":"torn');

  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    // While another live session holds the project, a takeover is refused, with a message.
    const { StudioSession } = await import("../packages/studio-host/src/index.ts");
    writeFileSync(join(root, "crashed", PROJECT_FILES.directory, "lock.bak"), "");
    rmSync(join(root, "crashed", PROJECT_FILES.directory, "lock.bak"));
    const { readFileSync: readLock } = await import("node:fs");
    const deadLock = readLock(join(root, "crashed", PROJECT_FILES.directory, "lock"), "utf8");
    const torn = readLock(join(root, "crashed", PROJECT_FILES.directory, "journal.log"));
    rmSync(join(root, "crashed", PROJECT_FILES.directory, "lock"));
    const live = StudioSession.open({ projectsRoot: root, name: "crashed", owner: { actorId: "other", kind: "user", accessClass: "member", displayName: "Other" }, now });
    await page.locator("#dialog[open] [data-project=crashed]").click();
    await page.locator("#lock-reason").fill("I think it crashed");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /still running/u.test(document.querySelector("#dialog[open] .error")?.textContent ?? ""));
    await page.keyboard.press("Escape");
    live.close();
    // Put the crash back: the dead session's lock and the torn tail.
    writeFileSync(join(root, "crashed", PROJECT_FILES.directory, "lock"), deadLock);
    writeFileSync(join(root, "crashed", PROJECT_FILES.directory, "journal.log"), torn);
    await page.locator("#action-projects").click();
    await page.locator("#dialog[open] [data-project=crashed]").click();
    // The lock dialog explains, and refuses a takeover without a reason.
    await page.locator("#dialog[open] #lock-reason").waitFor();
    assert.match(await page.locator("#dialog-title").textContent(), /open elsewhere/u);
    await page.locator("#dialog[open] button.danger").click();
    assert.match(await page.locator("#dialog[open] .error").textContent(), /reason/u);
    await page.locator("#lock-reason").fill("the previous session crashed");
    await page.keyboard.press("Enter");
    // Recovery is reported: the lock takeover and the discarded torn write.
    await page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Ninerr recovered this project");
    const report = await page.locator("#dialog[open] ul.report li").allTextContents();
    assert.equal(report.length, 2);
    assert.match(report[0], /unfinished write.*discarded \(15 bytes\)/u);
    assert.match(report[1], /stale lock held by crashed-studio was taken over: the previous session crashed/u);
    await page.locator("#dialog[open] button.primary").click();
    assert.equal(await page.locator("#project-name").textContent(), "crashed");
    assert.equal(host.session.recovery.lockOverride.reason, "the previous session crashed");

    // The project's files change outside Ninerr: the next edit asks for a reopen, which works.
    appendFileSync(join(root, "crashed", PROJECT_FILES.directory, "journal.log"), "tampered\n");
    await page.locator("#action-insert-box").click();
    await page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Reopen the project");
    assert.equal(await page.locator("#dialog[open] p").first().textContent().then((text) => /reopen/u.test(text)), true);
    assert.doesNotMatch(await page.locator("#dialog[open]").textContent(), new RegExp(root.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"), "u"), "no filesystem path is shown");
    // Undo the tampering, as a person restoring their files would, and reopen.
    const journal = join(root, "crashed", PROJECT_FILES.directory, "journal.log");
    const { readFileSync } = await import("node:fs");
    writeFileSync(journal, readFileSync(journal, "utf8").replace(/tampered\n$/u, ""));
    await page.locator("#dialog[open] button.primary").click();
    await page.waitForFunction(() => !document.getElementById("dialog").open);
    await page.locator("#action-insert-box").click();
    await waitRevision(page, 1);
    assert.equal(await layerCount(page), 2);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors.filter((message) => !/409/u.test(message)), [], "only the refused edit's 409 is logged");
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a change that arrives while the editor is refreshing is not lost", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-race-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#new-project-name").fill("first");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("project-name").textContent === "first");
    await waitRevision(page, 0);
    await page.locator("#action-insert-box").click();
    await waitRevision(page, 1);
    // Hold the editor's next history fetch, so its refresh is in flight while changes land.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/history", async (route) => {
      await gate;
      await route.continue();
    });
    const call = (path, body) => fetch(`${host.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
    // Another client opens a second project and edits it at once.
    await call("/api/projects/create", { name: "second" });
    // The editor starts loading the new project; its history fetch is held.
    await page.waitForRequest("**/api/history");
    await call("/api/edit", { baseRevision: 0, intent: "First layer", operations: [{ type: "insert-node", node: { id: "b1", type: "element", props: { tag: "div" } }, parentId: null, index: 0 }] });
    await call("/api/edit", { baseRevision: 1, intent: "Second layer", operations: [{ type: "insert-node", node: { id: "b2", type: "element", props: { tag: "div" } }, parentId: null, index: 1 }] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await waitRevision(page, 2);
    assert.equal(await page.locator("#project-name").textContent(), "second");
    assert.equal(await layerCount(page), 2, "both changes are on the canvas and in the tree");
    assert.deepEqual(await historyIntents(page), ["Second layer", "First layer"]);
    assert.equal(await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelectorAll("[data-ninerr-id]").length), 2);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a project switch during a load ends on the project the host has open", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-switch-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const call = (path, body) => fetch(`${host.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((response) => response.json());
  const insert = (revision, id) => call("/api/edit", { baseRevision: revision, intent: id, operations: [{ type: "insert-node", parentId: null, index: 0, node: { id, type: "element", props: { tag: "div" } } }] });
  await call("/api/projects/create", { name: "b" });
  await call("/api/projects/create", { name: "a" });
  await insert(0, "a1");
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await waitRevision(page, 1);
    // The next session answer is fetched at once but delivered late: it names b.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let hold = true;
    await page.route("**/api/session", async (route) => {
      if (!hold) return route.continue();
      hold = false;
      const response = await route.fetch();
      await gate;
      return route.fulfill({ response });
    });
    await call("/api/projects/open", { name: "b" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await call("/api/projects/open", { name: "a" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await insert(1, "a2");
    await insert(2, "a3");
    await waitRevision(page, 3);
    assert.equal(await page.locator("#project-name").textContent(), "a");
    assert.equal(await layerCount(page), 3);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused event stream is retried with backoff, not in a loop, and resumes", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-streams-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  // Another token holder takes every stream slot.
  const taken = [];
  for (let index = 0; index < 32; index += 1) {
    const controller = new AbortController();
    await fetch(`${host.url}/api/events?token=${host.token}`, { signal: controller.signal });
    taken.push(controller);
  }
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    let streams = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/events")) streams += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(streams <= 4, `${streams} stream attempts in 3 s`);
    // Slots free up: the editor reconnects, refreshes, and sees changes again.
    for (const controller of taken) controller.abort();
    await fetch(`${host.url}/api/projects/create`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "later" }) });
    await page.waitForFunction(() => document.getElementById("project-name").textContent === "later", null, { timeout: 20_000 });
    assert.deepEqual(editor.foreign, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent's MCP changes appear live, ask the person before deleting, and can be reverted", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-editor-agent-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#new-project-name").fill("shared");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("project-name").textContent === "shared");
    await waitRevision(page, 0);

    // The person connects an agent in the editor; the credential is shown once.
    await page.locator("#action-agents").click();
    await page.locator("#agent-name").fill("Claude Code");
    await page.keyboard.press("Enter");
    const token = await page.locator("#agent-credential").inputValue();
    assert.match(token, /^ninerr_agent_/u);
    assert.equal(await page.locator("#dialog[open] pre.setup").last().textContent(), host.mcpUrl);
    await page.locator("#dialog[open] button.primary").click();

    let id = 0;
    const tool = (name, args) => fetch(host.mcpUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    }).then((response) => response.json()).then((answer) => answer.result);
    // Like an MCP client, the agent connects first (#260).
    await fetch(host.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });

    // Agent edits appear on the canvas and in the tree as they are committed.
    const frameId = (await tool("create_frame", { name: "Landing", width: 640, height: 400 })).structuredContent.nodeId;
    await waitRevision(page, 1);
    assert.equal(await page.locator(`#layer-${frameId} .label`).textContent(), "Landing");
    assert.equal(await page.evaluate((nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${nodeId}"]`)?.style.width, frameId), "640px");
    await tool("set_styles", { updates: [{ nodeId: frameId, styles: { background: "#123456" } }] });
    await waitRevision(page, 2);
    assert.equal(await page.evaluate((nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-ninerr-id="${nodeId}"]`).style.background, frameId), "rgb(18, 52, 86)");
    // The history attributes the changes to the agent, by name, with its tool.
    const latest = page.locator("#history li").first();
    assert.equal(await latest.getAttribute("class"), "agent");
    assert.equal(await latest.locator(".who").textContent(), "Claude Code · agent · set_styles · revision 2");
    // The agent sees the person's selection.
    await page.locator(`#layer-${frameId}`).click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await tool("selection", {})).structuredContent.nodes.map((node) => node.id), [frameId]);

    // Deleting asks the person in the editor; declining leaves the layer.
    const declined = tool("delete_layers", { nodeIds: [frameId] });
    await page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Claude Code asks for your approval");
    assert.match(await page.locator("#dialog[open] .request").textContent(), /^Delete 1 layer: Landing \(main\)$/u);
    await page.locator("#dialog[open] button", { hasText: "Decline" }).click();
    assert.match((await declined).content[0].text, /declined/u);
    assert.equal(await layerCount(page), 1);
    // Approving lets it through; the canvas drops the layer.
    const approved = tool("delete_layers", { nodeIds: [frameId] });
    // (The new request may arrive before the decline's answer; its dialog must stay open.)
    await page.locator("#dialog[open] button:not([disabled])", { hasText: "Approve" }).click();
    assert.equal((await approved).isError, undefined);
    await waitRevision(page, 3);
    assert.equal(await layerCount(page), 0);
    // The person reverts the agent's delete from the history: the layer is back.
    await page.locator("#history li").first().locator("button.revert").click();
    await waitRevision(page, 4);
    assert.equal(await layerCount(page), 1);
    assert.equal((await historyIntents(page))[0], "Revert: Delete layer");
    assert.match(await page.locator("#history li").first().locator(".who").textContent(), /^You /u);
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
