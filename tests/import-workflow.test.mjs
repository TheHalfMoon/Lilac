import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_IMPORT_HTML_BYTES, MAX_IMPORT_NODES, startStudioHost, styleProperties } from "../packages/studio-host/src/index.ts";
import { browserTestOptions } from "./support/browser.mjs";
import { layerCount, openEditor, rendered, waitRevision } from "./support/editor.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

// PC6 (#146): importing HTML through the product. The import stack sanitizes it offline,
// intake reviews it, the person decides in the editor, and the commit is one attributed,
// undoable history transaction; then edit, save and reopen. Closes PC gate 10.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, 0) + clock++ * 1000).toISOString();

const PAGE = `<!doctype html><html><head><title>Pricing</title><style>.lead { color: red }</style><script>alert("x")</script>
<link rel="stylesheet" href="https://cdn.example.com/site.css"></head>
<body><main><h1 class="lead" style="color: #224466; font-size: 40px">Pricing</h1>
<p onclick="steal()">Simple plans for <a href="javascript:steal()">teams</a>.</p>
<a href="https://example.com/signup" style="background: url(https://evil.example/x.png)">Sign up</a>
<img src="https://example.com/hero.png" alt="Hero"></main></body></html>`;

async function withHost(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-import-")));
  const host = await startStudioHost({ projectsRoot: root, now });
  const call = (method, path, body) => fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, json: await response.json() }));
  try {
    await callback({ root, host, call });
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("inline styles become style properties", () => {
  assert.deepEqual(styleProperties({ cssText: "color: #224466; FONT-SIZE: 40px;;bad;x:;background-image:url(a)" }), { color: "#224466", "font-size": "40px", "background-image": "url(a)" });
  assert.deepEqual(styleProperties({ color: "red" }), { color: "red" });
  assert.deepEqual(styleProperties(null), {});
});

test("the host reviews an import, then commits it as one attributed, undoable transaction", async () => {
  await withHost(async ({ root, host, call }) => {
    assert.equal((await call("POST", "/api/import", { html: PAGE })).json.error.code, "no-project");
    await call("POST", "/api/projects/create", { name: "site" });
    assert.equal((await call("POST", "/api/import", { html: "  " })).status, 400);
    const review = (await call("POST", "/api/import", { html: PAGE, name: "Pricing page" })).json;
    assert.equal(review.commitReady, true);
    assert.equal(review.name, "Pricing page");
    assert.equal(review.security.scriptsRemoved, 1);
    assert.equal(review.security.eventHandlersRemoved, 1);
    assert.ok(review.security.dangerousUrlsRemoved >= 1);
    assert.equal(review.counts.stylesheets, 1);
    assert.match(review.notes.join(" "), /stylesheet is not carried/u);
    assert.match(review.notes.join(" "), /not fetched/u);
    assert.equal(host.session.revision, 0, "a review changes nothing");

    const event = (await call("POST", "/api/import/commit", { proposalId: review.proposalId })).json;
    assert.equal(event.revision, 1);
    assert.equal(event.intent, "Import Pricing page");
    assert.equal(event.tool, "ninerr:import");
    assert.equal(event.actor, "local-user");
    assert.equal(event.operations.length, 1, "one restore-subtree: the page frame and everything in it");
    const document = host.session.document;
    const frame = document.nodes[event.frameId];
    assert.equal(frame.parentId, null);
    assert.equal(frame.props.name, "Pricing page");
    const nodes = Object.values(document.nodes);
    const h1 = nodes.find((node) => node.props.tag === "h1");
    assert.deepEqual(h1.props.style, { color: "#224466", "font-size": "40px" });
    assert.ok(h1.props.semantics, "intake's observed semantics are kept");
    assert.ok(nodes.every((node) => !JSON.stringify(node.props).includes("steal")), "no script or handler survives");
    assert.equal((await call("POST", "/api/import/commit", { proposalId: review.proposalId })).json.error.code, "import-not-found", "a review is committed once");

    // Importing the same page again does not collide with the first import's ids.
    const again = (await call("POST", "/api/import", { html: PAGE, name: "Pricing page" })).json;
    const second = (await call("POST", "/api/import/commit", { proposalId: again.proposalId })).json;
    assert.equal(second.revision, 2);
    assert.equal(Object.keys(host.session.document.nodes).length, nodes.length * 2);
    // Undo removes the import in one step; a discarded review cannot be committed.
    await call("POST", "/api/undo");
    assert.equal(Object.keys(host.session.document.nodes).length, nodes.length);
    const discarded = (await call("POST", "/api/import", { html: "<p>x</p>" })).json;
    assert.equal((await call("POST", "/api/import/discard", { proposalId: discarded.proposalId })).status, 200);
    assert.equal((await call("POST", "/api/import/commit", { proposalId: discarded.proposalId })).status, 404);
    // The journal records what the import came from.
    const journal = readFileSync(join(root, "site", PROJECT_FILES.directory, "journal.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.segment === undefined).map((line) => line.entry.transaction);
    assert.equal(journal[0].metadata.ninerr.provenance.import.proposalId, review.proposalId);
    assert.equal(journal[0].metadata.ninerr.provenance.import.sourceKind, "html-snapshot");
    // Limits: the import stack's offline policy.
    assert.equal(MAX_IMPORT_HTML_BYTES, 2 * 1024 * 1024);
    assert.equal(MAX_IMPORT_NODES, 10_000);
    assert.equal((await call("POST", "/api/import", { html: "x".repeat(MAX_IMPORT_HTML_BYTES + 1) })).status, 413);
  });
});

test("a review that says ready commits; one too large for a single change says so first", async () => {
  await withHost(async ({ root, host, call }) => {
    await call("POST", "/api/projects/create", { name: "big" });
    // Thousands of top-level elements are still one operation.
    const many = (await call("POST", "/api/import", { html: "<br>".repeat(5000), name: "Breaks" })).json;
    assert.equal(many.commitReady, true);
    const added = (await call("POST", "/api/import/commit", { proposalId: many.proposalId })).json;
    assert.equal(added.revision, 1);
    assert.equal(host.session.document.nodes[added.frameId].children.length, 5000);
    // A page whose layers would exceed one journal entry is not offered as ready.
    const title = "t".repeat(400);
    const heavy = `<main>${Array.from({ length: 3300 }, (_, index) => `<section title="${title}"><span>${index}</span></section>`).join("")}</main>`;
    const review = (await call("POST", "/api/import", { html: heavy, name: "Heavy" })).json;
    assert.equal(review.commitReady, false);
    assert.match(review.blockingReasons.join(" "), /too large to add as one change/u);
    assert.equal((await call("POST", "/api/import/commit", { proposalId: review.proposalId })).json.error.code, "import-not-ready");
    assert.equal(host.session.revision, 1);
    // A commit that fails keeps the review: the same review answers again, not "not found".
    const kept = (await call("POST", "/api/import", { html: "<p>kept</p>" })).json;
    appendFileSync(join(root, "big", PROJECT_FILES.directory, "journal.log"), "tampered\n");
    assert.equal((await call("POST", "/api/import/commit", { proposalId: kept.proposalId })).json.error.code, "project-needs-reopen");
    assert.equal((await call("POST", "/api/import/commit", { proposalId: kept.proposalId })).json.error.code, "project-needs-reopen");
  });
});

test("import, edit, save and reopen a page through the editor", browserTestOptions(), async () => {
  await withHost(async ({ root, host, call }) => {
    await call("POST", "/api/projects/create", { name: "site" });
    const file = join(root, "pricing.html");
    writeFileSync(file, PAGE);
    let editor = await openEditor(host);
    let currentHost = host;
    try {
      let { page } = editor;
      await waitRevision(page, 0);
      // Import from a file through the dialog, and read the review.
      await page.locator("#action-import").click();
      await page.locator("#import-file").setInputFiles(file);
      await page.locator("#dialog[open] button.primary").click();
      await page.locator("#import-review").waitFor();
      const review = await page.locator("#import-review li").allTextContents();
      assert.match(review.join(" | "), /For safety: 1 script removed, 1 event handler removed/u);
      assert.match(review.join(" | "), /stylesheet is not carried/u);
      assert.match(await page.locator("#dialog-title").textContent(), /Review import: pricing/u);
      await page.locator("#dialog[open] button.primary", { hasText: "Import" }).click();
      await waitRevision(page, 1);
      // On the canvas: the heading with its inline style; no remote image, no unsafe link.
      const ids = Object.values(currentHost.session.document.nodes);
      const h1 = ids.find((node) => node.props.tag === "h1").id;
      const title = ids.find((node) => node.parentId === h1).id;
      assert.equal(await rendered(page, h1, "color"), "rgb(34, 68, 102)");
      assert.equal(await rendered(page, h1, "text"), "Pricing");
      assert.equal(await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelectorAll("img[src], [href]").length), 0);
      assert.ok(await layerCount(page) >= 2);
      // Edit the imported heading's text in the inspector, then save.
      await page.locator(`[role=treeitem][data-node-id="${h1}"] > .row`).click();
      await page.keyboard.press("ArrowRight");
      await page.locator(`[role=treeitem][data-node-id="${title}"] > .row`).click();
      await page.locator("#inspect-text").fill("Plans and pricing");
      await page.keyboard.press("Tab");
      await waitRevision(page, 2);
      assert.equal(await rendered(page, h1, "text"), "Plans and pricing");
      await page.locator("#action-save").click();
      await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Saved."));
      assert.deepEqual(editor.foreign, []);
      assert.deepEqual(editor.errors, []);
      await editor.close();
      // Quit and reopen: the import and the edit are there.
      const saved = JSON.parse(JSON.stringify(currentHost.session.document));
      await currentHost.close();
      currentHost = await startStudioHost({ projectsRoot: root, now });
      editor = await openEditor(currentHost);
      page = editor.page;
      await page.locator("#dialog[open] [data-project=site]").click();
      await waitRevision(page, 2);
      assert.deepEqual(currentHost.session.document, saved);
      assert.equal(await rendered(page, h1, "text"), "Plans and pricing");
      assert.equal(await rendered(page, h1, "color"), "rgb(34, 68, 102)");
      assert.deepEqual(editor.foreign, [], "no request left the host, including for the page's linked stylesheet and image");
      assert.deepEqual(editor.errors, []);
    } finally {
      await editor.close();
      if (currentHost !== host) await currentHost.close();
    }
  });
});
