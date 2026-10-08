// Run the Lilac desktop app (packages/desktop) in tests, through playwright-core's Electron
// driver, on the pinned Electron runtime (node scripts/fetch-electron.mjs). On Linux without
// a display, a private Xvfb server is started. Electron's OS sandbox cannot run as root,
// and the app never turns it off, so these tests run as an ordinary user: locally, as root
// or without the runtime they are skipped; in CI (CI=true) they fail instead.
import { spawn } from "node:child_process";
import { findElectron } from "../../scripts/desktop/electron.mjs";

export function desktopTestOptions() {
  const reason = findElectron() === null
    ? "the Electron runtime is not fetched (node scripts/fetch-electron.mjs)"
    : typeof process.getuid === "function" && process.getuid() === 0
      ? "Electron's sandbox cannot run as root; run the desktop tests as an ordinary user"
      : null;
  if (reason !== null && process.env.CI !== "true") return { skip: reason };
  return {};
}

/** A display for Electron: the current one, or a private Xvfb server on Linux. */
export async function display() {
  if (process.platform !== "linux" || process.env.DISPLAY) return { env: {}, stop: async () => {} };
  const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
  const number = await new Promise((resolve, reject) => {
    let text = "";
    server.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.trim());
    });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Xvfb exited (${code})`)));
  });
  return {
    env: { DISPLAY: `:${number}` },
    async stop() {
      server.kill("SIGTERM");
      await new Promise((resolve) => (server.exitCode !== null ? resolve() : server.once("exit", resolve)));
    },
  };
}

/** Start the desktop app; `env` adds to (and overrides) this process's environment. */
export async function launchDesktop({ env = {}, args = [] } = {}) {
  const { _electron } = await import("playwright-core");
  const app = await _electron.launch({
    executablePath: findElectron(),
    args: ["packages/desktop", ...args],
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  const errors = [];
  try {
    const window = await app.firstWindow();
    window.on("pageerror", (error) => errors.push(error.message));
    window.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await window.waitForFunction(() => document.documentElement.dataset.ready === "true");
    return { app, window, errors };
  } catch (error) {
    // An app that did not come up is still stopped, so the test run can end.
    await app.close().catch(() => app.process().kill("SIGKILL"));
    throw error;
  }
}
