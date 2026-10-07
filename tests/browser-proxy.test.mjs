import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImpeccableCliRunner, scanBrowserUrl, startBrowserPolicyProxy } from "../packages/design-assurance/src/index.mjs";

// P06 gate 5, grain d (#114): browser scans run behind a policy proxy, so DNS
// rebinding, redirects and subresource loads to private hosts fail closed.

const PUBLIC = "93.184.215.14";

async function withServer(handler, fn) {
  const hits = [];
  const server = createServer((request, response) => { hits.push({ url: request.url, host: request.headers.host }); handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(server.address().port, hits); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

// What the browser does through an HTTP proxy: absolute-form requests for http URLs.
function viaProxy(proxyUrl, url) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: proxy.hostname, port: proxy.port, method: "GET", path: url, headers: { host: new URL(url).host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

// ... and CONNECT for https and WebSocket targets.
function connectViaProxy(proxyUrl, authority) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.once("data", (chunk) => { resolve(chunk.toString("latin1").split("\r\n")[0]); socket.destroy(); });
    socket.once("error", reject);
  });
}

const lookupTable = (table) => async (host) => {
  const answer = table[host];
  if (answer === undefined) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return (typeof answer === "function" ? answer() : answer).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

test("the proxy refuses private, loopback and metadata destinations by default", async () => {
  await withServer((_request, response) => response.end("secret"), async (port, hits) => {
    const proxy = await startBrowserPolicyProxy({ lookup: lookupTable({ "rebind.test": ["127.0.0.1"], "lan.test": ["10.0.0.5"] }) });
    try {
      assert.equal((await viaProxy(proxy.url, `http://rebind.test:${port}/`)).status, 403);
      assert.equal((await viaProxy(proxy.url, `http://127.0.0.1:${port}/`)).status, 403);
      assert.equal((await viaProxy(proxy.url, "http://lan.test/")).status, 403);
      assert.match(await connectViaProxy(proxy.url, "169.254.169.254:443"), / 403 /u);
      assert.match(await connectViaProxy(proxy.url, `[::1]:${port}`), / 403 /u);
      assert.match(await connectViaProxy(proxy.url, `localhost.:${port}`), / (403|502) /u);
      assert.equal(hits.length, 0, "nothing reached the private server");
      const reasons = proxy.denials().map((entry) => entry.host);
      assert.ok(["rebind.test", "127.0.0.1", "lan.test", "169.254.169.254", "::1"].every((host) => reasons.includes(host)), JSON.stringify(proxy.denials()));
    } finally {
      await proxy.close();
    }
  });
});

test("an unresolvable host is a gateway error, not a policy denial", async () => {
  const proxy = await startBrowserPolicyProxy({ lookup: lookupTable({}) });
  try {
    assert.equal((await viaProxy(proxy.url, "http://missing.test/")).status, 502);
    assert.match(await connectViaProxy(proxy.url, "missing.test:443"), / 502 /u);
    assert.deepEqual(proxy.denials(), []);
  } finally {
    await proxy.close();
  }
});

test("allowed contacts reach the pinned address with the original Host, and redirects pass through unfollowed", async () => {
  let calls = 0;
  const handler = (request, response) => {
    if (request.url === "/go") { response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); response.end(); return; }
    response.end("page");
  };
  await withServer(handler, async (port, hits) => {
    // With allowPrivateNetwork, loopback and private ranges are allowed but metadata never is.
    const proxy = await startBrowserPolicyProxy({ allowPrivateNetwork: true, lookup: lookupTable({ "app.test": () => { calls += 1; return ["127.0.0.1"]; } }) });
    try {
      const page = await viaProxy(proxy.url, `http://app.test:${port}/page`);
      assert.equal(page.status, 200);
      assert.equal(page.body, "page");
      assert.deepEqual(hits[0], { url: "/page", host: `app.test:${port}` });
      assert.equal(calls, 1, "resolved once per contact");
      const hop = await viaProxy(proxy.url, `http://app.test:${port}/go`);
      assert.equal(hop.status, 302, "the browser, not the proxy, follows the redirect");
      assert.equal((await viaProxy(proxy.url, hop.location)).status, 403, "and the redirect target is checked again");
      assert.deepEqual(proxy.denials().map((entry) => entry.host), ["169.254.169.254"]);
    } finally {
      await proxy.close();
    }
  });
});

// A fake runner that behaves like the browser: it fetches the given URLs through the
// proxy the scan hands it, and fails the way the real runner does without one.
const browsingRunner = (urlsFor) => {
  const seen = [];
  return {
    seen,
    async scanTarget(target, { proxyUrl }) {
      assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/u, "the scan always runs behind the proxy");
      for (const url of urlsFor(target)) seen.push(await viaProxy(proxyUrl, url).catch((error) => ({ error: error.message })));
      return { exitCode: 0, stderr: "", findings: [] };
    },
  };
};

test("DNS rebinding between the pre-check and the browser's contact fails the scan", async () => {
  await withServer((_request, response) => response.end("internal"), async (port, hits) => {
    let call = 0;
    // Public for the pre-check, loopback by the time the browser connects.
    const lookup = lookupTable({ "rebind.test": () => (call++ === 0 ? [PUBLIC] : ["127.0.0.1"]) });
    const runner = browsingRunner((target) => [target]);
    await assert.rejects(scanBrowserUrl({ url: `http://rebind.test:${port}/`, runner, lookup }), /denied by network policy: rebind\.test \(loopback address 127\.0\.0\.1\)/u);
    assert.equal(hits.length, 0);
    assert.equal(runner.seen[0].status, 403);
  });
});

test("a redirect or subresource to a private host fails the scan", async () => {
  const lookup = lookupTable({ "site.test": [PUBLIC], "internal.test": ["192.168.1.10"] });
  // The redirect target and an image both point inside the network.
  const runner = browsingRunner(() => ["http://internal.test/admin", "http://169.254.169.254/latest/meta-data/"]);
  await assert.rejects(scanBrowserUrl({ url: "http://site.test/", runner, lookup }), (error) => {
    assert.match(error.message, /2 contact\(s\) denied/u);
    assert.match(error.message, /internal\.test \(private address 192\.168\.1\.10\)/u);
    assert.match(error.message, /169\.254\.169\.254/u);
    return true;
  });
});

test("metadata stays denied even when private-network scans are allowed", async () => {
  const runner = browsingRunner(() => ["http://169.254.169.254/latest/meta-data/"]);
  await assert.rejects(scanBrowserUrl({ url: "http://localhost:3000/", allowPrivateNetwork: true, runner, lookup: lookupTable({}) }), /169\.254\.169\.254/u);
  const quiet = browsingRunner(() => []);
  await scanBrowserUrl({ url: "http://localhost:3000/", allowPrivateNetwork: true, runner: quiet, lookup: lookupTable({}) });
});

// The real engine launches whatever the runner names as its browser; a stand-in browser
// records the argv it is started with and exits, so the scan itself fails.
test("the runner starts the browser only through a wrapper that forces the proxy", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilac-browser-proxy-"));
  try {
    const record = join(dir, "argv.txt");
    const fakeBrowser = join(dir, "fake-browser");
    await writeFile(fakeBrowser, `#!/bin/sh\nfor a do printf '%s\\n' "$a"; done > ${record}\nexit 3\n`);
    await chmod(fakeBrowser, 0o755);
    const runner = createImpeccableCliRunner({ browserExecutable: fakeBrowser, timeoutMs: 60_000 });
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("lilac-browser-")).length;
    await assert.rejects(runner.scanTarget("http://site.test/", { proxyUrl: "http://127.0.0.1:9" }));
    assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("lilac-browser-")).length, before, "the wrapper is removed");
    if (!existsSync(record)) return assert.fail("the engine did not start the configured browser");
    const argv = readFileSync(record, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 5), [
      "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--dns-prefetch-disable",
    ]);
    assert.equal(argv.slice(5).some((arg) => /^--(proxy|no-proxy|host-resolver|enable-quic)/u.test(arg)), false, "the launcher cannot add its own proxy switches");
    await assert.rejects(runner.scanTarget("http://site.test/", { proxyUrl: "http://evil.test:8080" }), /loopback http proxy/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the wrapper drops proxy switches the launcher passes", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilac-browser-proxy-"));
  try {
    const record = join(dir, "argv.txt");
    const fakeBrowser = join(dir, "fake-browser");
    await writeFile(fakeBrowser, `#!/bin/sh\nfor a do printf '%s\\n' "$a"; done > ${record}\nexit 3\n`);
    await chmod(fakeBrowser, 0o755);
    // A stand-in engine that launches $IMPECCABLE_BROWSER with hostile switches.
    const engine = join(dir, "engine.mjs");
    await writeFile(engine, `import { spawnSync } from "node:child_process";\nspawnSync(process.env.IMPECCABLE_BROWSER, ["--no-proxy-server", "--proxy-server=direct://", "--proxy-bypass-list=*", "--host-resolver-rules=MAP * 127.0.0.1", "--enable-quic", "--keep"]);\nprocess.stdout.write("[]");\n`);
    const runner = createImpeccableCliRunner({ cliPath: engine, browserExecutable: fakeBrowser });
    await runner.scanTarget("http://site.test/", { proxyUrl: "http://127.0.0.1:9" });
    const argv = readFileSync(record, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(5), ["--keep"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// End to end with a real Chromium when one is available (LILAC_TEST_BROWSER, or the
// usual locations). --no-sandbox only because CI and containers may run as root.
const realBrowser = [process.env.LILAC_TEST_BROWSER, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => typeof path === "string" && path !== "" && existsSync(path));

test("a real browser scan fails closed on a private subresource", { skip: realBrowser === undefined || process.platform === "win32" ? "no Chromium available" : false, timeout: 120_000 }, async () => {
  const page = '<html><body><h1>Scan me</h1><img src="http://169.254.169.254/latest/meta-data/x.png"></body></html>';
  await withServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(page); }, async (port, hits) => {
    const runner = createImpeccableCliRunner({ browserExecutable: realBrowser, browserFlags: ["--no-sandbox"], timeoutMs: 90_000 });
    await assert.rejects(scanBrowserUrl({ url: `http://127.0.0.1:${port}/`, allowPrivateNetwork: true, runner }), /169\.254\.169\.254/u);
    assert.ok(hits.some((hit) => hit.url === "/"), "the page itself was fetched through the proxy");
  });
});
