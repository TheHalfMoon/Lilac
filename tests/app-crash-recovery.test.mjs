import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserTestOptions } from "./support/browser.mjs";
import { layerCount, waitRevision } from "./support/editor.mjs";
import { attemptsIn, browse, openTab, startNinerr } from "./support/ninerr-process.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

// PC8 (#168): crash and recovery through the actual app. Lilac, started as a person starts
// it (scripts/ninerr.mjs), is killed outright (SIGKILL) while it has a project open with an
// editor attached, and once more in the middle of a burst of edits with a torn write left
// at the end of the journal. Started again, the editor takes over the dead session's lock
// with a reason, reports what recovery did, and every committed change is there. Closes PC
// gate 14.

// A restarted editor's one console error: the 409 when it first opens the locked project
// (and, once Lilac is killed under it, the connections it could no longer make).
const LOST_CONNECTION = /ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING/u;
function assertOnlyLockedConflict(errors, { killed = false } = {}) {
  if (killed) errors = errors.filter((message) => !LOST_CONNECTION.test(message));
  const conflicts = errors.filter((message) => /status of 409 \(Conflict\)/u.test(message));
  assert.equal(conflicts.length, 1, errors.join(" | "));
  assert.deepEqual(errors.filter((message) => !conflicts.includes(message)), [], "only the expected 409 (project locked) is logged");
}

test("Lilac killed mid-session recovers through the editor, with every committed change", browserTestOptions(), async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-crash-")));
  const projects = join(root, "projects");
  const browser = await browse();
  const attempts = [];
  let ninerr = await startNinerr(projects);
  try {
    // A session with work in it.
    let tab = await openTab(browser, ninerr.origin, ninerr.first);
    await tab.page.locator("#new-project-name").fill("work");
    await tab.page.keyboard.press("Enter");
    await waitRevision(tab.page, 0);
    for (let index = 0; index < 3; index += 1) {
      await tab.page.locator("#action-insert-box").click();
      await waitRevision(tab.page, index + 1);
    }
    await tab.page.locator("#inspect-name").fill("Before the crash");
    await tab.page.keyboard.press("Tab");
    await waitRevision(tab.page, 4);
    const before = await layerCount(tab.page);

    // Crash 1: killed outright, with the project open and the editor attached.
    assert.equal(await ninerr.kill(), "SIGKILL");
    attempts.push(...attemptsIn(ninerr.output.stderr));
    const lock = join(projects, "work", PROJECT_FILES.directory, "lock");
    assert.ok(existsSync(lock), "a crash leaves the project's lock behind");
    // The orphaned editor says Lilac cannot be reached, and loses nothing it showed.
    await tab.page.locator("#action-insert-box").click();
    await tab.page.waitForFunction(() => /could not be reached\. If it has stopped, start it again/u.test(document.getElementById("status").textContent));
    attempts.push(...tab.foreign);
    // Its only console errors are the connections it could not make once Lilac was gone.
    assert.deepEqual(tab.errors.filter((message) => !LOST_CONNECTION.test(message)), [], "the orphaned editor logs only the lost connection");
    await tab.page.context().close();

    // Started again: the editor opens the project, finds the dead session's lock, takes over
    // with a reason, and reports it. Everything committed before the crash is there.
    ninerr = await startNinerr(projects);
    tab = await openTab(browser, ninerr.origin, ninerr.first);
    await tab.page.locator("#dialog[open] [data-project=work]").click();
    await tab.page.locator("#lock-reason").fill("Lilac crashed");
    await tab.page.keyboard.press("Enter");
    await tab.page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Lilac recovered this project");
    const report = await tab.page.locator("#dialog[open] ul.report li").allTextContents();
    assert.ok(report.some((line) => /stale lock .* was taken over: Lilac crashed/u.test(line)), report.join(" | "));
    await tab.page.locator("#dialog[open] button.primary").click();
    await waitRevision(tab.page, 4);
    assert.equal(await layerCount(tab.page), before);
    assert.ok((await tab.page.locator("#layers [role=treeitem] .label").allTextContents()).includes("Before the crash"));

    // Crash 2: killed in the middle of a burst of edits from another client, and the last,
    // interrupted write left torn at the end of the journal.
    const token = await tab.page.evaluate(() => sessionStorage.getItem("ninerr.token"));
    const call = (path, body) => fetch(`${ninerr.origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let revision = 4;
    const burst = (async () => {
      for (let index = 0; index < 200; index += 1) {
        const response = await call("/api/edit", { baseRevision: revision, intent: `Burst ${index}`, operations: [{ type: "insert-node", node: { id: `burst-${index}`, type: "element", props: { tag: "div", text: `${index}` } }, parentId: null, index: 0 }] }).catch(() => null);
        if (response === null || !response.ok) return;
        revision = (await response.json()).revision;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await ninerr.kill(), "SIGKILL");
    await burst;
    attempts.push(...attemptsIn(ninerr.output.stderr), ...tab.foreign);
    assertOnlyLockedConflict(tab.errors, { killed: true });
    await tab.page.context().close();
    const journal = join(projects, "work", PROJECT_FILES.directory, "journal.log");
    const committed = readFileSync(journal, "utf8").trim().split("\n").length;
    appendFileSync(journal, '{"seq":999,"entry":{"transaction":{"id":"torn');
    assert.ok(revision > 4, `some of the burst was committed (revision ${revision})`);

    ninerr = await startNinerr(projects);
    tab = await openTab(browser, ninerr.origin, ninerr.first);
    await tab.page.locator("#dialog[open] [data-project=work]").click();
    await tab.page.locator("#lock-reason").fill("Lilac crashed again");
    await tab.page.keyboard.press("Enter");
    await tab.page.waitForFunction(() => document.getElementById("dialog-title")?.textContent === "Lilac recovered this project");
    const second = await tab.page.locator("#dialog[open] ul.report li").allTextContents();
    assert.ok(second.some((line) => /unfinished write .* was discarded/u.test(line)), second.join(" | "));
    assert.ok(second.some((line) => /taken over: Lilac crashed again/u.test(line)), second.join(" | "));
    await tab.page.locator("#dialog[open] button.primary").click();
    await waitRevision(tab.page, committed);
    // Every change the host confirmed before the kill is there, and nothing half-written is.
    const reopened = await tab.page.evaluate(() => Number(document.getElementById("revision").textContent.replace("Revision ", "")));
    assert.ok(reopened >= revision, `every confirmed change survived (confirmed ${revision}, reopened ${reopened})`);
    assert.equal(reopened, committed, "the reopened revision is every complete journal entry");
    const bursts = await tab.page.locator("#layers [role=treeitem] .label").allTextContents();
    assert.equal(bursts.filter((label) => /^div “\d+”$/u.test(label)).length, reopened - 4, "each committed burst edit is a layer");
    // And the project keeps working.
    await tab.page.locator("#action-insert-box").click();
    await waitRevision(tab.page, reopened + 1);
    attempts.push(...tab.foreign);
    assertOnlyLockedConflict(tab.errors);
  } finally {
    await browser.close();
    await ninerr.stop();
    attempts.push(...attemptsIn(ninerr.output.stderr));
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(attempts, [], "no process and no page reached off this computer");
});
