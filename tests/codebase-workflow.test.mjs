import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStudioHost } from "../packages/studio-host/src/index.ts";
import { browserTestOptions } from "./support/browser.mjs";
import { openEditor, rendered, waitRevision } from "./support/editor.mjs";

// PC11b (#182): a connected codebase through the editor. The person connects a folder in
// the Code dialog, brings a component in from it, edits it on the canvas, reviews the
// change as a diff and writes it to the file; a change made in both places is shown as a
// conflict and left alone.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + clock++ * 1000).toISOString();
const CARD = `export function PriceCard() {
  return (
    <section className="card" style="padding: 16px; background: #f4f0ff">
      <h2>Pro</h2>
      <p>Everything in Free, and more.</p>
    </section>
  );
}
`;

test("connect a folder, bring a component in, edit it and write the edit back to its file", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-codebase-editor-")));
  const projects = join(root, "projects");
  const code = join(root, "app", "src");
  mkdirSync(projects);
  mkdirSync(code, { recursive: true });
  const cardPath = join(code, "PriceCard.jsx");
  writeFileSync(cardPath, CARD);
  const host = await startStudioHost({ projectsRoot: projects, now });
  const editor = await openEditor(host);
  try {
    const { page } = editor;
    await page.locator("#new-project-name").fill("site");
    await page.locator("#dialog[open] button.primary", { hasText: "Create project" }).click();
    await waitRevision(page, 0);

    // Connect the folder.
    await page.locator("#action-code").click();
    await page.locator("#codebase-folder").fill(code);
    await page.locator("#dialog[open] button.primary", { hasText: "Connect folder" }).click();
    await page.locator("#codebase-components").waitFor();
    assert.equal(await page.locator("#codebase-path").textContent(), code);
    assert.deepEqual(await page.locator("#codebase-components li").allTextContents(), ["PriceCard PriceCard.jsxBring in"]);

    // Bring the component in.
    await page.locator("#codebase-components button", { hasText: "Bring in" }).click();
    await waitRevision(page, 1);
    const section = await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("section.card").getAttribute("data-lilac-id"));
    const heading = await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("h2").getAttribute("data-lilac-id"));
    assert.match(await page.locator("#status").textContent(), /^Bring in PriceCard from PriceCard\.jsx: \d+ layers added\.$/u);

    // Edit its heading and fill on the canvas, as anyone would.
    await page.locator(`[role=treeitem][data-node-id="${heading}"] > .row`).click();
    await page.locator("#inspect-text").fill("Pro & Team");
    await page.locator("#inspect-text").press("Tab");
    await waitRevision(page, 2);
    await page.locator(`[role=treeitem][data-node-id="${section}"] > .row`).click();
    await page.locator("#inspect-style-background").fill("#ffe4e6");
    await page.locator("#inspect-style-background").press("Tab");
    await waitRevision(page, 3);
    assert.equal(await rendered(page, section, "background-color"), "rgb(255, 228, 230)");

    // Review the change, then write it.
    await page.locator("#action-code").click();
    await page.locator("#codebase-review").click();
    await page.locator("#codebase-diff").waitFor();
    const diff = await page.locator("#codebase-diff").textContent();
    assert.match(diff, /^--- a\/PriceCard\.jsx\n\+\+\+ b\/PriceCard\.jsx\n/u);
    assert.match(diff, /\n-      <h2>Pro<\/h2>\n/u);
    assert.match(diff, /\n\+      <h2>Pro &amp; Team<\/h2>\n/u);
    assert.match(diff, /\+    <section className="card" style="padding: 16px; background: #ffe4e6">/u);
    assert.equal(readFileSync(cardPath, "utf8"), CARD, "reviewing writes nothing");
    await page.locator("#codebase-write").click();
    await waitRevision(page, 4);
    assert.equal(await page.locator("#status").textContent(), "Wrote 2 changes to PriceCard.jsx.");
    assert.equal(readFileSync(cardPath, "utf8"), CARD.replace("<h2>Pro</h2>", "<h2>Pro &amp; Team</h2>").replace("background: #f4f0ff", "background: #ffe4e6"));

    // Changed in both places: the dialog says so, and writes nothing for it.
    writeFileSync(cardPath, readFileSync(cardPath, "utf8").replace("Pro &amp; Team", "Business"));
    await page.locator(`[role=treeitem][data-node-id="${heading}"] > .row`).click();
    await page.locator("#inspect-text").fill("Teams");
    await page.locator("#inspect-text").press("Tab");
    await waitRevision(page, 5);
    await page.locator(`[role=treeitem][data-node-id="${section}"] > .row`).click();
    await page.locator("#action-code").click();
    await page.locator("#codebase-review").click();
    await page.locator("#codebase-preview p").first().waitFor();
    const preview = await page.locator("#codebase-preview").textContent();
    assert.match(preview, /There is nothing to write back/u);
    assert.match(preview, /Changed both here and in the file, so not written:text: changed both here and in the file/u);
    assert.equal(await page.locator("#codebase-write").count(), 0);
    assert.match(readFileSync(cardPath, "utf8"), /<h2>Business<\/h2>/u, "the file's own change stays");
    await page.locator("#dialog[open] button", { hasText: "Close" }).last().click();
    assert.deepEqual(editor.foreign, []);
    assert.deepEqual(editor.errors, []);
  } finally {
    await editor.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
