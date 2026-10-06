import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMPORT_SCHEMA_VERSION,
  IMPORT_STACK_PROVENANCE,
  ImportConflictError,
  ImportSecurityError,
  ImportValidationError,
  canonicalImportStringify,
  captureDynamicHtml,
  commitImportProposal,
  createAssetRecord,
  createImportArtifact,
  createImportRequestLedger,
  deduplicateAssets,
  defaultImportPolicy,
  disposeStaticMirror,
  importHtmlSnapshot,
  isForbiddenRemoteAddress,
  mirrorStaticSite,
  proposalFromDoclingOutput,
  proposalFromStaticMirror,
  readAuthorizedLocalSource,
  recordImportRequest,
  runLocalDocling,
  safeRemoveImportJobDirectory,
  sanitizeImportedCssText,
  validateImportProposal,
  validateNavigationUrl,
  validateResolvedAddresses,
} from "../packages/import-stack/src/index.ts";
import { createDocument } from "../packages/document-model/src/index.mjs";
import { createHistoryState } from "../packages/history/src/index.mjs";

const AT = "2026-10-06T00:00:00.000Z";

function request(overrides = {}) {
  const policy = overrides.policy ?? defaultImportPolicy("offline");
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    requestId: overrides.requestId ?? "import-1",
    actorId: overrides.actorId ?? "user-1",
    intent: overrides.intent ?? "Import bounded content",
    at: overrides.at ?? AT,
    source: overrides.source ?? {
      kind: "html-snapshot",
      uri: "https://example.com/page",
      baseUrl: "https://example.com/page",
    },
    policy,
  };
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "lilac-import-stack-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("HTML snapshots are deterministic and preserve semantic structure", () => {
  const html = '<main id="app"><h1 class="title">Hello</h1><img src="/hero.png" alt="Hero"></main>';
  const left = importHtmlSnapshot(request(), html);
  const right = importHtmlSnapshot(request(), html);
  assert.equal(canonicalImportStringify(left), canonicalImportStringify(right));
  assert.equal(left.proposalId, right.proposalId);
  assert.equal(left.rootIds.length, 1);
  assert.equal(Object.values(left.nodes).some((node) => node.kind === "text" && node.text === "Hello"), true);
  const imageResource = left.resources.find((resource) => resource.kind === "image" && resource.uri === "https://example.com/hero.png");
  assert.equal(Boolean(imageResource), true);
  assert.equal(imageResource?.attribute, "src");
  const imageNode = Object.values(left.nodes).find((node) => node.kind === "image");
  assert.equal(Object.hasOwn(imageNode?.attributes ?? {}, "src"), false, "remote URL must remain non-authoritative resource data");
});

test("HTML import removes scripts, privileged embeds, handlers, unsafe schemes, and active SVG elements", () => {
  const proposal = importHtmlSnapshot(
    request(),
    '<div onclick="steal()"><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">bad</a><svg><animate attributeName="x"/></svg><img src="data:text/html,boom" onerror="x()"></div>',
  );
  assert.equal(proposal.security.scriptsRemoved, 1);
  assert.equal(proposal.security.dangerousElementsRemoved >= 2, true);
  assert.equal(proposal.security.eventHandlersRemoved, 2);
  assert.equal(proposal.security.dangerousUrlsRemoved, 2);
  const serialized = canonicalImportStringify(proposal);
  assert.equal(serialized.includes("javascript:"), false);
  assert.equal(serialized.includes("data:text/html"), false);
  assert.equal(Object.values(proposal.nodes).some((node) => node.tag === "script" || node.tag === "iframe" || node.tag === "animate"), false);

  const controlObfuscated = importHtmlSnapshot(request(), '<a href="java&#10;script:alert(1)">x</a>');
  assert.equal(canonicalImportStringify(controlObfuscated).includes("javascript:"), false);
});

test("CSS sanitizer detects comments and escaped spellings and rejects hidden fetch authority", () => {
  const safe = sanitizeImportedCssText(".a { color: red; display: grid; }", 1024);
  assert.equal(safe.unsafe, false);
  assert.match(safe.cssText ?? "", /color:\s*red/u);

  for (const css of [
    '@import "https://evil.test/x.css";',
    '.a { background: url(https://evil.test/x.png); }',
    '.a { background: u\\72l(https://evil.test/x.png); }',
    '.a { width: e\\78pression(alert(1)); }',
    '.a { be/**/havior: url(#x); }',
  ]) {
    const result = sanitizeImportedCssText(css, 4096);
    assert.equal(result.unsafe, true, css);
    assert.equal(result.cssText, null);
  }
});

test("HTML import strips srcset, form navigation, secret-bearing resource URLs, and deactivates forms", () => {
  const proposal = importHtmlSnapshot(
    request(),
    '<form action="https://example.com/submit"><button formaction="/other">Send</button><img src="/a.png?token=secret" srcset="/a2.png 2x"></form>',
  );
  const nodes = Object.values(proposal.nodes);
  assert.equal(nodes.some((node) => Object.hasOwn(node.attributes, "srcset")), false);
  assert.equal(nodes.some((node) => Object.hasOwn(node.attributes, "action") || Object.hasOwn(node.attributes, "formaction")), false);
  assert.equal(nodes.some((node) => node.tag === "form"), false);
  assert.equal(nodes.some((node) => node.tag === "div"), true, "form must be deactivated rather than becoming executable authority");
  assert.equal(nodes.some((node) => Object.values(node.attributes).some((value) => value.includes("token=secret"))), false);
});

test("HTML import enforces byte and DOM limits without silent truncation", () => {
  assert.throws(
    () => importHtmlSnapshot(request({ policy: { ...defaultImportPolicy("offline"), maxHtmlBytes: 20 } }), "<div>This input is longer than twenty bytes</div>"),
    ImportSecurityError,
  );
  assert.throws(
    () => importHtmlSnapshot(request({ policy: { ...defaultImportPolicy("offline"), maxDomNodes: 2 } }), "<div><span>hello</span></div>"),
    /maxDomNodes/u,
  );
});

test("proposal validation rejects executable tags, unsafe CSS, external URL authority, unknown fields, and broken graph identity", () => {
  const proposal = importHtmlSnapshot(request(), "<div><span>Hello</span></div>");
  assert.throws(() => validateImportProposal({ ...proposal, hiddenAuthority: true }), /unsupported field hiddenAuthority/u);
  const root = proposal.rootIds[0];
  const scripted = structuredClone(proposal);
  scripted.nodes[root].tag = "script";
  assert.throws(() => validateImportProposal(scripted), /tag is not allowed/u);

  const externalUrl = structuredClone(proposal);
  externalUrl.nodes[root].attributes.href = "https://evil.test/x";
  assert.throws(() => validateImportProposal(externalUrl), /external fetch authority/u);

  const unsafeStyle = structuredClone(proposal);
  unsafeStyle.nodes[root].style.cssText = "background:url(https://evil.test/x.png)";
  assert.throws(() => validateImportProposal(unsafeStyle), /unsafe/u);

  const unprovenAsset = structuredClone(proposal);
  unprovenAsset.nodes[root].attributes.src = "./objects/" + "a".repeat(64);
  assert.throws(() => validateImportProposal(unprovenAsset), /unproven local asset/u);

  const root2 = proposal.rootIds[0];
  const child = proposal.nodes[root2].children[0];
  const bad = structuredClone(proposal);
  bad.nodes[child].parentId = "missing-parent";
  assert.throws(() => validateImportProposal(bad), /missing parent/u);
});

test("request ledger is idempotent only for identical input and intent", () => {
  const proposal = importHtmlSnapshot(request(), "<div>Hello</div>");
  const first = recordImportRequest(createImportRequestLedger(), request(), proposal.inputSha256, proposal.proposalId);
  assert.equal(first.reused, false);
  assert.equal(recordImportRequest(first.ledger, request(), proposal.inputSha256, proposal.proposalId).reused, true);
  assert.throws(
    () => recordImportRequest(first.ledger, request({ intent: "Different intent" }), proposal.inputSha256, proposal.proposalId),
    ImportConflictError,
  );
});

test("assets and import artifacts hash exact binary bytes", () => {
  const policy = defaultImportPolicy("offline");
  const bytes = Uint8Array.from([0, 255, 1, 2, 128, 10]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const asset = createAssetRecord(bytes, { mediaType: "application/octet-stream", logicalName: "blob.bin" }, policy);
  assert.equal(asset.sha256, expected);
  const duplicate = createAssetRecord(bytes, { mediaType: "application/octet-stream", logicalName: "other.bin" }, policy);
  assert.equal(deduplicateAssets([duplicate, asset], policy).length, 1);
  const artifact = createImportArtifact(request(), bytes, { adapterId: "test", mediaType: "application/octet-stream" });
  assert.equal(artifact.sha256, expected);
});

test("remote URL policy rejects local, reserved, credential, and secret-bearing targets", () => {
  const remote = defaultImportPolicy("remote");
  for (const url of [
    "http://127.0.0.1:3000",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://example.com/path?token=secret",
  ]) assert.throws(() => validateNavigationUrl(url, remote));
  assert.equal(validateNavigationUrl("https://example.com/a", remote).hostname, "example.com");

  const local = defaultImportPolicy("local-app");
  assert.equal(validateNavigationUrl("http://localhost:3000", local).hostname, "localhost");
  assert.equal(validateNavigationUrl("http://127.0.0.1:3000", local).hostname, "127.0.0.1");
  assert.throws(() => validateNavigationUrl("https://example.com", local), ImportSecurityError);
});

test("resolved address validation closes DNS-rebinding escape paths", () => {
  const remote = defaultImportPolicy("remote");
  const url = validateNavigationUrl("https://example.com", remote);
  validateResolvedAddresses(url, ["93.184.216.34"], remote);
  assert.throws(() => validateResolvedAddresses(url, ["93.184.216.34", "127.0.0.1"], remote), ImportSecurityError);

  const local = defaultImportPolicy("local-app");
  const localUrl = validateNavigationUrl("http://localhost:5173", local);
  validateResolvedAddresses(localUrl, ["127.0.0.1", "::1"], local);
  assert.throws(() => validateResolvedAddresses(localUrl, ["127.0.0.1", "8.8.8.8"], local), ImportSecurityError);
});

test("forbidden address classifier covers private, link-local, documentation, and multicast ranges", () => {
  for (const address of [
    "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
    "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
  ]) assert.equal(isForbiddenRemoteAddress(address), true, address);
  assert.equal(isForbiddenRemoteAddress("93.184.216.34"), false);
  assert.equal(isForbiddenRemoteAddress("2606:4700:4700::1111"), false);
});

test("import proposal commit mutates only through history with exact attribution", () => {
  const proposal = importHtmlSnapshot(request(), '<section class="card"><h2>Hello</h2></section>');
  const history = createHistoryState(createDocument({ id: "doc-1", nodes: [], rootIds: [] }));
  const result = commitImportProposal(history, proposal, {
    transactionId: "tx-import-1",
    baseRevision: 0,
    at: "2026-10-06T00:01:00.000Z",
  });
  assert.equal(history.document.revision, 0);
  assert.equal(result.documentRevision, 1);
  const entry = result.history.past.at(-1);
  assert.equal(entry.transaction.actor, "user-1");
  assert.equal(entry.transaction.tool, "@lilac/import-stack");
  assert.deepEqual(entry.transaction.metadata.import, {
    requestId: proposal.requestId,
    proposalId: proposal.proposalId,
    inputSha256: proposal.inputSha256,
    sourceKind: proposal.source.kind,
    requestedAt: proposal.requestedAt,
  });
});

test("stale import commit refuses before history mutation", () => {
  const proposal = importHtmlSnapshot(request(), "<div>Hello</div>");
  const history = createHistoryState(createDocument({ id: "doc-1", nodes: [], rootIds: [] }));
  assert.throws(
    () => commitImportProposal(history, proposal, { transactionId: "tx-stale", baseRevision: 1, at: AT }),
    ImportConflictError,
  );
  assert.equal(history.document.revision, 0);
  assert.equal(history.past.length, 0);
});

test("Playwright adapter reports unavailable without installing or falling back", async () => {
  const req = request({
    source: { kind: "local-app", uri: "http://localhost:3000", baseUrl: "http://localhost:3000" },
    policy: defaultImportPolicy("local-app"),
  });
  const error = Object.assign(new Error("Cannot find package 'playwright'"), { code: "ERR_MODULE_NOT_FOUND" });
  const result = await captureDynamicHtml(req, "http://localhost:3000", {
    resolveHost: async () => ["127.0.0.1"],
    loadPlaywright: async () => { throw error; },
  });
  assert.equal(result.status, "unavailable");
});

test("Playwright adapter uses isolated bounded context and sanitizes captured HTML again", async () => {
  const req = request({
    source: { kind: "local-app", uri: "http://localhost:3000", baseUrl: "http://localhost:3000" },
    policy: defaultImportPolicy("local-app"),
  });
  let contextOptions = null;
  let routeHandler = null;
  let wsHandler = null;
  const context = {
    async route(_pattern, handler) { routeHandler = handler; },
    async routeWebSocket(_pattern, handler) { wsHandler = handler; },
    async newPage() {
      return {
        async goto(url) {
          const response = {
            headers: () => ({ "content-length": "25", "content-encoding": "identity" }),
            body: async () => new TextEncoder().encode("<html><body>ok</body></html>"),
          };
          await routeHandler({
            request: () => ({ url: () => url, isNavigationRequest: () => true }),
            fetch: async () => response,
            fulfill: async () => {},
            abort: async () => {},
          });
        },
        async content() { return '<main onclick="x()">Hello<script>alert(1)</script></main>'; },
        url() { return "http://localhost:3000/"; },
      };
    },
    async close() {},
  };
  const browser = {
    async newContext(options) { contextOptions = options; return context; },
    async close() {},
  };
  const result = await captureDynamicHtml(req, "http://localhost:3000", {
    resolveHost: async () => ["127.0.0.1"],
    loadPlaywright: async () => ({ chromium: { launch: async () => browser } }),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(contextOptions, {
    acceptDownloads: false,
    serviceWorkers: "block",
    permissions: [],
    ignoreHTTPSErrors: false,
  });
  assert.equal(typeof wsHandler, "function");
  assert.equal(result.value.security.scriptsRemoved, 1);
  assert.equal(result.value.security.eventHandlersRemoved, 1);
});

test("Playwright adapter blocks DNS resolution that escapes local-app loopback", async () => {
  const req = request({
    source: { kind: "local-app", uri: "http://localhost:3000", baseUrl: "http://localhost:3000" },
    policy: defaultImportPolicy("local-app"),
  });
  let loaded = false;
  const result = await captureDynamicHtml(req, "http://localhost:3000", {
    resolveHost: async () => ["8.8.8.8"],
    loadPlaywright: async () => { loaded = true; throw new Error("must not load"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(loaded, false);
});

test("Docling local adapter is offline, bounded, deterministic, and proposal-only", async () => {
  await withTemp(async (dir) => {
    const inputRoot = join(dir, "inputs");
    const workRoot = join(dir, "work");
    await mkdir(inputRoot);
    const file = join(inputRoot, "report.pdf");
    await writeFile(file, "fake pdf bytes");
    const policy = defaultImportPolicy("offline");
    const outputDoc = {
      schema_name: "DoclingDocument",
      version: "1.0.0",
      body: { self_ref: "#/body" },
      pages: { "1": {} },
      texts: [{ text: "Alpha" }, { text: "Beta" }],
    };
    const result = await runLocalDocling(policy, { path: file, format: "pdf" }, {
      jobId: "docling-ok",
      workRoot,
      authorizedRoots: [inputRoot],
    }, {
      execute: async (command, args, options) => {
        assert.equal(command, "docling");
        assert.equal(args.includes("--no-enable-remote-services"), true);
        assert.equal(args.includes("--no-allow-external-plugins"), true);
        assert.equal(options.env.HF_HUB_OFFLINE, "1");
        const out = args[args.indexOf("--output-file") + 1];
        await writeFile(out, JSON.stringify(outputDoc));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result.status, "ok");
    const proposal = proposalFromDoclingOutput(request({
      source: { kind: "document", repositoryId: "repo-1", repositoryPath: "report.pdf" },
      policy,
    }), result.value);
    assert.equal(proposal.rootIds.length, 1);
    assert.equal(Object.values(proposal.nodes).filter((node) => node.kind === "text").length, 2);
  });
});

test("Docling returns typed unavailable and never auto-installs", async () => {
  await withTemp(async (dir) => {
    const inputRoot = join(dir, "inputs");
    await mkdir(inputRoot);
    const file = join(inputRoot, "report.pdf");
    await writeFile(file, "fake");
    const unavailable = Object.assign(new Error("spawn docling ENOENT"), { code: "ENOENT" });
    const result = await runLocalDocling(defaultImportPolicy("offline"), { path: file, format: "pdf" }, {
      jobId: "docling-missing",
      workRoot: join(dir, "work"),
      authorizedRoots: [inputRoot],
    }, { execute: async () => { throw unavailable; } });
    assert.equal(result.status, "unavailable");
  });
});

test("Docling rejects files outside authorized roots", async () => {
  await withTemp(async (dir) => {
    const root = join(dir, "root");
    await mkdir(root);
    const outside = join(dir, "outside.pdf");
    await writeFile(outside, "fake");
    const result = await runLocalDocling(defaultImportPolicy("offline"), { path: outside, format: "pdf" }, {
      jobId: "escape",
      workRoot: join(dir, "work"),
      authorizedRoots: [root],
    }, { execute: async () => { throw new Error("must not execute"); } });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /escapes authorized roots/u);
  });
});

test("Docling output page count is bounded", async () => {
  await withTemp(async (dir) => {
    const inputRoot = join(dir, "inputs");
    await mkdir(inputRoot);
    const file = join(inputRoot, "report.pdf");
    await writeFile(file, "fake");
    const policy = { ...defaultImportPolicy("offline"), maxDocumentPages: 1 };
    const result = await runLocalDocling(policy, { path: file, format: "pdf" }, {
      jobId: "page-bound",
      workRoot: join(dir, "work"),
      authorizedRoots: [inputRoot],
    }, {
      execute: async (_command, args) => {
        const out = args[args.indexOf("--output-file") + 1];
        await writeFile(out, JSON.stringify({
          schema_name: "DoclingDocument",
          version: "1",
          body: {},
          texts: [{ text: "x" }],
          pages: { "1": {}, "2": {} },
        }));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /maxDocumentPages/u);
  });
});

test("import job cleanup refuses paths outside configured work root", async () => {
  await withTemp(async (dir) => {
    const root = join(dir, "root");
    const outside = join(dir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await assert.rejects(() => safeRemoveImportJobDirectory(root, outside), ImportSecurityError);
    const info = await (await import("node:fs/promises")).stat(outside);
    assert.equal(info.isDirectory(), true);
  });
});

test("authorized local source instrumentation returns repository-relative provenance without absolute leakage", async () => {
  await withTemp(async (dir) => {
    const repoRoot = join(dir, "repo");
    const sourceDir = join(repoRoot, "src");
    await mkdir(sourceDir, { recursive: true });
    const file = join(sourceDir, "index.html");
    await writeFile(file, "<main>Hello</main>");
    const result = await readAuthorizedLocalSource(request({
      source: { kind: "local-app", repositoryId: "repo-1", repositoryPath: "src/index.html" },
      policy: defaultImportPolicy("local-app"),
    }), { repositoryId: "repo-1", repositoryRoot: repoRoot, path: file });
    assert.equal(result.status, "ok");
    assert.equal(result.value.path, "src/index.html");
    assert.equal(result.value.sourceBinding.path, "src/index.html");
    assert.equal(canonicalImportStringify(result.value).includes(dir), false);
  });
});

test("static mirror captures bounded same-origin resources, no-parent pages, and rewrites captured assets", async () => {
  await withTemp(async (dir) => {
    const policy = { ...defaultImportPolicy("remote"), maxMirrorDepth: 1 };
    const req = request({
      source: { kind: "remote-url", uri: "https://example.com/docs/page.html", baseUrl: "https://example.com/docs/page.html" },
      policy,
    });
    const calls = [];
    const bodies = new Map([
      ["https://example.com/docs/page.html", { type: "text/html", body: '<link rel="stylesheet" href="/styles.css"><img src="/hero.png"><a href="/docs/next.html">next</a><a href="/outside.html">outside</a>' }],
      ["https://example.com/docs/next.html", { type: "text/html", body: "<p>next</p>" }],
      ["https://example.com/styles.css", { type: "text/css", body: ".x { color: red; }" }],
      ["https://example.com/hero.png", { type: "image/png", body: "PNGDATA" }],
    ]);
    const result = await mirrorStaticSite(req, "https://example.com/docs/page.html", {
      jobId: "mirror-ok",
      workRoot: join(dir, "work"),
    }, {
      resolveHost: async () => ["93.184.216.34"],
      fetchResource: async (url) => {
        calls.push(url.href);
        const row = bodies.get(url.href);
        if (!row) throw new Error(`unexpected fetch ${url.href}`);
        return { status: 200, headers: { "content-type": row.type, "content-encoding": "identity" }, body: new TextEncoder().encode(row.body) };
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(calls.includes("https://example.com/outside.html"), false);
    assert.equal(calls.includes("https://example.com/docs/next.html"), true);
    assert.equal(calls.includes("https://example.com/styles.css"), true);
    const proposal = await proposalFromStaticMirror(req, result.value);
    assert.equal(proposal.assets.length, result.value.manifest.resources.length);
    assert.equal(Object.values(proposal.nodes).some((node) => Object.values(node.attributes).some((value) => value.startsWith("./objects/"))), true);
    validateImportProposal(proposal);
    assert.equal(proposal.stylesheets.some((style) => style.cssText.includes("color: red")), true);
    await disposeStaticMirror(join(dir, "work"), result.value);
  });
});

test("static mirror proposal re-verifies manifest paths and object hashes before promotion", async () => {
  await withTemp(async (dir) => {
    const req = request({
      source: { kind: "remote-url", uri: "https://example.com/docs/page.html" },
      policy: defaultImportPolicy("remote"),
    });
    const result = await mirrorStaticSite(req, "https://example.com/docs/page.html", {
      jobId: "mirror-verify",
      workRoot: join(dir, "work"),
    }, {
      resolveHost: async () => ["93.184.216.34"],
      fetchResource: async () => ({
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "identity" },
        body: new TextEncoder().encode("<p>trusted</p>"),
      }),
    });
    assert.equal(result.status, "ok");

    const forged = structuredClone(result.value);
    forged.manifest.entryLogicalPath = "../../outside";
    await assert.rejects(() => proposalFromStaticMirror(req, forged), /content-addressed mirror object path/u);

    const objectPath = join(result.value.jobDirectory, result.value.manifest.entryLogicalPath);
    await writeFile(objectPath, "<p>tampered</p>");
    await assert.rejects(() => proposalFromStaticMirror(req, result.value), /no longer match the captured manifest/u);
    await disposeStaticMirror(join(dir, "work"), result.value);
  });
});

test("static mirror rejects cross-origin redirects before following them", async () => {
  await withTemp(async (dir) => {
    const req = request({
      source: { kind: "remote-url", uri: "https://example.com/docs/page.html" },
      policy: defaultImportPolicy("remote"),
    });
    let fetches = 0;
    const result = await mirrorStaticSite(req, "https://example.com/docs/page.html", {
      jobId: "redirect",
      workRoot: join(dir, "work"),
    }, {
      resolveHost: async () => ["93.184.216.34"],
      fetchResource: async () => {
        fetches += 1;
        return { status: 302, headers: { location: "https://evil.test/x", "content-encoding": "identity" }, body: new Uint8Array() };
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(fetches, 1);
    assert.match(result.reason, /escaped same-origin scope/u);
  });
});

test("static mirror total-byte quota fails closed and cleans its job sandbox", async () => {
  await withTemp(async (dir) => {
    const work = join(dir, "work");
    const policy = { ...defaultImportPolicy("remote"), maxTotalBytes: 8, maxAssetBytes: 16 };
    const req = request({ source: { kind: "remote-url", uri: "https://example.com/a.html" }, policy });
    const result = await mirrorStaticSite(req, "https://example.com/a.html", {
      jobId: "quota",
      workRoot: work,
    }, {
      resolveHost: async () => ["93.184.216.34"],
      fetchResource: async () => ({
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "identity" },
        body: new TextEncoder().encode("0123456789"),
      }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /maxTotalBytes/u);
    const names = await (await import("node:fs/promises")).readdir(work);
    assert.deepEqual(names, []);
  });
});

test("static mirror cancellation is typed failure and leaves no successful artifact", async () => {
  await withTemp(async (dir) => {
    const controller = new AbortController();
    controller.abort();
    const req = request({ source: { kind: "remote-url", uri: "https://example.com/a.html" }, policy: defaultImportPolicy("remote") });
    const result = await mirrorStaticSite(req, "https://example.com/a.html", {
      jobId: "cancel",
      workRoot: join(dir, "work"),
      signal: controller.signal,
    }, { resolveHost: async () => ["93.184.216.34"], fetchResource: async () => { throw new Error("must not fetch"); } });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /cancelled/u);
  });
});

test("static mirror enforces wall-clock deadline after a slow fetch returns", async () => {
  await withTemp(async (dir) => {
    let now = 0;
    const policy = { ...defaultImportPolicy("remote"), maxWallClockMs: 5 };
    const req = request({ source: { kind: "remote-url", uri: "https://example.com/a.html" }, policy });
    const result = await mirrorStaticSite(req, "https://example.com/a.html", {
      jobId: "deadline",
      workRoot: join(dir, "work"),
    }, {
      now: () => now,
      resolveHost: async () => ["93.184.216.34"],
      fetchResource: async () => {
        now = 6;
        return { status: 200, headers: { "content-type": "text/html", "content-encoding": "identity" }, body: new TextEncoder().encode("<p>x</p>") };
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /maxWallClockMs/u);
  });
});

test("provenance pins permissive donors and keeps Firecrawl reference-only", () => {
  assert.equal(IMPORT_STACK_PROVENANCE.docling.revision, "0cd61e0050a9ef68e5e10495b87e41d31acd79c9");
  assert.equal(IMPORT_STACK_PROVENANCE.docling.license, "MIT");
  assert.equal(IMPORT_STACK_PROVENANCE.websiteDownloader.revision, "130ad63d7163c19df64322556ca9c260eef353be");
  assert.equal(IMPORT_STACK_PROVENANCE.firecrawl.revision, "4244638a7041bae8b99bdd42e3c44520f9e62da1");
  assert.equal(IMPORT_STACK_PROVENANCE.firecrawl.license, "AGPL-3.0");
  assert.equal(IMPORT_STACK_PROVENANCE.firecrawl.importedCode, false);
});
