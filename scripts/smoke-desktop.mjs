#!/usr/bin/env node
// Smoke-test a packaged Lilac desktop app (MASTER_PLAN PC gate 15):
//
//   node scripts/smoke-desktop.mjs <archive made by scripts/package-desktop.mjs>
//
// The archive is unpacked into a temporary folder and the packaged app is run as a person
// runs it, with its own projects folder and home, behind a local proxy that records any
// connection off this computer. It is driven over Chromium's remote-debugging protocol
// (the packaged app's fuses refuse Node's inspector): create a project, add a layer,
// rename it, quit; start it again and find the change; quit. Its fuses are read back from
// the binary, and ELECTRON_RUN_AS_NODE is shown to have no effect. The result is printed
// as one JSON line and the exit code is 0 only if every check held.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WINDOWS_TAR } from "./desktop/electron.mjs";
import { LILAC_FUSES, readFuses } from "./desktop/fuses.mjs";

const archive = process.argv[2] ? resolve(process.argv[2]) : null;
if (archive === null || process.argv.length !== 3 || !existsSync(archive)) {
  process.stderr.write("usage: node scripts/smoke-desktop.mjs <Lilac-<target>.tar.gz|zip>\n");
  process.exit(2);
}
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function unpack(into) {
  const [command, args] = archive.endsWith(".tar.gz")
    ? ["tar", ["-xzf", archive, "-C", into]]
    : process.platform === "darwin" ? ["ditto", ["-x", "-k", archive, into]] : [WINDOWS_TAR, ["-xf", archive, "-C", into]];
  if (spawnSync(command, args, { stdio: "inherit" }).status !== 0) throw new Error(`could not unpack ${archive}`);
  const [folder] = readdirSync(into);
  return join(into, folder);
}

async function display() {
  if (process.platform !== "linux" || process.env.DISPLAY) return { env: {}, stop: async () => {} };
  const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
  const number = await new Promise((resolveNumber, reject) => {
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolveNumber(text.trim());
    });
    server.once("error", reject);
  });
  return { env: { DISPLAY: `:${number}` }, stop: async () => server.kill("SIGTERM") };
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function main() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "lilac-desktop-smoke-")));
  const screen = await display();
  const egress = [];
  const proxy = createServer((request, response) => {
    egress.push(request.url);
    response.writeHead(403).end();
  });
  proxy.on("connect", (request, socket) => {
    egress.push(`CONNECT ${request.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
  const running = new Set();
  try {
    const packaged = unpack(work);
    const manifest = JSON.parse(readFileSync(join(packaged, "lilac-package.json"), "utf8"));
    const executable = join(packaged, manifest.executable);
    const fusedBinary = manifest.target.startsWith("darwin-")
      ? join(packaged, "Lilac.app", "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework")
      : executable;
    check("fuses are set in the binary", JSON.stringify(readFuses(fusedBinary)) === JSON.stringify(LILAC_FUSES), readFuses(fusedBinary));

    const home = join(work, "home");
    const projects = join(work, "projects");
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      ...screen.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      LILAC_PROJECTS: projects,
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
    };
    const { chromium } = await import("playwright-core");

    const launch = async () => {
      const port = await freePort();
      const child = spawn(executable, [`--remote-debugging-port=${port}`, `--proxy-server=http://127.0.0.1:${proxy.address().port}`], { env, stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      let output = "";
      child.stdout.on("data", (chunk) => (output = (output + chunk).slice(-4000)));
      child.stderr.on("data", (chunk) => (output = (output + chunk).slice(-4000)));
      const exited = new Promise((resolveExit) => child.once("exit", (code) => {
        running.delete(child);
        resolveExit(code);
      }));
      let browser = null;
      for (let tries = 0; tries < 150 && browser === null; tries += 1) {
        if (child.exitCode !== null) throw new Error(`the packaged app exited (${child.exitCode}): ${output.slice(-600)}`);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
        if (browser === null) await sleep(200);
      }
      if (browser === null) throw new Error(`the packaged app never offered its debugging port: ${output.slice(-600)}`);
      let page = null;
      for (let tries = 0; tries < 150 && page === null; tries += 1) {
        page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://127.0.0.1:")) ?? null;
        if (page === null) await sleep(200);
      }
      if (page === null) throw new Error("the packaged app showed no editor");
      await page.waitForFunction(() => document.documentElement.dataset.ready === "true", null, { polling: 100, timeout: 30_000 });
      return {
        page,
        output: () => output,
        async quit() {
          // As the person does: close the window; Lilac quits and closes its host.
          const session = await browser.newBrowserCDPSession();
          await session.send("Browser.close").catch(() => {});
          const code = await Promise.race([exited, sleep(20_000).then(() => "still running after 20 s")]);
          return code;
        },
      };
    };
    const revision = (page, wanted) => page.waitForFunction((value) => document.getElementById("revision")?.textContent === `Revision ${value}`, wanted, { polling: 100, timeout: 30_000 });

    // First run: a project, a layer, a rename.
    let lilac = await launch();
    let { page } = lilac;
    check("the editor runs isolated, in the desktop app", await page.evaluate(() => typeof process === "undefined" && typeof require === "undefined" && window.lilacDesktop?.desktop === true));
    await page.locator("#new-project-name").fill("smoke");
    await page.locator("#dialog[open] button.primary", { hasText: "Create project" }).click();
    await revision(page, 0);
    await page.locator("#action-insert-box").click();
    await revision(page, 1);
    await page.locator("#inspect-name").fill("Packaged");
    await page.locator("#inspect-name").press("Tab");
    await revision(page, 2);
    check("an edit is committed", true);
    check("the project is locked while open", existsSync(join(projects, "smoke", ".lilac", "lock")));
    const firstExit = await lilac.quit();
    check("closing Lilac quits it cleanly", firstExit === 0, firstExit === 0 ? undefined : { exit: firstExit, output: lilac.output().slice(-400) });
    check("quitting releases the project", !existsSync(join(projects, "smoke", ".lilac", "lock")) && !existsSync(join(projects, ".lilac-studio.json")));

    // Second run: the change is there.
    lilac = await launch();
    page = lilac.page;
    await page.locator("#dialog[open] [data-project=smoke]").click();
    await revision(page, 2);
    const labels = await page.locator("#layers [role=treeitem] .label").allTextContents();
    check("the change is there after a restart", labels.includes("Packaged"), labels.includes("Packaged") ? undefined : labels);
    const secondExit = await lilac.quit();
    check("closing Lilac quits it cleanly again", secondExit === 0, secondExit === 0 ? undefined : { exit: secondExit, output: lilac.output().slice(-400) });

    // The RunAsNode fuse: the environment variable no longer turns the binary into Node.
    const marker = "lilac-ran-as-node";
    const asNode = spawn(executable, ["-e", `process.stdout.write(${JSON.stringify(marker)})`], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    running.add(asNode);
    let asNodeOutput = "";
    asNode.stdout.on("data", (chunk) => (asNodeOutput += chunk));
    await Promise.race([new Promise((resolveExit) => asNode.once("exit", resolveExit)), sleep(8_000)]);
    if (asNode.exitCode === null) {
      asNode.kill();
      await new Promise((resolveExit) => asNode.once("exit", resolveExit));
    }
    running.delete(asNode);
    check("ELECTRON_RUN_AS_NODE has no effect", !asNodeOutput.includes(marker), asNodeOutput.includes(marker) ? asNodeOutput.slice(0, 200) : undefined);

    check("nothing left this computer", egress.length === 0, egress.length === 0 ? undefined : egress);
  } finally {
    for (const child of running) child.kill();
    await new Promise((resolveClose) => proxy.close(resolveClose));
    await screen.stop();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
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
