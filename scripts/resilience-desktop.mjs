#!/usr/bin/env node
// What a packaged Ninerr desktop app does when things go wrong (P08-G8, #230): a second
// start, a renderer that crashes, the app ended at once (a crash or a forced quit) and
// started again, all from a home and projects folder whose paths hold spaces and letters
// outside ASCII. Then what a clean shutdown leaves behind.
//
//   node scripts/resilience-desktop.mjs <archive made by scripts/package-desktop.mjs>
//
// The packaged app runs as a person runs it (scripts/desktop/drive.mjs). The result is
// printed as one JSON line; the exit code is 0 only if every step held.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { preparePackage, sleep, waitForRevision } from "./desktop/drive.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

const archive = process.argv[2] ? resolve(process.argv[2]) : null;
if (archive === null || process.argv.length !== 3 || !existsSync(archive)) {
  process.stderr.write("usage: node scripts/resilience-desktop.mjs <Ninerr-<target>.tar.gz|zip>\n");
  process.exit(2);
}
const TOTAL_STEPS = 10;
const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

// Spaces, accented Latin, Greek and Japanese: each must survive every path Ninerr builds.
const HOME = "Hôme of Zoë";
const PROJECTS = "Design projects – Ωmega 日本";
const NAME = "resilience";

/** Whether anything still answers at `url`: a host or a debugging port that should be gone. */
async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

const layerIds = (page) => page.evaluate(() => [...document.querySelectorAll("#layers [role=treeitem]")].map((item) => item.dataset.nodeId).sort());

async function main() {
  const run = await preparePackage(archive, { home: HOME, projects: PROJECTS });
  try {
    const { projects, egress, launch, spawnRaw } = run;
    const projectDir = join(projects, NAME, PROJECT_FILES.directory);

    // 1. Start from the unusual paths, create a project and edit it.
    let ninerr = await launch();
    let page = ninerr.page;
    await page.locator("#new-project-name").fill(NAME);
    await page.locator("#dialog[open] button.primary", { hasText: "Create project" }).click();
    await waitForRevision(page, 0);
    await page.locator("#action-insert-box").click();
    await waitForRevision(page, 1);
    step("1 the packaged app runs from a home and projects folder with spaces and non-ASCII names", ninerr.packaged() && projects.endsWith(PROJECTS) && existsSync(join(projectDir, PROJECT_FILES.journal)), { projects });

    // 2. A second start does not make a second Ninerr: it exits, and the first goes on.
    const second = spawnRaw([]);
    let secondOutput = "";
    second.stdout.on("data", (chunk) => (secondOutput += chunk));
    second.stderr.on("data", (chunk) => (secondOutput += chunk));
    const secondCode = await Promise.race([new Promise((done) => second.once("exit", (code) => done(code))), sleep(30_000).then(() => "still running after 30 s")]);
    if (secondCode === "still running after 30 s") second.kill();
    await page.locator("#action-insert-box").click();
    await waitForRevision(page, 2);
    step("2 a second start exits and leaves the running Ninerr working", secondCode === 0 && ninerr.running() && !secondOutput.includes("ninerr: desktop app"), { secondCode, secondOutput: secondOutput.slice(-300) });

    // 3. The editor's renderer crashes: Ninerr replaces it, and nothing is lost.
    const beforeCrash = await layerIds(page);
    const crash = await page.context().newCDPSession(page);
    await crash.send("Page.crash").catch(() => {});
    page = await ninerr.editor().catch((error) => step("3 a crashed renderer is replaced and the project goes on", false, { error: error.message, output: ninerr.output().slice(-600) }));
    await waitForRevision(page, 2);
    const afterCrash = await layerIds(page);
    await page.locator("#action-insert-box").click();
    await waitForRevision(page, 3);
    step("3 a crashed renderer is replaced and the project goes on", ninerr.running() && JSON.stringify(afterCrash) === JSON.stringify(beforeCrash) && /the editor's renderer stopped/u.test(ninerr.output()), { beforeCrash: beforeCrash.length, afterCrash: afterCrash.length });

    // 4. The app is ended at once: nothing gets to close, and nothing of it stays running.
    const hostUrl = new URL(page.url()).origin;
    const committed = await layerIds(page);
    const killed = await ninerr.kill();
    await sleep(1000);
    const hostGone = !(await answers(`${hostUrl}/`));
    step("4 an app ended at once stops serving, leaving its locks behind", killed !== "still running after 20 s" && hostGone && existsSync(join(projectDir, "lock")) && existsSync(join(projects, ".ninerr-host.lock")), { killed, hostGone });

    // 5. Started again, it takes the folder over from the stopped one.
    ninerr = await launch();
    page = ninerr.page;
    step("5 Ninerr starts again after a crash, without asking about the folder", (await page.locator("#dialog[open] [data-project]").count()) >= 1, ninerr.output().slice(-300));

    // 6. The project opens with every committed change. The lock the stopped Ninerr left is
    // its own, so it is taken over without asking about "another session", and the editor
    // says what it recovered.
    await page.locator(`#dialog[open] [data-project=${NAME}]`).click();
    const opened = await Promise.race([
      page.locator("#dialog[open] #dialog-title", { hasText: "Ninerr recovered this project" }).waitFor({ timeout: 30_000 }).then(() => "recovered"),
      page.locator("#dialog[open] #lock-reason").waitFor({ timeout: 30_000 }).then(() => "asked to take over"),
    ]);
    const note = (await page.locator("#dialog[open]").textContent()) ?? "";
    await waitForRevision(page, 3);
    const recovered = await layerIds(page);
    step("6 the crashed project reopens with every committed change, its stale lock taken over and said so", opened === "recovered" && /was taken over: Ninerr stopped without closing \(process \d+\)\./u.test(note) && JSON.stringify(recovered) === JSON.stringify(committed), { opened, note: note.slice(0, 300), recovered: recovered.length, committed: committed.length });

    // 7. It goes on: an edit after recovery is committed.
    await page.locator("#dialog[open] button.primary", { hasText: "Continue" }).click();
    await page.locator("#action-insert-box").click();
    await waitForRevision(page, 4);
    step("7 the recovered project takes new edits", (await layerIds(page)).length === committed.length + 1);

    // 8. A clean shutdown: the app exits 0, stops serving and releases every lock.
    const hostUrl2 = new URL(page.url()).origin;
    const code = await ninerr.quit();
    await sleep(500);
    step("8 closing Ninerr exits cleanly, stops serving and releases its locks", code === 0 && !(await answers(`${hostUrl2}/`)) && !existsSync(join(projectDir, "lock")) && !existsSync(join(projects, ".ninerr-host.lock")), { code });

    // 9. Nothing half-written is left in the project: no temporary or set-aside files.
    const leftovers = readdirSync(projectDir).filter((entry) => /\.tmp|broken|partial/u.test(entry));
    const journal = readFileSync(join(projectDir, PROJECT_FILES.journal), "utf8");
    step("9 the project holds no temporary or set-aside files, and its journal ends whole", leftovers.length === 0 && journal.endsWith("\n"), { leftovers });

    // 10. No hidden infrastructure: through all of it, the browser side sent nothing off
    // this computer.
    step("10 the browser side sent nothing off this computer", egress.length === 0, egress);
  } finally {
    // A failure to clean up is reported, but never in place of the failure that came first.
    await run.close().catch((error) => process.stderr.write(`resilience-desktop: clean-up: ${error?.message ?? error}\n`));
  }
}

main().then(
  () => {
    const ok = steps.length === TOTAL_STEPS && steps.every((item) => item.ok);
    process.stdout.write(`${JSON.stringify({ archive: basename(archive), ok, total: TOTAL_STEPS, steps })}\n`);
    if (!ok) process.exit(1);
  },
  (error) => {
    process.stdout.write(`${JSON.stringify({ archive: basename(archive), ok: false, total: TOTAL_STEPS, error: String(error?.message ?? error).slice(0, 800), steps })}\n`);
    process.exit(1);
  },
);
