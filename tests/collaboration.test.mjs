import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDocument } from "../packages/document-model/src/index.mjs";
import { createHistoryState } from "../packages/history/src/index.mjs";
import {
  COLLABORATION_PROVENANCE,
  CollaborationAuthorizationError,
  CollaborationCommentError,
  CollaborationNotFoundError,
  CollaborationProtocolError,
  CollaborationValidationError,
  LocalCollaborationFileStore,
  LocalCollaborationRoom,
  LocalCollaborationServer,
  applyRemoteFact,
  connectionSignal,
  createCollaborationLog,
  createCollaborationState,
  deriveActivity,
  evaluateAccess,
  followViewport,
  getCommentThread,
  locateAgent,
  replayComments,
  replayTransactionSummaries,
  serializePersistentState,
} from "../packages/collaboration/src/index.ts";

const T0 = "2026-10-05T13:00:00.000Z";
const T1 = "2026-10-05T13:00:01.000Z";
const T2 = "2026-10-05T13:00:02.000Z";
const T3 = "2026-10-05T13:00:03.000Z";
const T4 = "2026-10-05T13:00:04.000Z";

const owner = { actorId: "user-owner", kind: "user", accessClass: "member", displayName: "Owner" };
const member = { actorId: "user-member", kind: "user", accessClass: "member", displayName: "Member" };
const outsider = { actorId: "user-outsider", kind: "user", accessClass: "guest", displayName: "Outsider" };
const agent = { actorId: "agent-a", kind: "agent", accessClass: "service", displayName: "Agent A", ownerActorId: owner.actorId, operationId: "op-1", workerTaskId: "task-1" };

function ownerGrant() {
  return { principalKind: "actor", principalId: owner.actorId, capabilities: ["read", "presence", "document-write", "comments", "admin", "durable-secret"] };
}

function memberGrant(capabilities = ["read", "presence", "document-write", "comments"]) {
  return { principalKind: "actor", principalId: member.actorId, capabilities };
}

function room(grants = [ownerGrant(), memberGrant()]) {
  return new LocalCollaborationRoom(createCollaborationState("doc-1", grants));
}

test("pins Paper evidence and Doop as AGPL reference-only with zero imported code", () => {
  assert.equal(COLLABORATION_PROVENANCE.doop.repository, "kgoedecke/doop");
  assert.equal(COLLABORATION_PROVENANCE.doop.revision, "d99c8b157d5afd4192b356f89a2b19adc28c75a5");
  assert.equal(COLLABORATION_PROVENANCE.doop.license, "AGPL-3.0-only");
  assert.equal(COLLABORATION_PROVENANCE.doop.posture, "reference-only");
  assert.equal(COLLABORATION_PROVENANCE.doop.importedCode, false);
  assert.ok(COLLABORATION_PROVENANCE.paperEvidence.length >= 2);
});

test("one authorization oracle gives the same answer across HTTP, realtime, MCP, and agent transports", () => {
  const state = createCollaborationState("doc-1", [ownerGrant(), memberGrant(["read"])]);
  for (const transport of ["http", "realtime", "mcp", "agent"]) {
    assert.equal(evaluateAccess(state.policy, { actor: member, capability: "read", transport, at: T0 }).outcome, "allowed");
    assert.equal(evaluateAccess(state.policy, { actor: outsider, capability: "read", transport, at: T0 }).outcome, "denied");
  }
});

test("link grants never authorize administrative or durable-secret capability", () => {
  assert.throws(
    () => createCollaborationState("doc-1", [{ principalKind: "link", principalId: "share-1", capabilities: ["read", "admin"] }]),
    /link grants cannot authorize/u,
  );
  assert.throws(
    () => createCollaborationState("doc-1", [{ principalKind: "link", principalId: "share-1", capabilities: ["read", "durable-secret"] }]),
    /link grants cannot authorize/u,
  );
});

test("authorization rejects unsupported transports and capabilities fail closed", () => {
  const state = createCollaborationState("doc-1", [ownerGrant()]);
  assert.throws(() => evaluateAccess(state.policy, { actor: owner, capability: "read", transport: "smtp", at: T0 }), CollaborationValidationError);
  assert.throws(() => evaluateAccess(state.policy, { actor: owner, capability: "root", transport: "http", at: T0 }), CollaborationValidationError);
});

test("join must happen before presence publication and finite viewport rules fail closed", () => {
  const r = room();
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "s1", generation: 1, update: { sequence: 1, at: T1, viewport: { x: 0, y: 0, zoom: 1, width: 100, height: 100 } } }),
    CollaborationProtocolError,
  );
  const joined = r.join({ actor: member, sessionId: "s1", at: T0 });
  const current = r.publishPresence({
    actorId: member.actorId,
    sessionId: "s1",
    generation: joined.presence.generation,
    update: { sequence: 1, at: T1, cursor: { x: 4, y: 8 }, viewport: { x: 1, y: 2, zoom: 2, width: 900, height: 600 }, activeNodeId: "node-1" },
  });
  assert.deepEqual(followViewport(current), { x: 1, y: 2, zoom: 2, width: 900, height: 600 });
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "s1", generation: joined.presence.generation, update: { sequence: 2, at: T2, viewport: { x: 0, y: 0, zoom: Infinity, width: 10, height: 10 } } }),
    /must be finite/u,
  );
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "s1", generation: joined.presence.generation, update: { sequence: 2, at: T2, viewport: { x: 0, y: 0, zoom: 1, width: 0, height: 10 } } }),
    /must be positive/u,
  );
});

test("reconnect supersedes the old session and stale socket cannot resume mutation", () => {
  const r = room();
  const first = r.join({ actor: member, sessionId: "s1", at: T0 });
  const second = r.reconnect({ actor: member, sessionId: "s2", at: T1, previousCursor: 0 });
  assert.ok(second.presence.generation > first.presence.generation);
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "s1", generation: first.presence.generation, update: { sequence: 1, at: T2, cursor: { x: 1, y: 1 } } }),
    /superseded/u,
  );
  assert.doesNotThrow(() => r.publishPresence({ actorId: member.actorId, sessionId: "s2", generation: second.presence.generation, update: { sequence: 1, at: T2, cursor: { x: 2, y: 2 } } }));
});

test("revocation terminates protected realtime access and deletion is terminal not-found", () => {
  const r = room();
  const joined = r.join({ actor: member, sessionId: "s1", at: T0 });
  r.updatePolicy({ actor: owner, transport: "http", at: T1, expectedRevision: 0, grants: [ownerGrant()] });
  assert.equal(r.getPresence(member.actorId), null);
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "s1", generation: joined.presence.generation, update: { sequence: 1, at: T2, cursor: { x: 1, y: 1 } } }),
    CollaborationProtocolError,
  );
  assert.throws(() => r.join({ actor: member, sessionId: "s2", at: T2 }), CollaborationAuthorizationError);
  r.updatePolicy({ actor: owner, transport: "http", at: T2, expectedRevision: 1, deleted: true });
  assert.throws(() => r.join({ actor: owner, sessionId: "owner", at: T3 }), CollaborationNotFoundError);
});

test("presence disconnect and human follow never mutate durable collaboration state", () => {
  const r = room();
  const before = serializePersistentState(r.exportState());
  const joined = r.join({ actor: member, sessionId: "s1", at: T0 });
  const updated = r.publishPresence({
    actorId: member.actorId,
    sessionId: "s1",
    generation: joined.presence.generation,
    update: { sequence: 1, at: T1, viewport: { x: 3, y: 4, zoom: 1.5, width: 1200, height: 800 } },
  });
  assert.deepEqual(followViewport(updated), updated.viewport);
  assert.equal(r.disconnect({ actorId: member.actorId, sessionId: "s1", generation: joined.presence.generation }), true);
  assert.equal(serializePersistentState(r.exportState()), before);
});

test("agent locate exposes canonical location metadata without durable mutation", () => {
  const r = new LocalCollaborationRoom(createCollaborationState("doc-1", [ownerGrant(), { principalKind: "actor", principalId: agent.actorId, capabilities: ["read", "presence"] }]));
  const joined = r.join({ actor: agent, sessionId: "agent-s", at: T0 });
  const before = serializePersistentState(r.exportState());
  const updated = r.publishPresence({ actorId: agent.actorId, sessionId: "agent-s", generation: joined.presence.generation, update: { sequence: 1, at: T1, activeNodeId: "node-7" } });
  assert.deepEqual(locateAgent(updated), { nodeId: "node-7", operationId: "op-1", workerTaskId: "task-1" });
  assert.equal(serializePersistentState(r.exportState()), before);
});

test("comment replies inherit the root anchor and reply-to-reply re-roots to one level", () => {
  const r = room();
  const root = r.createComment({
    id: "c-root", actor: member, transport: "http", at: T0, text: "Move this",
    anchor: { documentId: "doc-1", nodeId: "node-1", source: { path: "src/page.tsx", start: 10, end: 20 } },
    nodeExists: (nodeId) => nodeId === "node-1",
  });
  const first = r.replyComment({ id: "c-1", parentId: root.id, actor: owner, transport: "mcp", text: "Agreed", at: T1 });
  const second = r.replyComment({ id: "c-2", parentId: first.id, actor: member, transport: "agent", text: "Please do", at: T2 });
  assert.equal(first.parentId, root.id);
  assert.equal(second.parentId, root.id);
  assert.deepEqual(first.anchor, root.anchor);
  assert.deepEqual(second.anchor, root.anchor);
  assert.deepEqual(getCommentThread(r.exportState().log, second.id).map((comment) => comment.id), ["c-root", "c-1", "c-2"]);
});

test("child resolution leaves root open while root resolution closes children and blocks replies", () => {
  const r = room();
  r.createComment({ id: "c-root", actor: member, transport: "http", at: T0, text: "Fix", anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
  r.replyComment({ id: "c-child", parentId: "c-root", actor: owner, transport: "http", text: "Looking", at: T1 });
  r.resolveComment({ commentId: "c-child", actor: owner, transport: "http", at: T2 });
  let comments = replayComments(r.exportState().log);
  assert.equal(comments.find((comment) => comment.id === "c-root").resolvedAt, undefined);
  assert.equal(comments.find((comment) => comment.id === "c-child").resolvedAt, T2);
  r.replyComment({ id: "c-later", parentId: "c-root", actor: member, transport: "http", text: "Still open", at: T3 });
  r.resolveComment({ commentId: "c-root", actor: owner, transport: "http", at: T4 });
  comments = replayComments(r.exportState().log);
  assert.ok(comments.every((comment) => comment.resolvedAt === T4 || comment.id === "c-child"));
  assert.throws(() => r.replyComment({ id: "c-too-late", parentId: "c-root", actor: member, transport: "http", text: "Late", at: "2026-10-05T13:00:05.000Z" }), CollaborationCommentError);
});

test("read-only comment retrieval has no claim, resolve, or durable side effect", () => {
  const r = room();
  r.createComment({ id: "c-root", actor: member, transport: "http", at: T0, text: "Read me", anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
  const before = serializePersistentState(r.exportState());
  const thread = r.readCommentThread({ actor: member, transport: "mcp", commentId: "c-root", at: T1 });
  assert.equal(thread.length, 1);
  assert.equal(thread[0].resolvedAt, undefined);
  assert.equal(serializePersistentState(r.exportState()), before);
});

test("cross-document anchors and unproven node ids are rejected", () => {
  const r = room();
  assert.throws(
    () => r.createComment({ id: "c-foreign", actor: member, transport: "http", at: T0, text: "No", anchor: { documentId: "doc-2", nodeId: "node-1" }, nodeExists: () => true }),
    /another document/u,
  );
  assert.throws(
    () => r.createComment({ id: "c-node", actor: member, transport: "http", at: T0, text: "No", anchor: { documentId: "doc-1", nodeId: "foreign-node" }, nodeExists: () => false }),
    /not proven/u,
  );
});

test("plain comments create no agent work while explicit mention linkage carries operation, events, and transaction ids", () => {
  const r = room();
  r.createComment({ id: "c-agent", actor: member, transport: "http", at: T0, text: "@agent please fix", anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
  assert.equal(r.exportState().log.facts.filter((fact) => fact.kind === "agent-work-linked").length, 0);
  r.linkAgentWork({
    linkId: "link-1", commentId: "c-agent", requester: member, transport: "agent", targetAgentId: agent.actorId,
    operationId: "op-99", eventIds: ["event-1", "event-2"], transactionIds: [], workerTaskId: "task-99", at: T1,
    proof: { operationExists: (id) => id === "op-99", eventExists: (id) => ["event-1", "event-2"].includes(id), workerTaskExists: (id) => id === "task-99" },
  });
  const fact = r.exportState().log.facts.find((entry) => entry.kind === "agent-work-linked");
  assert.equal(fact.data.commentId, "c-agent");
  assert.equal(fact.data.operationId, "op-99");
  assert.deepEqual(fact.data.eventIds, ["event-1", "event-2"]);
  assert.deepEqual(fact.data.transactionIds, []);
  assert.equal(deriveActivity(r.exportState().log).some((item) => item.kind === "agent-work" && item.operationId === "op-99"), true);
});

test("all document-affecting collaboration writes commit through Ninerr history with exact attribution", () => {
  const r = room();
  const document = createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame", props: { title: "Before" } }] });
  const history = createHistoryState(document);
  const result = r.commitTransaction({
    actor: member,
    transport: "agent",
    history,
    at: T1,
    operationId: "op-write-1",
    workerTaskId: "task-write-1",
    sourceBindings: [{ repositoryId: "repo-1", path: "src/page.tsx", start: 1, end: 2 }],
    transaction: {
      id: "tx-1",
      baseRevision: 0,
      intent: "Update title",
      operations: [{ type: "set-props", nodeId: "node-1", set: { title: "After" } }],
    },
  });
  assert.equal(result.history.document.revision, 1);
  assert.equal(result.history.document.nodes["node-1"].props.title, "After");
  assert.equal(result.summary.transactionId, "tx-1");
  assert.equal(result.summary.operationId, "op-write-1");
  assert.deepEqual(result.summary.affectedNodeIds, ["node-1"]);
  assert.deepEqual(replayTransactionSummaries(r.exportState().log), [result.summary]);
  const activity = deriveActivity(r.exportState().log).find((item) => item.transactionId === "tx-1");
  assert.equal(activity.actor.actorId, member.actorId);
  assert.equal(activity.operationId, "op-write-1");
});

test("document write authorization fails before history mutation", () => {
  const r = room([ownerGrant(), memberGrant(["read", "presence", "comments"])]);
  const history = createHistoryState(createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame" }] }));
  assert.throws(
    () => r.commitTransaction({ actor: member, transport: "mcp", history, at: T1, transaction: { id: "tx-denied", baseRevision: 0, operations: [{ type: "set-props", nodeId: "node-1", set: { x: 1 } }] } }),
    CollaborationAuthorizationError,
  );
  assert.equal(history.document.revision, 0);
  assert.equal(r.exportState().log.facts.length, 0);
});

test("durable deltas reject duplicates and out-of-order sequences deterministically", () => {
  const empty = createCollaborationLog("doc-1");
  const fact1 = { version: 1, documentId: "doc-1", id: "fact-1", sequence: 1, kind: "access-changed", actor: { actorId: owner.actorId, kind: "user", accessClass: "member", displayName: owner.displayName }, at: T0, data: { policyRevision: 1 } };
  const fact2 = { ...fact1, id: "fact-2", sequence: 2, at: T1, data: { policyRevision: 2 } };
  assert.throws(() => applyRemoteFact(empty, fact2), /does not match expected 1/u);
  const one = applyRemoteFact(empty, fact1);
  assert.throws(() => applyRemoteFact(one, fact1), /duplicate durable fact id/u);
  assert.throws(() => applyRemoteFact(one, { ...fact2, sequence: 3 }), /does not match expected 2/u);
  const two = applyRemoteFact(one, fact2);
  assert.equal(two.nextSequence, 3);
});

test("ephemeral updates are bounded by a deterministic per-session rate window", () => {
  const r = room();
  const joined = r.join({ actor: member, sessionId: "rate-s", at: T0 });
  for (let sequence = 1; sequence <= 120; sequence += 1) {
    r.publishPresence({ actorId: member.actorId, sessionId: "rate-s", generation: joined.presence.generation, update: { sequence, at: T0, cursor: { x: sequence, y: sequence } } });
  }
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "rate-s", generation: joined.presence.generation, update: { sequence: 121, at: T0, cursor: { x: 121, y: 121 } } }),
    /rate limit/u,
  );
  assert.doesNotThrow(() => r.publishPresence({ actorId: member.actorId, sessionId: "rate-s", generation: joined.presence.generation, update: { sequence: 121, at: T1, cursor: { x: 121, y: 121 } } }));
});

test("connection outcomes distinguish not-found, auth expiry, revocation, and update-ready", () => {
  assert.deepEqual(connectionSignal({ documentExists: false, sessionValid: true, authorized: true, clientBuildId: "a", serverBuildId: "a" }), { kind: "not-found" });
  assert.deepEqual(connectionSignal({ documentExists: true, sessionValid: false, authorized: true, clientBuildId: "a", serverBuildId: "a" }), { kind: "auth-expired" });
  assert.deepEqual(connectionSignal({ documentExists: true, sessionValid: true, authorized: false, clientBuildId: "a", serverBuildId: "a" }), { kind: "access-revoked" });
  assert.deepEqual(connectionSignal({ documentExists: true, sessionValid: true, authorized: true, clientBuildId: "old", serverBuildId: "new" }), { kind: "update-ready", serverBuildId: "new" });
  assert.deepEqual(connectionSignal({ documentExists: true, sessionValid: true, authorized: true, clientBuildId: "same", serverBuildId: "same" }), { kind: "connected" });
});

test("local file persistence recovers durable comments, activity, and cursor but never mouse presence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ninerr-collab-"));
  try {
    const store = new LocalCollaborationFileStore(dir);
    const server = new LocalCollaborationServer(store);
    const first = await server.create("doc-1", [ownerGrant(), memberGrant()]);
    const joined = first.join({ actor: member, sessionId: "persist-s", at: T0 });
    first.publishPresence({ actorId: member.actorId, sessionId: "persist-s", generation: joined.presence.generation, update: { sequence: 1, at: T1, cursor: { x: 9, y: 9 } } });
    first.createComment({ id: "persist-comment", actor: member, transport: "http", at: T1, text: "Persist me", anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
    await server.save("doc-1");
    const before = first.readSnapshot({ actor: owner, transport: "http", at: T2 });
    assert.equal(before.presence.length, 1);
    await server.close("doc-1", { save: true });
    const second = await server.open("doc-1");
    const after = second.readSnapshot({ actor: owner, transport: "http", at: T2 });
    assert.equal(after.presence.length, 0);
    assert.deepEqual(after.comments, before.comments);
    assert.deepEqual(after.activity, before.activity);
    assert.equal(after.cursor, before.cursor);
    assert.equal(serializePersistentState(second.exportState()), serializePersistentState(first.exportState()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local server missing document is terminal not-found", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ninerr-collab-missing-"));
  try {
    const server = new LocalCollaborationServer(new LocalCollaborationFileStore(dir));
    await assert.rejects(() => server.open("missing-doc"), CollaborationNotFoundError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untrusted comment text is persisted strictly as data", () => {
  const r = room();
  const text = '<script>globalThis.compromised = true</script><img src=x onerror="boom()">';
  const comment = r.createComment({ id: "c-html", actor: member, transport: "http", at: T0, text, anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
  assert.equal(comment.text, text);
  assert.equal(globalThis.compromised, undefined);
});

test("explicit agent linkage refuses unproven identities and accepts only a committed transaction", () => {
  const r = room();
  r.createComment({ id: "c-proof", actor: member, transport: "http", at: T0, text: "@agent change it", anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
  const history = createHistoryState(createDocument({ id: "doc-1", nodes: [{ id: "node-1", type: "frame", props: { x: 0 } }] }));
  const committed = r.commitTransaction({ actor: member, transport: "agent", history, at: T1, operationId: "op-proof", workerTaskId: "task-proof", transaction: { id: "tx-proof", baseRevision: 0, operations: [{ type: "set-props", nodeId: "node-1", set: { x: 4 } }] } });
  assert.equal(committed.summary.transactionId, "tx-proof");
  assert.throws(
    () => r.linkAgentWork({ linkId: "bad", commentId: "c-proof", requester: member, transport: "agent", targetAgentId: agent.actorId, operationId: "op-missing", eventIds: ["event-proof"], transactionIds: ["tx-proof"], workerTaskId: "task-proof", at: T2, proof: { operationExists: () => false, eventExists: () => true, workerTaskExists: () => true } }),
    /operation identity is not proven/u,
  );
  assert.throws(
    () => r.linkAgentWork({ linkId: "bad-tx", commentId: "c-proof", requester: member, transport: "agent", targetAgentId: agent.actorId, operationId: "op-proof", eventIds: ["event-proof"], transactionIds: ["tx-other"], workerTaskId: "task-proof", at: T2, proof: { operationExists: () => true, eventExists: () => true, workerTaskExists: () => true } }),
    /transaction tx-other is not committed/u,
  );
  r.linkAgentWork({ linkId: "good", commentId: "c-proof", requester: member, transport: "agent", targetAgentId: agent.actorId, operationId: "op-proof", eventIds: ["event-proof"], transactionIds: ["tx-proof"], workerTaskId: "task-proof", at: T2, proof: { operationExists: (id) => id === "op-proof", eventExists: (id) => id === "event-proof", workerTaskExists: (id) => id === "task-proof" } });
  const link = r.exportState().log.facts.find((fact) => fact.id === "agent-link:good");
  assert.deepEqual(link.data.transactionIds, ["tx-proof"]);
});

test("protocol records reject unknown fields instead of silently accepting schema drift", () => {
  assert.throws(
    () => createCollaborationState("doc-1", [{ principalKind: "actor", principalId: member.actorId, capabilities: ["read"], surprise: true }]),
    /unsupported field surprise/u,
  );
  const r = room();
  const joined = r.join({ actor: member, sessionId: "unknown-s", at: T0 });
  assert.throws(
    () => r.publishPresence({ actorId: member.actorId, sessionId: "unknown-s", generation: joined.presence.generation, update: { sequence: 1, at: T1, cursor: { x: 1, y: 1 }, surprise: true } }),
    /unsupported field surprise/u,
  );
  const fact = {
    version: 1,
    documentId: "doc-1",
    id: "unknown-fact",
    sequence: 1,
    kind: "access-changed",
    actor: { actorId: owner.actorId, kind: "user", accessClass: "member", displayName: owner.displayName },
    at: T0,
    data: { policyRevision: 1 },
    surprise: true,
  };
  assert.throws(() => applyRemoteFact(createCollaborationLog("doc-1"), fact), /unsupported field surprise/u);
});

test("comment reads are explicitly paginated and bounded", () => {
  const r = room();
  r.createComment({ id: "page-root", actor: member, transport: "http", at: T0, text: "root", anchor: { documentId: "doc-1", nodeId: "node-1" }, nodeExists: () => true });
  r.replyComment({ id: "page-1", parentId: "page-root", actor: owner, transport: "http", text: "one", at: T1 });
  r.replyComment({ id: "page-2", parentId: "page-root", actor: owner, transport: "http", text: "two", at: T2 });
  const first = r.readCommentPage({ actor: member, transport: "http", commentId: "page-root", at: T3, cursor: 0, limit: 2 });
  assert.deepEqual(first.items.map((comment) => comment.id), ["page-root", "page-1"]);
  assert.equal(first.nextCursor, 2);
  const second = r.readCommentPage({ actor: member, transport: "http", commentId: "page-root", at: T3, cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map((comment) => comment.id), ["page-2"]);
  assert.equal(second.nextCursor, null);
  assert.throws(() => r.readCommentPage({ actor: member, transport: "http", commentId: "page-root", at: T3, limit: 201 }), /page limit/u);
});

test("ephemeral room session count is bounded", () => {
  const linkGrant = { principalKind: "link", principalId: "share-room", capabilities: ["read", "presence"] };
  const r = new LocalCollaborationRoom(createCollaborationState("doc-1", [ownerGrant(), linkGrant]));
  for (let index = 0; index < 256; index += 1) {
    r.join({ actor: { actorId: `guest-${index}`, kind: "user", accessClass: "guest", displayName: `Guest ${index}` }, sessionId: `session-${index}`, at: T0, linkGrantId: "share-room" });
  }
  assert.throws(
    () => r.join({ actor: { actorId: "guest-overflow", kind: "user", accessClass: "guest", displayName: "Overflow" }, sessionId: "session-overflow", at: T0, linkGrantId: "share-room" }),
    /room session limit 256 reached/u,
  );
});
