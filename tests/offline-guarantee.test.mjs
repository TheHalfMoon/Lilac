import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocument } from "../packages/document-model/src/index.mjs";
import { createProject, openProject } from "../packages/persistence/src/index.ts";
import { assureCandidates } from "../packages/decision-assurance/src/index.ts";
import { LILAC_MOBILE_METHOD_PACK, evaluateSnapshot } from "../packages/design-method/src/index.ts";
import { IMPORT_SCHEMA_VERSION, defaultImportPolicy, importHtmlSnapshot } from "../packages/import-stack/src/index.ts";
import { defaultNetworkPolicy, evaluateOfflineReadiness, evaluateUrl } from "../packages/network-policy/src/index.ts";

const require = createRequire(import.meta.url);
const AT = "2026-10-06T12:00:00.000Z";

/** Replace every Node network entry point with a recorder that throws; returns attempts and a restore function. */
function trapNetwork() {
  const attempts = [];
  const restores = [];
  const trap = (object, key, label) => {
    const original = object[key];
    object[key] = (...args) => {
      attempts.push(label);
      throw new Error(`network access attempted: ${label}`);
    };
    restores.push(() => { object[key] = original; });
  };
  const net = require("node:net");
  const tls = require("node:tls");
  const http = require("node:http");
  const https = require("node:https");
  const dns = require("node:dns");
  for (const key of ["connect", "createConnection"]) trap(net, key, `net.${key}`);
  trap(net.Socket.prototype, "connect", "net.Socket#connect");
  trap(tls, "connect", "tls.connect");
  for (const key of ["request", "get"]) {
    trap(http, key, `http.${key}`);
    trap(https, key, `https.${key}`);
  }
  for (const key of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) trap(dns, key, `dns.${key}`);
  for (const key of ["lookup", "resolve", "resolve4", "resolve6"]) trap(dns.promises, key, `dns.promises.${key}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts.push("fetch");
    throw new Error("network access attempted: fetch");
  };
  restores.push(() => { globalThis.fetch = originalFetch; });
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const restore of restores.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}

function screen(id, nodes) {
  return { schemaVersion: 1, snapshotId: id, nodes: [{ id: `${id}-screen`, kind: "screen", x: 0, y: 0, width: 390, height: 844 }, ...nodes] };
}

test("the network trap really intercepts network primitives", async () => {
  const trapped = trapNetwork();
  try {
    await assert.rejects(fetch("https://example.com"), /network access attempted/);
    assert.throws(() => require("node:net").connect(80, "example.com"), /network access attempted/);
    assert.throws(() => require("node:dns").lookup("example.com", () => {}), /network access attempted/);
    assert.deepEqual(trapped.attempts, ["fetch", "net.connect", "dns.lookup"]);
  } finally {
    trapped.restore();
  }
});

test("the core workflow completes with all network access disabled and makes zero network attempts", async () => {
  const trapped = trapNetwork();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilac-offline-")));
  try {
    // Policy: the default is offline and denies everything.
    assert.equal(evaluateUrl(defaultNetworkPolicy(), { capability: "provider.inference", url: "https://example.com" }).allowed, false);
    assert.equal(evaluateOfflineReadiness({ schemaVersion: 1, providers: [] }, defaultNetworkPolicy()).ready, true);

    // Create, edit, checkpoint, save, close, reopen.
    createProject(root, { projectId: "offline-proj", document: createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame", props: { title: "Draft" } }] }), createdAt: AT });
    const store = openProject(root, { owner: "offline-user", at: AT });
    store.commit({ id: "tx-1", actor: "offline-user", baseRevision: 0, operations: [{ type: "set-props", nodeId: "node-1", set: { title: "Edited offline" } }] });
    store.checkpoint();
    store.commit({ id: "tx-2", actor: "offline-user", baseRevision: 1, operations: [{ type: "set-props", nodeId: "node-1", set: { width: 320 } }] });
    store.close();
    const reopened = openProject(root, { owner: "offline-user", at: AT });
    assert.equal(reopened.revision, 2);
    assert.equal(reopened.document.nodes["node-1"].props.title, "Edited offline");
    reopened.close();

    // Design method review and decision assurance with no adapter.
    const candidateNodes = (prefix) => [{ id: `${prefix}-pay`, kind: "button", x: 16, y: 760, width: 356, height: 48, label: "Pay", interactive: true }];
    assert.ok(Array.isArray(evaluateSnapshot(screen("s1", candidateNodes("a")), LILAC_MOBILE_METHOD_PACK)));
    const record = await assureCandidates({
      schemaVersion: 1, decisionId: "offline-choice", actorId: "offline-user", intent: "Pick a layout", at: AT,
      candidates: [
        { candidateId: "a", rationale: "Primary", snapshot: screen("snap-a", candidateNodes("a")) },
        { candidateId: "b", rationale: "Small target", snapshot: screen("snap-b", [{ id: "b-pay", kind: "button", x: 16, y: 760, width: 20, height: 20, label: "Pay", interactive: true }]) },
      ],
      rulePacks: [LILAC_MOBILE_METHOD_PACK],
    });
    assert.deepEqual(record.outcome, { kind: "selected", candidateId: "a" });

    // Import in offline mode.
    const proposal = importHtmlSnapshot({
      schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "offline-import", actorId: "offline-user", intent: "Import a saved page", at: AT,
      source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
      policy: defaultImportPolicy("offline"),
    }, "<main><h1>Offline</h1><img src=\"https://cdn.example.com/a.png\"></main>");
    assert.ok(proposal);

    assert.deepEqual(trapped.attempts, [], `network attempts: ${trapped.attempts.join(", ")}`);
  } finally {
    trapped.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
