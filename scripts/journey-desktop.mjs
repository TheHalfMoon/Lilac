#!/usr/bin/env node
// The release-candidate journey through a packaged Lilac desktop app (MASTER_PLAN PC gate
// 17, #178): what MASTER_PLAN's "definition of genuinely complete" asks a fresh user to be
// able to do (install, create and edit, use an agent, connect a codebase, round-trip a
// component, export) with no hidden paid infrastructure.
//
//   node scripts/journey-desktop.mjs <archive made by scripts/package-desktop.mjs>
//
// The packaged app runs as a person runs it (scripts/desktop/drive.mjs): a fresh home and
// projects folder, behind a local proxy that records any connection the browser side makes
// off this computer, driven over Chromium's remote-debugging protocol. The agent is an MCP
// client speaking to Lilac's own endpoint on 127.0.0.1 with the credential the editor
// showed. The result is printed as one JSON line; the exit code is 0 only if every step held.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { preparePackage, waitForRevision } from "./desktop/drive.mjs";

const archive = process.argv[2] ? resolve(process.argv[2]) : null;
if (archive === null || process.argv.length !== 3 || !existsSync(archive)) {
  process.stderr.write("usage: node scripts/journey-desktop.mjs <Lilac-<target>.tar.gz|zip>\n");
  process.exit(2);
}
const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

// The page a person imports: a heading, a paragraph with inline style, a stylesheet and an
// image that Lilac must not fetch.
const PAGE = `<!doctype html><html><head><title>Launch</title><link rel="stylesheet" href="https://cdn.example.com/site.css"></head>
<body><main><h1>Launch day</h1><p style="color: #335577">Everything ships today.</p><img src="https://cdn.example.com/hero.png" alt="Hero"></main></body></html>`;
const COMPONENT = `export function PriceCard() {
  return (
    <section className="card" style="padding: 16px; background: #f4f0ff">
      <h2>Pro</h2>
      <p>Everything in Free, and more.</p>
    </section>
  );
}`;

async function main() {
  const files = mkdtempSync(join(tmpdir(), "lilac-journey-files-"));
  const run = await preparePackage(archive);
  try {
    const { projects, egress, launch } = run;
    const pagePath = join(files, "launch.html");
    writeFileSync(pagePath, PAGE);

    // 1. Install and start: a fresh home, and the editor asks for a project.
    let lilac = await launch();
    let { page } = lilac;
    step("1 the packaged app starts with the projects dialog", lilac.packaged() && (await page.locator("#dialog[open] #new-project-name").count()) === 1);

    // 2. Create and edit.
    await page.locator("#new-project-name").fill("journey");
    await page.locator("#dialog[open] button.primary", { hasText: "Create project" }).click();
    await waitForRevision(page, 0);
    await page.locator("#action-import").click();
    await page.locator("#import-file").setInputFiles(pagePath);
    await page.locator("#dialog[open] button.primary", { hasText: "Review import" }).click();
    await page.locator("#import-review").waitFor();
    const review = (await page.locator("#import-review").textContent()) ?? "";
    await page.locator("#dialog[open] button.primary", { hasText: "Import" }).click();
    await waitForRevision(page, 1);
    step("2a an HTML page is reviewed, then imported", /stylesheet/u.test(review) || /resource/u.test(review), review.slice(0, 300));
    await page.locator("#inspect-name").fill("Launch page");
    await page.locator("#inspect-name").press("Tab");
    await waitForRevision(page, 2);
    await page.locator("#action-insert-box").click();
    await waitForRevision(page, 3);
    await page.locator("button[aria-label='Move right 10 pixels']").click();
    await waitForRevision(page, 4);
    await page.locator("#inspector button", { hasText: "Wider" }).click();
    await waitForRevision(page, 5);
    await page.locator("#inspect-style-background").fill("#336699");
    await page.locator("#inspect-style-background").press("Tab");
    await waitForRevision(page, 6);
    const box = await page.locator("#inspector").getAttribute("data-node-id");
    const boxStyle = await page.evaluate((id) => {
      const element = document.querySelector("iframe").contentDocument.querySelector(`[data-lilac-id="${id}"]`);
      return { background: element?.style.background, width: element?.style.width };
    }, box);
    step("2b a box is inserted, moved, resized and filled", boxStyle.background === "rgb(51, 102, 153)", boxStyle);
    // The heading's text, edited in the inspector: its text layer, the heading's child.
    const heading = await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("h1")?.getAttribute("data-lilac-id"));
    await page.locator(`[role=treeitem][data-node-id="${heading}"] > [role=group] > [role=treeitem] > .row`).first().click();
    await page.locator("#inspect-text").fill("Launch week");
    await page.locator("#inspect-text").press("Tab");
    await waitForRevision(page, 7);
    step("2c text is edited", (await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-lilac-id="${id}"]`)?.textContent, heading)) === "Launch week");
    await page.locator("#action-undo").click();
    await waitForRevision(page, 8);
    const undone = await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-lilac-id="${id}"]`)?.textContent, heading);
    await page.locator("#action-redo").click();
    await waitForRevision(page, 9);
    const redone = await page.evaluate((id) => document.querySelector("iframe").contentDocument.querySelector(`[data-lilac-id="${id}"]`)?.textContent, heading);
    step("2d undo and redo", undone === "Launch day" && redone === "Launch week", { undone, redone });

    // 3. Use an agent, connected in the editor, over MCP on 127.0.0.1.
    await page.locator("#action-agents").click();
    await page.locator("#agent-name").fill("Journey agent");
    await page.locator("#dialog[open] button.primary", { hasText: "Connect agent" }).click();
    const token = await page.locator("#agent-credential").inputValue();
    const mcpUrl = (await page.locator("#dialog[open] pre.setup").last().textContent())?.trim();
    await page.locator("#dialog[open] button.primary").click();
    step("3a the editor shows the agent's credential and Lilac's MCP URL once", /^lilac_agent_/u.test(token) && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(mcpUrl ?? ""), mcpUrl);
    let id = 0;
    const rpc = async (method, params) => {
      const response = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      return (await response.json()).result;
    };
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } });
    const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
    step("3b the agent initializes and lists Lilac's tools", init?.serverInfo?.name !== undefined && tools.includes("create_artboard") && tools.includes("delete_nodes"), { server: init?.serverInfo, tools: tools.length });
    const artboard = (await rpc("tools/call", { name: "create_artboard", arguments: { name: "From the agent", width: 480, height: 320 } })).structuredContent.nodeId;
    await waitForRevision(page, 10);
    await rpc("tools/call", { name: "update_styles", arguments: { updates: [{ nodeId: artboard, styles: { background: "#fde68a" } }] } });
    await waitForRevision(page, 11);
    const agentRow = await page.locator("#history li").first().locator(".who").textContent();
    step("3c the agent's edits appear live and are attributed to it", (await page.locator(`[role=treeitem][data-node-id="${artboard}"] > .row .label`).textContent()) === "From the agent" && /^Journey agent · agent · update_styles/u.test(agentRow ?? ""), agentRow);
    const deletion = rpc("tools/call", { name: "delete_nodes", arguments: { nodeIds: [artboard] } });
    await page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Journey agent asks for your approval", null, { polling: 100, timeout: 30_000 });
    await page.locator("#dialog[open] button:not([disabled])", { hasText: "Approve" }).click();
    const deleted = await deletion;
    await waitForRevision(page, 12);
    step("3d a consequential call waits for the person's approval", deleted.isError === undefined && (await page.locator(`[role=treeitem][data-node-id="${artboard}"]`).count()) === 0);

    // 4. Connect a codebase: a component comes into the design as code.
    await page.locator("[role=application]").focus();
    await page.keyboard.press("Escape");
    await page.locator("#action-code").click();
    await page.locator("#code-import").fill(COMPONENT);
    await page.locator("#dialog[open] button.primary", { hasText: "Add to design" }).click();
    await waitForRevision(page, 13);
    const cardId = await page.evaluate(() => document.querySelector("iframe").contentDocument.querySelector("section.card")?.getAttribute("data-lilac-id"));
    step("4 a JSX component becomes layers", cardId !== null && (await page.evaluate((nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-lilac-id="${nodeId}"] h2`)?.textContent, cardId)) === "Pro");

    // 5. Round-trip the component: export it, bring the export in, export that copy.
    const exportOf = async (nodeId) => {
      await page.locator(`[role=treeitem][data-node-id="${nodeId}"] > .row`).click();
      await page.locator("#action-code").click();
      await page.locator("#dialog[open] #code-export").waitFor();
      const code = await page.locator("#code-export").inputValue();
      return code;
    };
    const exported = await exportOf(cardId);
    await page.locator("#code-import").fill(exported);
    await page.locator("#dialog[open] button.primary", { hasText: "Add to design" }).click();
    await waitForRevision(page, 14);
    const cards = await page.evaluate(() => [...document.querySelector("iframe").contentDocument.querySelectorAll("section.card")].map((element) => element.getAttribute("data-lilac-id")));
    const reExported = await exportOf(cards.find((nodeId) => nodeId !== cardId));
    await page.keyboard.press("Escape");
    step("5 the component round-trips: the copy exports the same code", cards.length === 2 && reExported === exported && /<section className="card" style="[^"]*padding: 16px/u.test(exported) && /<section className="card" style="[^"]*background: #f4f0ff/u.test(exported) && /<h2>Pro<\/h2>/u.test(exported), { exported: exported.slice(0, 200), reExported: reExported.slice(0, 200) });

    // 6. Export: the imported page as code, which reads back as code.
    const pageFrame = await page.evaluate(() => [...document.querySelectorAll("#layers > [role=treeitem]")].find((item) => item.querySelector(".label")?.textContent === "Launch page")?.dataset.nodeId);
    const pageCode = await exportOf(pageFrame);
    await page.keyboard.press("Escape");
    step("6 the page exports as JSX code", /^export function LaunchPage\(\) \{/u.test(pageCode) && /<h1>Launch week<\/h1>/u.test(pageCode) && !/cdn\.example\.com/u.test(pageCode.replace(/<img[^>]*>/gu, "")), pageCode.slice(0, 300));

    // 7. Save, close, start again: everything is there.
    await page.locator("#action-save").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Saved."), null, { polling: 100, timeout: 30_000 });
    const before = {
      revision: await page.locator("#revision").textContent(),
      labels: (await page.locator("#layers [role=treeitem] .label").allTextContents()).sort(),
    };
    step("7a closing Lilac quits it cleanly", (await lilac.quit()) === 0 && !existsSync(join(projects, "journey", ".lilac", "lock")));
    lilac = await launch();
    page = lilac.page;
    await page.locator("#dialog[open] [data-project=journey]").click();
    await waitForRevision(page, 14);
    const after = {
      revision: await page.locator("#revision").textContent(),
      labels: (await page.locator("#layers [role=treeitem] .label").allTextContents()).sort(),
    };
    // (The history panel lists the changes made since the project was opened; who made
    // each earlier change is kept in the project's journal, not shown after a reopen, #179.)
    const filled = await page.evaluate((nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-lilac-id="${nodeId}"]`)?.style.background, box);
    step("7b the project reopens as it was", JSON.stringify(after) === JSON.stringify(before) && filled === "rgb(51, 102, 153)", { before, after, filled });
    step("7c closing Lilac quits it cleanly again", (await lilac.quit()) === 0);

    // 8. No hidden infrastructure: nothing left the computer, and nothing needed an account.
    step("8 the browser side sent nothing off this computer", egress.length === 0, egress);
  } finally {
    await run.close();
    rmSync(files, { recursive: true, force: true });
  }
}

main().then(
  () => process.stdout.write(`${JSON.stringify({ archive: basename(archive), ok: true, steps })}\n`),
  (error) => {
    process.stdout.write(`${JSON.stringify({ archive: basename(archive), ok: false, error: String(error?.message ?? error).slice(0, 800), steps })}\n`);
    process.exit(1);
  },
);
