#!/usr/bin/env node
// Smoke-test a packaged Ninerr desktop app (MASTER_PLAN PC gate 15):
//
//   node scripts/smoke-desktop.mjs <archive made by scripts/package-desktop.mjs>
//
// The packaged app is run as a person runs it (scripts/desktop/drive.mjs): a fresh home
// and projects folder, behind a local proxy that records any connection the browser side
// makes off this computer, driven over Chromium's remote-debugging protocol. Create a
// project, add a layer, rename it, close the window; start it again and find the change;
// close it again. Its fuses are read back from the binary, and ELECTRON_RUN_AS_NODE is
// shown to have no effect. The result is printed as one JSON line and the exit code is 0
// only if every check held.
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { preparePackage, sleep, waitForRevision } from "./desktop/drive.mjs";
import { NINERR_FUSES, readFuses } from "./desktop/fuses.mjs";
import { PROJECT_FILES } from "../packages/persistence/src/index.ts";

const archive = process.argv[2] ? resolve(process.argv[2]) : null;
if (archive === null || process.argv.length !== 3 || !existsSync(archive)) {
  process.stderr.write("usage: node scripts/smoke-desktop.mjs <Ninerr-<target>.tar.gz|zip>\n");
  process.exit(2);
}
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

async function main() {
  const run = await preparePackage(archive);
  try {
    const { packaged, manifest, executable, projects, egress, launch, spawnRaw } = run;
    const fusedBinary = manifest.target.startsWith("darwin-")
      ? join(packaged, "Ninerr.app", "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework")
      : executable;
    check("fuses are set in the binary", JSON.stringify(readFuses(fusedBinary)) === JSON.stringify(NINERR_FUSES), readFuses(fusedBinary));

    // First run: a project, a layer, a rename.
    let ninerr = await launch();
    let { page } = ninerr;
    check("the editor runs isolated, in the desktop app", await page.evaluate(() => typeof process === "undefined" && typeof require === "undefined" && window.ninerrDesktop?.desktop === true));
    // A packaged run allows no developer tools (in the window, its requests and its menu).
    check("it runs as a packaged app", ninerr.packaged(), ninerr.packaged() ? undefined : ninerr.output().slice(-300));
    await page.locator("#new-project-name").fill("smoke");
    await page.locator("#dialog[open] button.primary", { hasText: "Create project" }).click();
    await waitForRevision(page, 0);
    await page.locator("#action-insert-box").click();
    await waitForRevision(page, 1);
    await page.locator("#inspect-name").fill("Packaged");
    await page.locator("#inspect-name").press("Tab");
    await waitForRevision(page, 2);
    check("an edit is committed", true);
    check("the project is locked while open", existsSync(join(projects, "smoke", PROJECT_FILES.directory, "lock")));
    const firstExit = await ninerr.quit();
    check("closing Ninerr quits it cleanly", firstExit === 0, firstExit === 0 ? undefined : { exit: firstExit, output: ninerr.output().slice(-400) });
    check("quitting releases the project", !existsSync(join(projects, "smoke", PROJECT_FILES.directory, "lock")) && !existsSync(join(projects, ".ninerr-studio.json")));

    // Second run: the change is there.
    ninerr = await launch();
    page = ninerr.page;
    await page.locator("#dialog[open] [data-project=smoke]").click();
    await waitForRevision(page, 2);
    const labels = await page.locator("#layers [role=treeitem] .label").allTextContents();
    check("the change is there after a restart", labels.includes("Packaged"), labels.includes("Packaged") ? undefined : labels);
    const secondExit = await ninerr.quit();
    check("closing Ninerr quits it cleanly again", secondExit === 0, secondExit === 0 ? undefined : { exit: secondExit, output: ninerr.output().slice(-400) });

    // The RunAsNode fuse: the environment variable no longer turns the binary into Node.
    // Instead of running the script, the binary starts Ninerr (which says so), and is stopped.
    const marker = "ninerr-ran-as-node";
    const asNode = spawnRaw(["-e", `process.stdout.write(${JSON.stringify(marker)})`], { ELECTRON_RUN_AS_NODE: "1" });
    let asNodeOutput = "";
    asNode.stdout.on("data", (chunk) => (asNodeOutput += chunk));
    asNode.stderr.on("data", (chunk) => (asNodeOutput += chunk));
    const asNodeExited = new Promise((resolveExit) => asNode.once("exit", resolveExit));
    for (let tries = 0; tries < 100 && !asNodeOutput.includes("ninerr: desktop app") && asNode.exitCode === null; tries += 1) await sleep(100);
    const startedNinerr = asNodeOutput.includes("ninerr: desktop app (packaged)");
    if (asNode.exitCode === null) {
      asNode.kill();
      await Promise.race([asNodeExited, sleep(10_000)]);
    }
    check("ELECTRON_RUN_AS_NODE has no effect", !asNodeOutput.includes(marker) && startedNinerr, startedNinerr && !asNodeOutput.includes(marker) ? undefined : { ranTheScript: asNodeOutput.includes(marker), startedNinerr });

    // The proxy sees the browser side's requests (pages and Chromium's own); the host's Node
    // code makes none, and its offline guarantee is the network policy's (PC7, P05 D6b).
    check("the browser side sent nothing off this computer", egress.length === 0, egress.length === 0 ? undefined : egress);
  } finally {
    await run.close();
  }
}

main().then(
  () => {
    process.stdout.write(`${JSON.stringify({ archive: basename(archive), ok: true, checks })}\n`);
  },
  (error) => {
    process.stdout.write(`${JSON.stringify({ archive: basename(archive), ok: false, error: String(error?.message ?? error).slice(0, 600), checks })}\n`);
    process.exit(1);
  },
);
