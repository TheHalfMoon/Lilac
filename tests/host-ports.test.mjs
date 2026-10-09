import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BROWSER_BLOCKED_PORTS, listenOnBrowserPort, startStudioHost } from "../packages/studio-host/src/index.ts";

// The studio host never keeps a port that browsers refuse to open (the Fetch standard's bad
// ports, which Chromium, Electron and Node's fetch enforce). On a machine whose dynamic port
// range starts low, port 0 can be handed one, and the editor would then never load.

test("the blocked list is the Fetch standard's, including the range low dynamic ports reach", () => {
  for (const port of [6665, 6666, 6667, 6668, 6669, 6697, 10080, 5060, 2049, 1719]) assert.ok(BROWSER_BLOCKED_PORTS.has(port), String(port));
  for (const port of [0, 80, 443, 3000, 8080, 6670]) assert.ok(!BROWSER_BLOCKED_PORTS.has(port), String(port));
});

test("a blocked port that is handed out is given back and another one taken", async (t) => {
  // Find a blocked port that is free here, to stand in for one the system hands out.
  let blocked = null;
  for (const port of [6666, 6667, 6668, 6669, 6665, 6697, 10080]) {
    const probe = createServer();
    const free = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => resolve(true));
    });
    await new Promise((resolve) => (free ? probe.close(resolve) : resolve()));
    if (free) {
      blocked = port;
      break;
    }
  }
  if (blocked === null) return t.skip("no blocked port is free on this machine");
  const server = createServer();
  const offered = [blocked, 0];
  try {
    const port = await listenOnBrowserPort(server, 0, "127.0.0.1", () => offered.shift() ?? 0);
    assert.notEqual(port, blocked);
    assert.ok(!BROWSER_BLOCKED_PORTS.has(port));
    assert.equal(server.address().port, port, "the server listens on the port returned");
    assert.equal(offered.length, 0, "the blocked port was tried first, then given back");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a blocked port asked for explicitly is refused with a clear reason", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-ports-")));
  try {
    await assert.rejects(startStudioHost({ projectsRoot: root, port: 6666 }), (error) => error.code === "blocked-port" && /browsers refuse to open/u.test(error.message));
    const host = await startStudioHost({ projectsRoot: root });
    try {
      assert.ok(!BROWSER_BLOCKED_PORTS.has(host.port));
    } finally {
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
