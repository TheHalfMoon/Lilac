import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMPORT_SCHEMA_VERSION,
  ImportValidationError,
  captureDynamicHtml,
  defaultImportPolicy,
  importHtmlSnapshot,
  mirrorStaticSite,
  validateNavigationUrl,
  validateResolvedAddresses,
} from "../packages/import-stack/src/index.ts";
import { NETWORK_POLICY_SCHEMA_VERSION } from "../packages/network-policy/src/index.ts";

const AT = "2026-10-07T00:00:00.000Z";

function grant(id, scheme, host, port = null, allowPrivateNetwork = false) {
  return { id, capability: "import.fetch", scheme, host, port, allowPrivateNetwork, purpose: "import network policy test" };
}

function allowlist(...grants) {
  return { schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "allowlist", grants };
}

function request(mode, source, networkPolicy) {
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    requestId: "net-1",
    actorId: "user-1",
    intent: "Import under the project network policy",
    at: AT,
    source,
    policy: defaultImportPolicy(mode),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
  };
}

async function mirror(req, url) {
  const dir = await mkdtemp(join(tmpdir(), "ninerr-netpol-"));
  let resolves = 0;
  let fetches = 0;
  try {
    const result = await mirrorStaticSite(req, url, { jobId: "netpol", workRoot: join(dir, "work") }, {
      resolveHost: async () => { resolves += 1; return ["93.184.216.34"]; },
      fetchResource: async () => {
        fetches += 1;
        return { status: 200, headers: { "content-type": "text/html", "content-encoding": "identity" }, body: new TextEncoder().encode("<main>ok</main>") };
      },
    });
    return { result, resolves, fetches };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REMOTE_SOURCE = { kind: "remote-url", uri: "https://example.com/a.html" };

test("a mirror redirect to a port outside the grant is refused before it is followed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ninerr-netpol-redirect-"));
  const fetched = [];
  try {
    const result = await mirrorStaticSite(
      request("remote", REMOTE_SOURCE, allowlist(grant("g-example", "https", "example.com"))),
      "https://example.com/a.html",
      { jobId: "netpol-redirect", workRoot: join(dir, "work") },
      {
        resolveHost: async () => ["93.184.216.34"],
        fetchResource: async (url) => {
          fetched.push(url.href);
          return { status: 302, headers: { location: "https://example.com:8443/x", "content-encoding": "identity" }, body: new Uint8Array() };
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.match(result.reason, /network policy denied import\.fetch: no import\.fetch grant covers https:\/\/example\.com:8443/u);
    assert.deepEqual(fetched, ["https://example.com/a.html"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a network policy is never inherited from the prototype chain", async () => {
  Object.prototype.networkPolicy = allowlist(grant("g-example", "https", "example.com"));
  try {
    const { result, resolves, fetches } = await mirror(request("remote", REMOTE_SOURCE), "https://example.com/a.html");
    assert.equal(result.status, "failed");
    assert.match(result.reason, /offline mode/u);
    assert.equal(resolves + fetches, 0);
  } finally {
    delete Object.prototype.networkPolicy;
  }
});

test("cross-origin references in mirrored CSS are skipped, not fatal, and never contacted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ninerr-netpol-css-"));
  const fetched = [];
  const bodies = {
    "https://example.com/a.html": ["text/html", '<link rel="stylesheet" href="/site.css"><main>ok</main>'],
    "https://example.com/site.css": ["text/css", "@font-face { src: url(https://fonts.gstatic.com/f.woff2); } main { background: url(/bg.png); }"],
    "https://example.com/bg.png": ["image/png", "png"],
  };
  try {
    const result = await mirrorStaticSite(
      request("remote", REMOTE_SOURCE, allowlist(grant("g-example", "https", "example.com"))),
      "https://example.com/a.html",
      { jobId: "netpol-css", workRoot: join(dir, "work") },
      {
        resolveHost: async () => ["93.184.216.34"],
        fetchResource: async (url) => {
          fetched.push(url.href);
          const [type, body] = bodies[url.href] ?? ["text/plain", ""];
          return { status: 200, headers: { "content-type": type, "content-encoding": "identity" }, body: new TextEncoder().encode(body) };
        },
      },
    );
    assert.equal(result.status, "ok", result.reason);
    assert.deepEqual(fetched.sort(), ["https://example.com/a.html", "https://example.com/bg.png", "https://example.com/site.css"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without a network policy, network-mode imports are refused before any resolve or fetch", async () => {
  const { result, resolves, fetches } = await mirror(request("remote", REMOTE_SOURCE), "https://example.com/a.html");
  assert.equal(result.status, "failed");
  assert.match(result.reason, /network policy denied import\.fetch: network is disabled \(offline mode\)/u);
  assert.equal(resolves, 0);
  assert.equal(fetches, 0);
});

test("a granted host imports; other hosts, ports, and schemes are refused before contact", async () => {
  const granted = await mirror(request("remote", REMOTE_SOURCE, allowlist(grant("g-example", "https", "example.com"))), "https://example.com/a.html");
  assert.equal(granted.result.status, "ok");
  assert.equal(granted.fetches, 1);
  for (const networkPolicy of [
    allowlist(grant("g-other", "https", "other.test")),
    allowlist(grant("g-port", "https", "example.com", 8443)),
    allowlist(grant("g-http", "http", "example.com")),
    allowlist({ ...grant("g-cap", "https", "example.com"), capability: "asset.fetch" }),
  ]) {
    const denied = await mirror(request("remote", REMOTE_SOURCE, networkPolicy), "https://example.com/a.html");
    assert.equal(denied.result.status, "failed");
    assert.match(denied.result.reason, /network policy denied import\.fetch: no import\.fetch grant covers https:\/\/example\.com:443/u);
    assert.equal(denied.resolves + denied.fetches, 0);
  }
});

test("local-app imports need local-only mode or an explicit loopback grant", () => {
  const local = defaultImportPolicy("local-app");
  assert.equal(validateNavigationUrl("http://localhost:3000/", local, { schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "local-only", grants: [] }).port, "3000");
  assert.equal(validateNavigationUrl("http://localhost:3000/", local, allowlist(grant("g-local", "http", "localhost", 3000))).port, "3000");
  assert.throws(() => validateNavigationUrl("http://localhost:3000/", local, allowlist(grant("g-example", "https", "example.com"))), /no import\.fetch grant covers/u);
  assert.throws(() => validateNavigationUrl("http://localhost:4000/", local, allowlist(grant("g-local", "http", "localhost", 3000))), /no import\.fetch grant covers http:\/\/localhost:4000/u);
  assert.throws(() => validateNavigationUrl("http://localhost:3000/", local), /offline mode/u);
});

// Resolution needs an allowed policy decision. The policy's own address rules (evaluateResolved)
// are defence in depth: Grain 6's address checks are at least as strict in every mode, so a
// rebind is refused by Grain 6 first and the policy layer is never the sole refusal.
test("resolved addresses need an allowed policy decision; a private-network grant does not widen remote mode", () => {
  const remote = defaultImportPolicy("remote");
  const privateGrant = allowlist(grant("g-private", "https", "example.com", null, true));
  const url = validateNavigationUrl("https://example.com/", remote, privateGrant);
  validateResolvedAddresses(url, ["93.184.216.34"], remote, privateGrant);
  assert.throws(() => validateResolvedAddresses(url, ["10.0.0.5"], remote, privateGrant), /remote target resolved to forbidden address/u);
  assert.throws(() => validateResolvedAddresses(url, ["93.184.216.34"], remote), /network policy denied import\.fetch/u);

  const local = defaultImportPolicy("local-app");
  const localGrant = allowlist(grant("g-local", "http", "localhost", 3000));
  const localUrl = validateNavigationUrl("http://localhost:3000/", local, localGrant);
  validateResolvedAddresses(localUrl, ["127.0.0.1"], local, localGrant);
  assert.throws(() => validateResolvedAddresses(localUrl, ["127.0.0.1"], local), /network policy denied import\.fetch/u);
});

test("Playwright subrequests outside the grant are refused and never fetched", async () => {
  const req = request(
    "local-app",
    { kind: "local-app", uri: "http://localhost:3000", baseUrl: "http://localhost:3000" },
    allowlist(grant("g-local", "http", "localhost", 3000)),
  );
  const fetched = [];
  let routeHandler = null;
  const route = (url, navigation) => ({
    request: () => ({ url: () => url, isNavigationRequest: () => navigation, method: () => "GET", allHeaders: async () => ({}) }),
    fulfill: async () => {},
    abort: async () => {},
  });
  const context = {
    async route(_pattern, handler) { routeHandler = handler; },
    async routeWebSocket() {},
    async newPage() {
      return {
        async goto(url) {
          await routeHandler(route(url, true));
          await routeHandler(route("http://localhost:4000/tracker.js", false));
        },
        async content() { return "<main>ok</main>"; },
        url() { return "http://localhost:3000/"; },
      };
    },
    async close() {},
  };
  const result = await captureDynamicHtml(req, "http://localhost:3000", {
    resolveHost: async () => ["127.0.0.1"],
    loadPlaywright: async () => ({ chromium: { launch: async () => ({ newContext: async () => context, close: async () => {} }) } }),
    fetchHttp: async (url) => {
      fetched.push(url.href);
      return { status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<main>ok</main>") };
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /network policy denied import\.fetch: no import\.fetch grant covers http:\/\/localhost:4000/u);
  assert.deepEqual(fetched, ["http://localhost:3000/"]);
});

test("malformed network policies are rejected and proposals never embed the network policy", () => {
  const snapshot = (networkPolicy) => importHtmlSnapshot(
    request("offline", { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" }, networkPolicy),
    "<main>Hello</main>",
  );
  assert.throws(() => snapshot({ schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "everything", grants: [] }), ImportValidationError);
  assert.throws(() => snapshot({ schemaVersion: NETWORK_POLICY_SCHEMA_VERSION, mode: "local-only", grants: [grant("g", "https", "example.com")] }), ImportValidationError);
  const withPolicy = snapshot(allowlist(grant("g-example", "https", "example.com")));
  assert.equal(Object.hasOwn(withPolicy, "networkPolicy"), false);
  assert.deepEqual(withPolicy, snapshot(undefined));
});
