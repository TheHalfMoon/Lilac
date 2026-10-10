#!/usr/bin/env node
// Reproducible release smoke test (P07, #139). From a clean checkout with `npm ci`, run
// `npm run smoke`: it drives Ninerr's offline core workflow end to end in a temporary
// directory, with every network and process-spawning primitive trapped, and prints a JSON
// report whose digests depend only on the inputs below. Two runs on any machine must print
// identical reports, equal to tests/fixtures/smoke/expected-report.json; tests/smoke.test.mjs
// checks that, so CI on a fresh runner proves the report reproduces across machines. Exit status is non-zero on any failure.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const AT = "2026-10-07T12:00:00.000Z";
const REPORT_SCHEMA = 1;
const DNS_METHODS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];

function trapNetwork() {
  const attempts = [];
  const trap = (object, key, label) => {
    if (typeof object?.[key] !== "function") return;
    object[key] = () => {
      attempts.push(label);
      throw new Error(`network access attempted: ${label}`);
    };
  };
  const net = require("node:net");
  for (const key of ["connect", "createConnection"]) trap(net, key, `net.${key}`);
  trap(net.Socket.prototype, "connect", "net.Socket#connect");
  trap(require("node:tls"), "connect", "tls.connect");
  for (const name of ["node:http", "node:https"]) for (const key of ["request", "get"]) trap(require(name), key, `${name}.${key}`);
  trap(require("node:http2"), "connect", "http2.connect");
  trap(require("node:dgram"), "createSocket", "dgram.createSocket");
  // The same DNS surface tests/offline-guarantee.test.mjs traps, including Resolver instances.
  const dns = require("node:dns");
  for (const key of DNS_METHODS) {
    trap(dns, key, `dns.${key}`);
    trap(dns.promises, key, `dns.promises.${key}`);
    trap(dns.Resolver.prototype, key, `dns.Resolver#${key}`);
    trap(dns.promises.Resolver.prototype, key, `dns.promises.Resolver#${key}`);
  }
  const childProcess = require("node:child_process");
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) trap(childProcess, key, `child_process.${key}`);
  globalThis.fetch = async () => {
    attempts.push("fetch");
    throw new Error("network access attempted: fetch");
  };
  for (const name of ["WebSocket", "EventSource"]) {
    if (typeof globalThis[name] !== "function") continue;
    globalThis[name] = function trapped() {
      attempts.push(name);
      throw new Error(`network access attempted: ${name}`);
    };
  }
  syncBuiltinESMExports();
  return attempts;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** sha256 of every file under `root`, keyed by relative path in code-unit order. */
function treeDigests(root) {
  const out = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path).split("\\").join("/")] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return out;
}

function check(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
}

async function main() {
  const attempts = trapNetwork();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-smoke-")));
  const steps = [];
  try {
    // Modules load only after the trap, so none holds a pre-trap reference.
    const { createDocument, serializeDocument } = await import("../packages/document-model/src/index.mjs");
    const { createHistoryState, commitTransaction, undo, redo } = await import("../packages/history/src/index.mjs");
    const { LocalCollaborationRoom, createCollaborationState } = await import("../packages/collaboration/src/index.ts");
    const { PROJECT_FILES, createProject, openProject } = await import("../packages/persistence/src/index.ts");
    const { IMPORT_SCHEMA_VERSION, defaultImportPolicy, importHtmlSnapshot } = await import("../packages/import-stack/src/index.ts");
    const { commitIntake, reviewImport } = await import("../packages/intake/src/index.ts");
    const { buildCodeIr, codeToDesign, designToCode, roundTripFingerprint } = await import("../packages/code-ir/src/index.ts");

    // 1. Create a project and edit it.
    createProject(root, { projectId: "smoke", document: createDocument({ id: "doc-smoke", nodes: [{ id: "frame-1", type: "frame", props: { title: "Draft" } }] }), createdAt: AT });
    const store = openProject(root, { owner: "smoke-user", at: AT });
    store.commit({ id: "tx-1", actor: "smoke-user", baseRevision: 0, operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "Edited" } }] });
    check(store.document.nodes["frame-1"].props.title === "Edited", "the edit applied");
    store.checkpoint();
    steps.push("create-edit");

    // 2. Undo and redo through history, then persist the redone transaction.
    const editing = commitTransaction(createHistoryState(store.document), { id: "tx-2", actor: "smoke-user", baseRevision: 1, operations: [{ type: "set-props", nodeId: "frame-1", set: { width: 320 } }] });
    const undone = undo(editing);
    check(undone.document.nodes["frame-1"].props.width === undefined, "undo removes the edit");
    const redone = redo(undone);
    check(redone.document.nodes["frame-1"].props.width === 320, "redo restores the edit");
    store.commit(redone.past.at(-1).transaction);
    steps.push("undo-redo");

    // 3. An agent edits through the collaboration authority, attributed to its owner.
    const owner = { actorId: "smoke-user", kind: "user", accessClass: "member", displayName: "Owner" };
    const agent = { actorId: "agent-smoke", kind: "agent", accessClass: "service", displayName: "Smoke agent", ownerActorId: owner.actorId, operationId: "op-smoke", workerTaskId: "task-smoke" };
    const room = new LocalCollaborationRoom(createCollaborationState("doc-smoke", [
      { principalKind: "actor", principalId: owner.actorId, capabilities: ["read", "presence", "document-write", "comments", "admin"] },
      { principalKind: "actor", principalId: agent.actorId, capabilities: ["read", "document-write"] },
    ]));
    const agentEdit = room.commitTransaction({
      actor: agent, transport: "agent", history: createHistoryState(store.document), at: AT, operationId: "op-smoke", workerTaskId: "task-smoke",
      transaction: { id: "tx-agent", baseRevision: 2, intent: "Agent retitles", operations: [{ type: "set-props", nodeId: "frame-1", set: { title: "Agent edit" } }] },
    });
    const attributed = agentEdit.history.past.at(-1).transaction;
    check(attributed.metadata.collaboration.ownerActorId === owner.actorId, "agent edit is attributed to its owner");
    store.commit(attributed);
    store.close();
    steps.push("agent-edit");

    // 4. Import a saved page offline through intake into the project.
    const proposal = importHtmlSnapshot({
      schemaVersion: IMPORT_SCHEMA_VERSION, requestId: "smoke-import", actorId: "smoke-user", intent: "Import a saved page", at: AT,
      source: { kind: "html-snapshot", uri: "https://example.com/page", baseUrl: "https://example.com/page" },
      policy: defaultImportPolicy("offline"),
    }, "<main><h1>Pricing</h1><img src=\"https://cdn.example.com/a.png\" alt=\"Plan chart\"><script>alert(1)</script></main>");
    check(reviewImport(proposal).commitReady, "import review is commit-ready");
    const importStore = openProject(root, { owner: "smoke-user", at: AT });
    commitIntake(importStore, proposal, { transactionId: "tx-import", at: AT });
    importStore.close();
    steps.push("import");

    // 5. Reopen and verify the durable state.
    const reopened = openProject(root, { owner: "smoke-user", at: AT });
    check(reopened.revision === 4, `reopened at revision ${reopened.revision}`);
    check(reopened.document.nodes["frame-1"].props.title === "Agent edit", "agent edit survived reopen");
    check(reopened.document.nodes["frame-1"].props.width === 320, "redone edit survived reopen");
    const nodes = Object.values(reopened.document.nodes);
    check(!JSON.stringify(reopened.document).includes("alert(1)"), "imported script text was removed");
    check(!nodes.some((node) => String(node.props?.tag ?? "").toLowerCase() === "script"), "no script element was imported");
    check(nodes.some((node) => node.props?.text === "Pricing"), "the imported heading text landed");
    check(nodes.some((node) => node.props?.tag === "img" && node.props?.attributes?.alt === "Plan chart"), "the imported image kept its alt text");
    check(nodes.some((node) => node.props?.semantics?.role === "main"), "intake recorded the main landmark");
    const documentDigest = sha256(serializeDocument(reopened.document));
    reopened.close();
    const journal = readFileSync(join(root, PROJECT_FILES.directory, PROJECT_FILES.journal), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.segment === undefined).map((line) => line.entry.transaction);
    check(journal.some((tx) => tx.id === "tx-agent" && tx.actor === agent.actorId && tx.metadata.collaboration.ownerActorId === owner.actorId), "the agent edit is durably attributed to its owner");
    steps.push("reopen");

    // 6. Code round trip: JSX to design and back is stable.
    const source = "export function Card() {\n  return (\n    <section className=\"card\">\n      <h2>Plans</h2>\n      <button disabled={false}>Choose</button>\n    </section>\n  );\n}\n";
    const ir = buildCodeIr([{ path: "Card.jsx", content: source }]);
    const design = codeToDesign(ir, ir.rootIds[0], "Card");
    const emitted = designToCode(design);
    const again = buildCodeIr([{ path: "Card.jsx", content: emitted }]);
    check(roundTripFingerprint(codeToDesign(again, again.rootIds[0], "Card")) === roundTripFingerprint(design), "code round trip is stable");
    steps.push("code-round-trip");

    check(attempts.length === 0, `network attempts: ${attempts.join(", ")}`);
    return {
      schema: REPORT_SCHEMA,
      steps,
      networkAttempts: attempts.length,
      documentSha256: documentDigest,
      emittedJsxSha256: sha256(emitted),
      projectFiles: treeDigests(join(root, PROJECT_FILES.directory)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --expect <file>: also require the report to equal a committed expected report. A relative
// path is taken from the repository root, so the command works from any directory.
const expectAt = process.argv.indexOf("--expect");
const expectPath = expectAt < 0 ? null : process.argv[expectAt + 1];
if (expectAt >= 0 && (expectPath === undefined || expectPath.startsWith("--"))) {
  process.stderr.write("smoke: --expect needs a file path\n");
  process.exit(2);
}
const expectFile = expectPath === null ? null : isAbsolute(expectPath) ? expectPath : fileURLToPath(new URL(`../${expectPath}`, import.meta.url));
main().then(
  (report) => {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(text);
    if (expectFile !== null && readFileSync(expectFile, "utf8") !== text) {
      process.stderr.write(`smoke report differs from ${expectFile}\n`);
      process.exitCode = 1;
    }
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
