import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editorOrigin, mayNavigate, mayRequest, windowPreferences } from "../packages/desktop/src/policy.mjs";
import { findElectron } from "../scripts/desktop/electron.mjs";
import { desktopTestOptions, display, launchDesktop } from "./support/desktop.mjs";
import { layerCount, waitRevision } from "./support/editor.mjs";

// PC9 (#174): the desktop bridge. The Lilac desktop app is a thin Electron shell around the
// same studio host local web mode runs: a context-isolated, sandboxed window with no Node
// and a minimal preload, which may not navigate away, open windows, attach webviews,
// request anything but the host, or be granted a permission. Closes PC gate 5.

test("the desktop window's rules: only the host's origin, and no Node in the page", () => {
  const origin = editorOrigin("http://127.0.0.1:41234");
  assert.equal(origin, "http://127.0.0.1:41234");
  assert.throws(() => editorOrigin("http://localhost:41234"), /127\.0\.0\.1/u);
  assert.throws(() => editorOrigin("https://127.0.0.1:41234"), /127\.0\.0\.1/u);
  assert.throws(() => editorOrigin("http://127.0.0.1"), /127\.0\.0\.1/u);
  assert.equal(mayNavigate(origin, "http://127.0.0.1:41234/packages/studio-web/src/index.html"), true);
  for (const target of ["http://127.0.0.1:41235/", "http://localhost:41234/", "https://example.com/", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    assert.equal(mayNavigate(origin, target), false, target);
  }
  for (const target of ["http://127.0.0.1:41234/api/document", "data:image/png;base64,AA==", "blob:http://127.0.0.1:41234/x", "about:srcdoc"]) {
    assert.equal(mayRequest(origin, target), true, target);
  }
  // Developer tools' own pages only when developer tools are allowed (never when packaged).
  assert.equal(mayRequest(origin, "devtools://devtools/bundled/inspector.html"), false);
  assert.equal(mayRequest(origin, "devtools://devtools/bundled/inspector.html", { devtools: true }), true);
  assert.equal(windowPreferences("/x/preload.cjs").devTools, false);
  assert.equal(windowPreferences("/x/preload.cjs", { devTools: true }).devTools, true);
  for (const target of ["http://127.0.0.1:41235/", "https://example.com/x.png", "ws://127.0.0.1:41234/", "file:///etc/passwd", "ftp://example.com/"]) {
    assert.equal(mayRequest(origin, target), false, target);
  }
  const preferences = windowPreferences("/x/preload.cjs");
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.webviewTag, false);
  assert.equal(preferences.webSecurity, true);
});

test("the desktop app runs the editor in an isolated, sandboxed window that reaches only its host", { ...desktopTestOptions(), timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-desktop-")));
  const projects = join(root, "projects");
  const screen = await display();
  // Another server on this computer, which the window must not reach either.
  const hits = [];
  const other = createServer((request, response) => {
    hits.push(request.url);
    response.end("other");
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const otherUrl = `http://127.0.0.1:${other.address().port}`;
  // Every connection the app makes off this computer goes through this proxy, which
  // records it and refuses it. Lilac must make none, not even from the browser process.
  const egress = [];
  const proxy = createServer((request, response) => {
    egress.push(request.url);
    response.writeHead(403).end();
  });
  proxy.on("connect", (request, socket) => {
    egress.push(`CONNECT ${request.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const args = [`--proxy-server=http://127.0.0.1:${proxy.address().port}`];
  const home = join(root, "home");
  mkdirSync(join(home, "Downloads"), { recursive: true });
  const env = { ...screen.env, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DOWNLOAD_DIR: join(home, "Downloads"), LILAC_PROJECTS: projects, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "" };
  let desktop = null;
  // The step under way, named in a failure (CI annotates only its first line).
  let step = "launch";
  try {
    desktop = await launchDesktop({ env, args });
    const { app, window } = desktop;
    const origin = new URL(window.url()).origin;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);

    step = "web preferences";
    // The window, as the main process configured it.
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const [only, ...more] = BrowserWindow.getAllWindows();
      const last = only.webContents.getLastWebPreferences();
      return { windows: 1 + more.length, contextIsolation: last.contextIsolation, sandbox: last.sandbox, nodeIntegration: last.nodeIntegration, webviewTag: last.webviewTag };
    });
    assert.deepEqual(preferences, { windows: 1, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });

    step = "isolation";
    // The page has no Node, and the preload gives it only that it is the desktop app.
    const page = await window.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      module: typeof module,
      buffer: typeof Buffer,
      bridge: Object.keys(window.lilacDesktop ?? {}),
      frozen: Object.isFrozen(window.lilacDesktop),
      desktop: window.lilacDesktop?.desktop,
    }));
    assert.deepEqual(page, { require: "undefined", process: "undefined", module: "undefined", buffer: "undefined", bridge: ["desktop", "platform"], frozen: true, desktop: true });

    step = "editor session";
    // The editor works: a project, a box, an edit committed through the host.
    await window.locator("#new-project-name").fill("desk");
    await window.keyboard.press("Enter");
    await waitRevision(window, 0);
    await window.locator("#action-insert-box").click();
    await waitRevision(window, 1);
    await window.locator("#inspect-name").fill("From the desktop");
    await window.keyboard.press("Tab");
    await waitRevision(window, 2);

    step = "navigation";
    // No other window, no navigation away, no webview.
    assert.equal(await window.evaluate(() => window.open("https://example.com/")), null);
    assert.equal(await window.evaluate((url) => window.open(url), otherUrl), null);
    await window.evaluate((url) => {
      const view = document.createElement("webview");
      view.setAttribute("src", url);
      document.body.append(view);
    }, `${otherUrl}/webview`);
    for (const target of ["https://example.com/", `${otherUrl}/navigate`, "file:///etc/hostname"]) {
      await window.evaluate((url) => {
        location.href = url;
      }, target);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(new URL(window.url()).origin, origin, `still on the editor after trying ${target}`);
    }
    await window.waitForFunction(() => document.documentElement.dataset.ready === "true");

    step = "requests";
    // Requests: only the host. Another local server and the network are both refused.
    const requests = await window.evaluate(async (url) => {
      const attempt = (target) => fetch(target).then(() => "reached", () => "refused");
      return {
        other: await attempt(`${url}/fetch`),
        remote: await attempt("https://example.com/"),
        image: await new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve("reached");
          image.onerror = () => resolve("refused");
          image.src = `${url}/image.png`;
        }),
      };
    }, otherUrl);
    assert.deepEqual(requests, { other: "refused", remote: "refused", image: "refused" });
    // The editor page's own Content-Security-Policy already refuses those. The shell refuses
    // them too, for any page: a window the main process points elsewhere loads nothing.
    const shellRefusal = await app.evaluate(async ({ BrowserWindow }, url) => {
      const probe = new BrowserWindow({ show: false });
      try {
        await probe.webContents.loadURL(url);
        return "loaded";
      } catch (error) {
        return error.code;
      } finally {
        probe.destroy();
      }
    }, `${otherUrl}/probe`);
    assert.equal(shellRefusal, "ERR_BLOCKED_BY_CLIENT");

    step = "permissions";
    // No permission is granted.
    const permissions = await window.evaluate(async () => ({
      notification: await Notification.requestPermission(),
      camera: await navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", (error) => error.name),
      geolocation: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("granted"), (error) => resolve(error.code === error.PERMISSION_DENIED ? "denied" : `error ${error.code}`))),
      clipboard: await navigator.clipboard.readText().then(() => "granted", (error) => error.name),
      screen: await navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => "granted", (error) => error.name),
      query: (await navigator.permissions.query({ name: "geolocation" })).state,
    }));
    assert.equal(permissions.notification, "denied");
    assert.equal(permissions.geolocation, "denied");
    assert.equal(permissions.query, "denied");
    assert.notEqual(permissions.camera, "granted");
    assert.notEqual(permissions.clipboard, "granted");
    assert.equal(permissions.screen, "NotAllowedError");
    step = "downloads";
    // No download is saved, wherever it comes from.
    const refused = await app.evaluate(({ BrowserWindow, session }, url) => new Promise((resolve) => {
      // Registered after the app's own handler, so it sees whether that handler refused it.
      session.defaultSession.once("will-download", (event) => resolve(event.defaultPrevented));
      BrowserWindow.getAllWindows()[0].webContents.downloadURL(url);
    }), `${origin}/packages/studio-web/src/index.html`);
    assert.equal(refused, true, "the app refused the download");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(readdirSync(join(home, "Downloads")), [], "nothing was downloaded");
    assert.deepEqual(hits, [], "nothing the window did reached the other server");

    step = "single instance";
    // One Lilac per user: a second start hands over to this one and exits.
    const second = spawn(findElectron(), ["packages/desktop"], { env: { ...process.env, ...env }, stdio: "ignore" });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        second.kill("SIGKILL");
        resolve("still running after 15 s");
      }, 15_000);
      second.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, "the second start exits");
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

    step = "close window";
    // Closing the window quits Lilac and stops the host: the project is closed and its
    // lock released.
    assert.ok(existsSync(join(projects, "desk", ".lilac", "lock")));
    assert.ok(existsSync(join(projects, ".lilac-studio.json")));
    const exited = new Promise((resolve) => app.process().once("exit", (code) => resolve(code)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await exited, 0, "Lilac quit when its window closed");
    assert.equal(existsSync(join(projects, "desk", ".lilac", "lock")), false, "the lock is released");
    assert.equal(existsSync(join(projects, ".lilac-studio.json")), false, "the discovery file is removed");
    assert.deepEqual(desktop.errors.filter((message) => !/violates the (?:following|document's) Content Security Policy|Not allowed to load local resource: file:/u.test(message)), [], "only the refused requests are logged");

    step = "relaunch";
    // Started again: the project is there, as it was.
    desktop = await launchDesktop({ env, args });
    await desktop.window.locator("#dialog[open] [data-project=desk]").click();
    await waitRevision(desktop.window, 2);
    assert.equal(await layerCount(desktop.window), 2);
    assert.ok((await desktop.window.locator("#layers [role=treeitem] .label").allTextContents()).includes("From the desktop"));
    await desktop.app.close();
    assert.deepEqual(egress, [], "nothing left this computer, from any process of the app");
  } catch (error) {
    throw new Error(`${step}: ${String(error?.message ?? error).split("\n")[0]}`, { cause: error });
  } finally {
    await desktop?.app.close().catch(() => {});
    await new Promise((resolve) => other.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
    await screen.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
