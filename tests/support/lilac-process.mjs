import { spawn } from "node:child_process";
import { findBrowser } from "./browser.mjs";

// Run Lilac the way a person does (npm start, scripts/lilac.mjs), under the no-network
// preload, and open its links in Chromium with every request outside Lilac recorded.

export const attemptsIn = (text) => text.split("\n").filter((line) => line.startsWith("LILAC-NETWORK-ATTEMPT"));

export function run(args, env = {}) {
  const child = spawn(process.execPath, ["--import", "./tests/support/no-network.mjs", ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve(signal ?? code)));
  return { child, output, exited };
}

export async function startLilac(projects) {
  const lilac = run(["scripts/lilac.mjs", "--projects", projects, "--port", "0"], { LILAC_STDIN_LINKS: "1" });
  const links = [];
  const nextLink = async () => {
    const seen = links.length;
    for (let tries = 0; tries < 500; tries += 1) {
      const all = [...lilac.output.stdout.matchAll(/^Open Lilac: (\S+)$/gmu)].map((match) => match[1]);
      if (all.length > seen) {
        links.push(...all.slice(seen));
        return all[seen];
      }
      if (lilac.child.exitCode !== null) throw new Error(`lilac exited: ${lilac.output.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("lilac printed no link");
  };
  const first = await nextLink();
  return {
    ...lilac,
    first,
    origin: new URL(first).origin,
    async newLink() {
      lilac.child.stdin.write("\n");
      return nextLink();
    },
    async stop() {
      lilac.child.kill("SIGTERM");
      return lilac.exited;
    },
    /** A crash: the process is killed outright, with no chance to clean up. */
    async kill() {
      lilac.child.kill("SIGKILL");
      return lilac.exited;
    },
  };
}

export async function browse() {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: findBrowser(), headless: true, args: ["--no-sandbox"] });
}

export async function openTab(browser, origin, link, { ready = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const foreign = [];
  const errors = [];
  await context.routeWebSocket(/.*/u, (socket) => {
    foreign.push(socket.url());
    socket.close();
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    foreign.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(link);
  if (ready) await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
  return { page, foreign, errors };
}
