import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const AT = "2026-10-06T12:00:00.000Z";
const DNS_METHODS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];

/**
 * Replace every Node entry point that can reach the network (TCP, TLS, HTTP/1, HTTP/2, UDP,
 * DNS including Resolver instances, fetch) and every way to spawn a helper process with a
 * recorder that throws. Returns the attempts and a restore function.
 */
function trapNetwork() {
  const attempts = [];
  const restores = [];
  const trap = (object, key, label) => {
    if (typeof object[key] !== "function") return;
    const original = object[key];
    object[key] = function trapped() {
      attempts.push(label);
      throw new Error(`network access attempted: ${label}`);
    };
    restores.push(() => { object[key] = original; });
  };
  const net = require("node:net");
  for (const key of ["connect", "createConnection"]) trap(net, key, `net.${key}`);
  trap(net.Socket.prototype, "connect", "net.Socket#connect");
  trap(require("node:tls"), "connect", "tls.connect");
  for (const name of ["node:http", "node:https"]) {
    for (const key of ["request", "get"]) trap(require(name), key, `${name}.${key}`);
  }
  trap(require("node:http2"), "connect", "http2.connect");
  trap(require("node:dgram"), "createSocket", "dgram.createSocket");
  const dns = require("node:dns");
  for (const key of DNS_METHODS) {
    trap(dns, key, `dns.${key}`);
    trap(dns.promises, key, `dns.promises.${key}`);
    trap(dns.Resolver.prototype, key, `dns.Resolver#${key}`);
    trap(dns.promises.Resolver.prototype, key, `dns.promises.Resolver#${key}`);
  }
  const childProcess = require("node:child_process");
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) trap(childProcess, key, `child_process.${key}`);
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

test("the network trap really intercepts network and process primitives", async () => {
  const trapped = trapNetwork();
  try {
    await assert.rejects(fetch("https://example.com"), /network access attempted/);
    assert.throws(() => require("node:net").connect(80, "example.com"), /network access attempted/);
    assert.throws(() => require("node:dns").lookup("example.com", () => {}), /network access attempted/);
    assert.throws(() => new (require("node:dns").Resolver)().resolveTxt("example.com", () => {}), /network access attempted/);
    assert.throws(() => require("node:dgram").createSocket("udp4"), /network access attempted/);
    assert.throws(() => require("node:http2").connect("https://example.com"), /network access attempted/);
    assert.throws(() => require("node:child_process").spawn("curl", ["https://example.com"]), /network access attempted/);
    assert.deepEqual(trapped.attempts, ["fetch", "net.connect", "dns.lookup", "dns.Resolver#resolveTxt", "dgram.createSocket", "http2.connect", "child_process.spawn"]);
  } finally {
    trapped.restore();
  }
});

test("the core workflow completes with all network access disabled and makes zero network attempts", async () => {
  const trapped = trapNetwork();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-offline-")));
  try {
    // Every workflow module is loaded only after the trap, so none can hold a pre-trap reference.
    const { createDocument } = await import("../packages/document-model/src/index.mjs");
    const { createHistoryState, commitTransaction, undo, redo } = await import("../packages/history/src/index.mjs");
    const { LocalCollaborationRoom, createCollaborationState } = await import("../packages/collaboration/src/index.ts");
    const { createProject, openProject } = await import("../packages/persistence/src/index.ts");
    const { assureCandidates } = await import("../packages/decision-assurance/src/index.ts");
    const { NINERR_MOBILE_METHOD_PACK, evaluateSnapshot } = await import("../packages/design-method/src/index.ts");
    const { IMPORT_SCHEMA_VERSION, defaultImportPolicy, importHtmlSnapshot } = await import("../packages/import-stack/src/index.ts");
    const { CORE_FEATURES, defaultNetworkPolicy, evaluateOfflineReadiness, evaluateUrl } = await import("../packages/network-policy/src/index.ts");
    const { commitIntake, reviewImport } = await import("../packages/intake/src/index.ts");
    const exercised = new Set();

    // Policy: the default is offline and denies everything; every required feature is declared offline-capable.
    assert.equal(evaluateUrl(defaultNetworkPolicy(), { capability: "provider.inference", url: "https://example.com" }).allowed, false);
    assert.equal(evaluateOfflineReadiness({ schemaVersion: 1, providers: [] }, defaultNetworkPolicy()).ready, true);

    // document.edit + project.save-reopen: create, commit, checkpoint, commit, close, reopen.
    createProject(root, { projectId: "offline-proj", document: createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame", props: { title: "Draft" } }] }), createdAt: AT });
    const store = openProject(root, { owner: "offline-user", at: AT });
    store.commit({ id: "tx-1", actor: "offline-user", baseRevision: 0, operations: [{ type: "set-props", nodeId: "node-1", set: { title: "Edited offline" } }] });
    exercised.add("document.edit");
    store.checkpoint();

    // history.undo-redo: edit, undo, redo through history; persist the transaction of the redone entry.
    const editing = commitTransaction(createHistoryState(store.document), { id: "tx-2", actor: "offline-user", baseRevision: 1, operations: [{ type: "set-props", nodeId: "node-1", set: { width: 320 } }] });
    const undone = undo(editing);
    assert.equal(undone.document.nodes["node-1"].props.width, undefined);
    const redone = redo(undone);
    assert.equal(redone.document.nodes["node-1"].props.width, 320);
    store.commit(redone.past.at(-1).transaction);
    assert.deepEqual(store.document.nodes["node-1"].props, redone.document.nodes["node-1"].props);
    exercised.add("history.undo-redo");

    // collaboration.agent-edit: an agent actor (owned by the user) edits through the collaboration
    // authority; the room's own attributed transaction is what gets persisted.
    const owner = { actorId: "offline-user", kind: "user", accessClass: "member", displayName: "Owner" };
    const agent = { actorId: "agent-offline", kind: "agent", accessClass: "service", displayName: "Offline agent", ownerActorId: owner.actorId, operationId: "op-offline", workerTaskId: "task-offline" };
    const room = new LocalCollaborationRoom(createCollaborationState("doc-1", [
      { principalKind: "actor", principalId: owner.actorId, capabilities: ["read", "presence", "document-write", "comments", "admin"] },
      { principalKind: "actor", principalId: agent.actorId, capabilities: ["read", "document-write"] },
    ]));
    const agentEdit = room.commitTransaction({
      actor: agent, transport: "agent", history: createHistoryState(store.document), at: AT,
      operationId: "op-offline", workerTaskId: "task-offline",
      transaction: { id: "tx-agent", baseRevision: 2, intent: "Agent retitles", operations: [{ type: "set-props", nodeId: "node-1", set: { title: "Agent edit" } }] },
    });
    const attributed = agentEdit.history.past.at(-1).transaction;
    assert.equal(attributed.actor, agent.actorId);
    assert.equal(attributed.metadata.collaboration.actorKind, "agent");
    assert.equal(attributed.metadata.collaboration.ownerActorId, owner.actorId);
    assert.equal(agentEdit.summary.operationId, "op-offline");
    store.commit(attributed);
    assert.deepEqual(store.document.nodes, agentEdit.history.document.nodes);
    exercised.add("collaboration.agent-edit");
    store.close();
    const reopened = openProject(root, { owner: "offline-user", at: AT });
    assert.equal(reopened.revision, 3);
    assert.equal(reopened.document.nodes["node-1"].props.title, "Agent edit");
    assert.equal(reopened.document.nodes["node-1"].props.width, 320);
    reopened.close();
    exercised.add("project.save-reopen");

    // design.method-review and decision.assurance with no adapter.
    const button = (id, size) => ({ id, kind: "button", x: 16, y: 760, width: size, height: size === 20 ? 20 : 48, label: "Pay", interactive: true });
    assert.ok(Array.isArray(evaluateSnapshot(screen("s1", [button("a-pay", 356)]), NINERR_MOBILE_METHOD_PACK)));
    exercised.add("design.method-review");
    const record = await assureCandidates({
      schemaVersion: 1, decisionId: "offline-choice", actorId: "offline-user", intent: "Pick a layout", at: AT,
      candidates: [
        { candidateId: "a", rationale: "Primary", snapshot: screen("snap-a", [button("a-pay", 356)]) },
        { candidateId: "b", rationale: "Small target", snapshot: screen("snap-b", [button("b-pay", 20)]) },
      ],
      rulePacks: [NINERR_MOBILE_METHOD_PACK],
    });
    assert.deepEqual(record.outcome, { kind: "selected", candidateId: "a" });
    exercised.add("decision.assurance");

    // import.offline-html
    const proposal = importHtmlSnapshot({
      schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "offline-import", actorId: "offline-user", intent: "Import a saved page", at: AT,
      source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
      policy: defaultImportPolicy("offline"),
    }, "<main><h1>Offline</h1><img src=\"https://cdn.example.com/a.png\"></main>");
    assert.ok(proposal);
    assert.equal(reviewImport(proposal).commitReady, true);
    const importStore = openProject(root, { owner: "offline-user", at: AT });
    const committed = commitIntake(importStore, proposal, { transactionId: "tx-import", at: AT });
    assert.equal(committed.revision, 4);
    importStore.close();
    const afterImport = openProject(root, { owner: "offline-user", at: AT });
    assert.equal(afterImport.revision, 4);
    assert.ok(Object.values(afterImport.document.nodes).some((node) => node.props?.semantics?.role === "main"));
    afterImport.close();
    exercised.add("import.offline-html");

    // Every required core feature was exercised here, and nothing touched the network.
    assert.deepEqual([...exercised].sort(), CORE_FEATURES.filter((feature) => feature.required).map((feature) => feature.feature).sort());
    assert.deepEqual(trapped.attempts, [], `network attempts: ${trapped.attempts.join(", ")}`);
  } finally {
    trapped.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
