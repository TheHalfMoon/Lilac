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

const FETCH_BAD_PORTS_WITHOUT_ZERO = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];

test("the blocked list is the Fetch standard's bad ports without 0, exactly", () => {
  assert.deepEqual([...BROWSER_BLOCKED_PORTS].sort((a, b) => a - b), FETCH_BAD_PORTS_WITHOUT_ZERO);
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

test("a port in use asked for explicitly still fails as before, and no error listener is left behind", async () => {
  const taken = createServer();
  await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const server = createServer();
  try {
    await assert.rejects(listenOnBrowserPort(server, taken.address().port, "127.0.0.1"), (error) => error.code === "EADDRINUSE");
    assert.equal(server.listenerCount("error"), 0);
    const port = await listenOnBrowserPort(server, 0, "127.0.0.1");
    assert.ok(port > 0);
    assert.equal(server.listenerCount("error"), 0, "a successful listen leaves no listener either");
  } finally {
    await new Promise((resolve) => taken.close(resolve));
    await new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
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
