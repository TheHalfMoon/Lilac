// Run a packaged Ninerr desktop app as a person does, for the packaged-app smoke test and
// the release-candidate journey: the archive unpacked into a temporary folder, a fresh
// home and projects folder, a display on Linux, a local proxy that records every
// connection the browser side makes off this computer, and each launch driven over
// Chromium's remote-debugging protocol (the packaged app's fuses refuse Node's inspector).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS_TAR } from "./electron.mjs";

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function unpack(archive, into) {
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

/**
 * Unpack `archive` and prepare to run it. Returns the package, its manifest, the folders
 * it uses, the proxy's record, `launch()` and `close()` (which stops everything and
 * removes the temporary folder).
 */
export async function preparePackage(archive) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-desktop-run-")));
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
  const proxyArg = `--proxy-server=http://127.0.0.1:${proxy.address().port}`;
  const running = new Set();
  const close = async () => {
    for (const child of running) child.kill();
    await new Promise((resolveClose) => proxy.close(resolveClose));
    await screen.stop();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    const packaged = unpack(archive, work);
    const manifest = JSON.parse(readFileSync(join(packaged, "ninerr-package.json"), "utf8"));
    const executable = join(packaged, manifest.executable);
    const home = join(work, "home");
    const projects = join(work, "projects");
    // A home of its own, with the folders each platform keeps an app's data in.
    for (const folder of ["", join("AppData", "Roaming"), join("AppData", "Local"), ".config"]) mkdirSync(join(home, folder), { recursive: true });
    const env = {
      ...process.env,
      ...screen.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      NINERR_PROJECTS: projects,
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
    };
    const { chromium } = await import("playwright-core");

    /** Start the packaged app and wait for its editor to be ready. */
    const launch = async () => {
      const port = await freePort();
      // Chromium's own log goes to stderr, so a failure to start says why.
      const child = spawn(executable, [`--remote-debugging-port=${port}`, proxyArg, "--enable-logging=stderr"], { env, stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      let output = "";
      // Noted as it arrives, so Chromium's own logging cannot push it out of the buffer.
      let packagedRun = false;
      const record = (chunk) => {
        output = (output + chunk).slice(-4000);
        if (String(chunk).includes("ninerr: desktop app (packaged)")) packagedRun = true;
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
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
        packaged: () => packagedRun,
        async quit() {
          // As the person does: close the window (its page target); Ninerr quits and closes
          // its host.
          const pageSession = await page.context().newCDPSession(page);
          const { targetInfo } = await pageSession.send("Target.getTargetInfo");
          const session = await browser.newBrowserCDPSession();
          await session.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
          return Promise.race([exited, sleep(20_000).then(() => "still running after 20 s")]);
        },
      };
    };

    /** Start the binary itself with `args` and `extraEnv`, for checks that are not a session. */
    const spawnRaw = (args, extraEnv = {}) => {
      const child = spawn(executable, [...args, proxyArg], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      child.once("exit", () => running.delete(child));
      return child;
    };

    return { packaged, manifest, executable, projects, egress, launch, spawnRaw, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Wait until the editor shows `revision`. */
export const waitForRevision = (page, revision) => page.waitForFunction((value) => document.getElementById("revision")?.textContent === `Revision ${value}`, revision, { polling: 100, timeout: 30_000 });
