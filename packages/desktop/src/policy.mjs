// What the Lilac desktop window may do, as plain functions over URLs, so the rules are
// testable without Electron. The window shows the editor the studio host serves on
// 127.0.0.1, and nothing else: it never navigates away, opens no windows, and the page's
// own requests go only to that host.

/** The editor's origin, from the host's URL (http://127.0.0.1:<port>). */
export function editorOrigin(hostUrl) {
  const url = new URL(hostUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "") throw new Error("the desktop app only shows a Lilac host on 127.0.0.1");
  return url.origin;
}

/** May the window's page navigate to `target`? Only within the editor's own origin. */
export function mayNavigate(origin, target) {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

// Schemes a page can reach without the network, which Chromium still reports: the
// renderer's sandboxed frame (about:srcdoc), images a design holds inline (data:), and the
// editor's own object URLs (blob:). Developer tools, when opened, use devtools:.
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:", "devtools:"]);

/** May the page request `target`? Only the editor's origin and local schemes. */
export function mayRequest(origin, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  return url.origin === origin;
}

/** The web preferences every Lilac window gets: no Node, isolated and sandboxed. */
export function windowPreferences(preload) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
  };
}
