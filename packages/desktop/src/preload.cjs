// The desktop window's preload, deliberately minimal: it runs sandboxed and isolated from
// the page, and gives the page only the fact that it runs in the desktop app. The editor
// talks to the studio host over HTTP exactly as it does in a browser; there is no IPC.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("ninerrDesktop", Object.freeze({ desktop: true, platform: process.platform }));
