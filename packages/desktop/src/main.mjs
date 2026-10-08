// The Ninerr desktop app: a thin Electron shell around the same studio host local web mode
// runs (MASTER_PLAN PC gate 5). The host runs in this, the main process, on 127.0.0.1;
// the window shows the editor it serves, through the same single-use launch link a browser
// would use. The window is context-isolated and sandboxed with no Node, its preload is
// minimal, and it may not navigate away, open windows, attach webviews, request anything
// but the host, or be granted any permission.
import { BrowserWindow, Menu, app, dialog, session } from "electron";
import { fileURLToPath } from "node:url";
import { prepareProjectsFolder, resolveProjectsFolder, startStudioHost } from "../../studio-host/src/index.ts";
import { editorOrigin, mayNavigate, mayRequest, windowPreferences } from "./policy.mjs";

const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
// A development run starts Electron's default app with this folder (process.defaultApp);
// a packaged Ninerr starts itself. (app.isPackaged would not do: it goes by the
// executable's name, which a packaged macOS Ninerr keeps as Electron's.)
const PACKAGED = process.defaultApp !== true;

// Every renderer is sandboxed, whatever a window asks for.
app.enableSandbox();

let host = null;
let window = null;
let quitting = false;

// A quit that waits on the host gives up after this long, rather than hang.
const CLOSE_TIMEOUT_MS = 10_000;
// A renderer that keeps crashing is not reloaded forever: at most 3 times a minute, then
// Ninerr says so and quits (every change was already committed).
const MAX_RELOADS_PER_MINUTE = 3;
const reloads = [];

// One Ninerr per user: a second start brings the running window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start().catch(async (error) => {
    dialog.showErrorBox("Ninerr could not start", error instanceof Error ? error.message : String(error));
    // A host that did start is closed, so its projects' locks are released.
    await host?.close().catch(() => {});
    app.exit(1);
  });
}

function harden(origin) {
  const defaults = session.defaultSession;
  // Chromium's browser process fetches spell-check dictionaries from Google, outside any
  // page (so webRequest never sees it): spell checking is off, and the dictionary source
  // is an address that is never contacted.
  defaults.setSpellCheckerEnabled(false);
  defaults.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
  // No permission is ever granted: camera, microphone, location, notifications, MIDI,
  // clipboard reads, devices, screen capture.
  defaults.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaults.setPermissionCheckHandler(() => false);
  defaults.setDevicePermissionHandler(() => false);
  defaults.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  // The page reaches only the host, whatever it tries.
  const devtools = !PACKAGED;
  defaults.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !mayRequest(origin, details.url, { devtools }) }));
  // Downloads are refused (exports are copied, not downloaded).
  defaults.on("will-download", (event) => event.preventDefault());

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => {
      if (!mayNavigate(origin, event.url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!mayNavigate(origin, event.url)) event.preventDefault();
    });
  });
}

function menu() {
  // The standard roles (copy and paste, quit, window and zoom); developer tools only in a
  // development run, never in a packaged app.
  const view = [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }];
  if (!PACKAGED) view.push({ type: "separator" }, { role: "toggleDevTools" });
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : [{ label: "File", submenu: [{ role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: view },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function reloadAfterCrash() {
  const now = Date.now();
  while (reloads.length > 0 && now - reloads[0] > 60_000) reloads.shift();
  if (reloads.length >= MAX_RELOADS_PER_MINUTE) {
    dialog.showErrorBox("Ninerr stopped", "The editor stopped repeatedly. Your work is saved; start Ninerr again.");
    app.quit();
    return;
  }
  reloads.push(now);
  window.loadURL(host.launchUrl());
}

function openWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: "Ninerr",
    show: false,
    backgroundColor: "#16141f",
    webPreferences: windowPreferences(PRELOAD, { devTools: !PACKAGED }),
  });
  // A renderer that crashed is replaced, with a fresh link: nothing is lost, as every
  // change was committed by the host.
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`ninerr: the editor's renderer stopped (${details.reason}, exit code ${details.exitCode})\n`);
    if (window !== null && !quitting && details.reason !== "clean-exit") reloadAfterCrash();
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    window = null;
  });
  // A fresh single-use link for each window; the editor trades it for the token.
  window.loadURL(host.launchUrl());
}

async function start() {
  app.on("second-instance", () => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  // Closing the window quits Ninerr, on every platform: the host stops with it.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (host === null || quitting) return;
    // Stop the host first, so its projects are closed and their locks released.
    event.preventDefault();
    quitting = true;
    const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the host did not close in time")), CLOSE_TIMEOUT_MS).unref());
    Promise.race([host.close(), timeout]).then(() => app.exit(0), () => app.exit(1));
  });
  // Ctrl+C or a termination signal quits as the menu does.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());

  await app.whenReady();
  // Said once, so a log shows which kind of run this is.
  process.stderr.write(`ninerr: desktop app (${PACKAGED ? "packaged" : "development"}), Electron ${process.versions.electron}\n`);
  const { path: projectsRoot, note: folderNote } = resolveProjectsFolder();
  if (folderNote !== null) process.stderr.write(`ninerr: note: ${folderNote}\n`);
  try {
    prepareProjectsFolder(projectsRoot);
    host = await startStudioHost({ projectsRoot, port: 0 });
  } catch (error) {
    dialog.showErrorBox("Ninerr could not start", error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }
  harden(editorOrigin(host.url));
  menu();
  openWindow();
}
