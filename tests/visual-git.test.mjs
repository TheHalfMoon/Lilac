import test from "node:test";
import assert from "node:assert/strict";

import {
  VISUAL_GIT_HARD_LIMITS,
  VISUAL_GIT_PROVENANCE,
  VisualGitConflictError,
  VisualGitValidationError,
  anchorComment,
  anchorComments,
  canonicalVisualGitStringify,
  detectConflicts,
  diffSnapshots,
  evaluateAcceptance,
  linkDesignToCode,
  linkDesignToCodeAll,
  normalizeSnapshot,
  recordProvenance,
  serializeSnapshot,
  sha256Text,
  snapshotDigest,
  verifyProvenance,
} from "../packages/visual-git/src/index.ts";

const AT = "2026-10-06T00:00:00.000Z";
const BASE_COMMIT = "a".repeat(40);
const HEAD_COMMIT = "b".repeat(40);
const hash = (label) => sha256Text(label);

function node(id, kind, parentId, content = id, name = id) {
  return { id, kind, parentId, name, contentHash: hash(content) };
}

function baseNodes() {
  return [
    node("page-1", "page", null),
    node("frame-1", "frame", "page-1"),
    node("frame-2", "frame", "page-1"),
    node("button-1", "node", "frame-1"),
    node("label-1", "node", "button-1"),
  ];
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    snapshotId: overrides.snapshotId ?? "snap-base",
    branch: overrides.branch ?? "main",
    sourceCommit: overrides.sourceCommit ?? BASE_COMMIT,
    parentSnapshotId: overrides.parentSnapshotId ?? null,
    createdAt: overrides.createdAt ?? AT,
    nodes: overrides.nodes ?? baseNodes(),
  };
}

function replaceNode(nodes, id, patch) {
  return nodes.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
}

test("provenance declares project-owned record-only posture", () => {
  assert.equal(VISUAL_GIT_PROVENANCE.package, "@ninerr/visual-git");
  assert.match(VISUAL_GIT_PROVENANCE.posture, /never executes git, mutates documents, or merges branches/);
});

test("valid snapshots normalize with stable ordering and canonical JSON", () => {
  const normalized = normalizeSnapshot(snapshot({ nodes: [...baseNodes()].reverse() }));
  assert.deepEqual(normalized.nodes.map((entry) => entry.id), ["button-1", "frame-1", "frame-2", "label-1", "page-1"]);
  const text = serializeSnapshot(snapshot());
  assert.deepEqual(JSON.parse(text), normalizeSnapshot(snapshot()));
  assert.equal(serializeSnapshot(snapshot({ nodes: [...baseNodes()].reverse() })), text);
  assert.equal(snapshotDigest(snapshot()), sha256Text(text));
});

test("canonical stringify emits parseable sorted JSON for nested objects", () => {
  const text = canonicalVisualGitStringify({ b: { d: [1, { f: 2, e: 1 }], c: null }, a: "x" });
  assert.equal(text, '{"a":"x","b":{"c":null,"d":[1,{"e":1,"f":2}]}}');
  assert.deepEqual(JSON.parse(text), { a: "x", b: { c: null, d: [1, { e: 1, f: 2 }] } });
  assert.throws(() => canonicalVisualGitStringify({ a: undefined }), VisualGitValidationError);
});

test("snapshot validation fails closed on malformed identity and structure", () => {
  const cases = [
    snapshot({ snapshotId: "" }),
    snapshot({ snapshotId: "bad id" }),
    snapshot({ branch: "../escape" }),
    snapshot({ branch: "feature/x.lock" }),
    snapshot({ branch: "-flag" }),
    snapshot({ sourceCommit: "ABC" }),
    snapshot({ sourceCommit: "A".repeat(40) }),
    snapshot({ createdAt: "not-a-date" }),
    snapshot({ parentSnapshotId: "snap-base" }),
    snapshot({ nodes: [...baseNodes(), node("page-1", "page", null, "dup")] }),
    snapshot({ nodes: replaceNode(baseNodes(), "frame-1", { parentId: "missing" }) }),
    snapshot({ nodes: replaceNode(baseNodes(), "page-1", { parentId: "frame-1" }) }),
    snapshot({ nodes: replaceNode(baseNodes(), "frame-1", { parentId: null }) }),
    snapshot({ nodes: replaceNode(baseNodes(), "frame-2", { parentId: "button-1" }) }),
    snapshot({ nodes: replaceNode(baseNodes(), "button-1", { contentHash: "deadbeef" }) }),
    snapshot({ nodes: replaceNode(baseNodes(), "button-1", { kind: "group" }) }),
    snapshot({ nodes: replaceNode(baseNodes(), "button-1", { name: "bad\u0000name" }) }),
    snapshot({ nodes: [...baseNodes(), { ...node("extra", "node", "frame-1"), extra: true }] }),
    { ...snapshot(), schemaVersion: 2 },
    { ...snapshot(), unexpected: 1 },
    null,
    [],
  ];
  for (const input of cases) assert.throws(() => normalizeSnapshot(input), VisualGitValidationError);
});

test("parent cycles are rejected", () => {
  const nodes = [
    node("page-1", "page", null),
    node("frame-a", "frame", "frame-b"),
    node("frame-b", "frame", "frame-a"),
  ];
  assert.throws(() => normalizeSnapshot(snapshot({ nodes })), /cycle/);
});

test("oversized and over-deep snapshots fail closed", () => {
  const many = [node("page-1", "page", null)];
  for (let index = 0; index < VISUAL_GIT_HARD_LIMITS.maxNodes; index += 1) many.push(node(`n-${index}`, "node", "page-1"));
  assert.throws(() => normalizeSnapshot(snapshot({ nodes: many })), /bounded budget/);
  const deep = [node("page-1", "page", null)];
  for (let index = 0; index <= VISUAL_GIT_HARD_LIMITS.maxDepth; index += 1) {
    deep.push(node(`d-${index}`, "frame", index === 0 ? "page-1" : `d-${index - 1}`));
  }
  assert.throws(() => normalizeSnapshot(snapshot({ nodes: deep })), /maximum depth/);
  const longName = replaceNode(baseNodes(), "button-1", { name: "x".repeat(VISUAL_GIT_HARD_LIMITS.maxNameLength + 1) });
  assert.throws(() => normalizeSnapshot(snapshot({ nodes: longName })), /exceeds/);
});

test("structural diff reports added, removed, changed, and moved exactly", () => {
  let nodes = baseNodes().filter((entry) => entry.id !== "label-1");
  nodes = replaceNode(nodes, "button-1", { contentHash: hash("button-1-v2"), parentId: "frame-2" });
  nodes = replaceNode(nodes, "frame-1", { name: "Hero" });
  nodes.push(node("icon-1", "node", "frame-2"));
  const head = snapshot({ snapshotId: "snap-head", sourceCommit: HEAD_COMMIT, parentSnapshotId: "snap-base", nodes });
  const diff = diffSnapshots(snapshot(), head);
  assert.deepEqual(diff.added.map((entry) => entry.id), ["icon-1"]);
  assert.deepEqual(diff.removed.map((entry) => entry.id), ["label-1"]);
  assert.deepEqual(diff.changed.map((entry) => [entry.id, entry.fields]), [["button-1", ["contentHash"]], ["frame-1", ["name"]]]);
  assert.deepEqual(diff.moved, [{ id: "button-1", fromParentId: "frame-1", toParentId: "frame-2" }]);
  assert.deepEqual(diff.summary, { added: 1, removed: 1, changed: 2, moved: 1, unchanged: 2 });
});

test("diff of identical content reports no changes and rejects identical snapshot ids", () => {
  const head = snapshot({ snapshotId: "snap-head", sourceCommit: HEAD_COMMIT });
  const diff = diffSnapshots(snapshot(), head);
  assert.deepEqual(diff.summary, { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 5 });
  assert.throws(() => diffSnapshots(snapshot(), snapshot()), VisualGitValidationError);
});

test("review comments anchor to existing stable ids and reject missing anchors", () => {
  const input = { commentId: "c-1", snapshotId: "snap-base", anchorId: "button-1", authorId: "reviewer", body: "Increase contrast", createdAt: AT, resolved: false };
  assert.deepEqual(anchorComment(snapshot(), input), input);
  assert.throws(() => anchorComment(snapshot(), { ...input, anchorId: "ghost" }), /does not exist/);
  assert.throws(() => anchorComment(snapshot(), { ...input, snapshotId: "other" }), VisualGitValidationError);
  assert.throws(() => anchorComment(snapshot(), { ...input, body: "" }), VisualGitValidationError);
  assert.throws(() => anchorComment(snapshot(), { ...input, resolved: "no" }), VisualGitValidationError);
  assert.throws(() => anchorComment(snapshot(), { ...input, extra: 1 }), VisualGitValidationError);
  assert.throws(() => anchorComments(snapshot(), [input, input]), VisualGitConflictError);
  assert.equal(anchorComments(snapshot(), [input, { ...input, commentId: "c-2", anchorId: "page-1" }]).length, 2);
  assert.throws(() => anchorComments(snapshot(), Array.from({ length: VISUAL_GIT_HARD_LIMITS.maxComments + 1 }, () => input)), /bounded budget/);
});

test("design/code links validate node, path, symbol, commit, and range", () => {
  const input = { linkId: "l-1", snapshotId: "snap-base", nodeId: "button-1", file: "src/components/Button.tsx", symbol: "Button", sourceCommit: BASE_COMMIT, range: { startLine: 3, endLine: 20 } };
  assert.deepEqual(linkDesignToCode(snapshot(), input), input);
  assert.equal(linkDesignToCode(snapshot(), { ...input, range: null }).range, null);
  assert.equal(linkDesignToCode(snapshot(), { ...input, symbol: "Buttons.Primary" }).symbol, "Buttons.Primary");
  const bad = [
    { ...input, nodeId: "ghost" },
    { ...input, file: "../secret" },
    { ...input, file: "/etc/passwd" },
    { ...input, file: "C:/Windows/system.ini" },
    { ...input, file: "src\\Button.tsx" },
    { ...input, file: "src//Button.tsx" },
    { ...input, file: "src/./Button.tsx" },
    { ...input, symbol: "Button; rm -rf /" },
    { ...input, sourceCommit: "main" },
    { ...input, range: { startLine: 0, endLine: 1 } },
    { ...input, range: { startLine: 5, endLine: 4 } },
    { ...input, range: { startLine: 1.5, endLine: 4 } },
    { ...input, snapshotId: "other" },
  ];
  for (const entry of bad) assert.throws(() => linkDesignToCode(snapshot(), entry), VisualGitValidationError);
  assert.throws(() => linkDesignToCodeAll(snapshot(), [input, input]), VisualGitConflictError);
});

test("conflicting branch heads produce conflict data without merging", () => {
  const base = snapshot();
  let oursNodes = replaceNode(baseNodes(), "button-1", { contentHash: hash("ours") });
  oursNodes = replaceNode(oursNodes, "frame-2", { name: "Ours" });
  oursNodes.push(node("new-1", "node", "frame-1", "ours-new"));
  let theirNodes = replaceNode(baseNodes(), "button-1", { contentHash: hash("theirs") });
  theirNodes = replaceNode(theirNodes, "frame-2", { contentHash: hash("theirs-frame") });
  theirNodes.push(node("new-1", "node", "frame-1", "theirs-new"));
  const ours = snapshot({ snapshotId: "snap-ours", branch: "feature/ours", sourceCommit: HEAD_COMMIT, nodes: oursNodes });
  const theirs = snapshot({ snapshotId: "snap-theirs", branch: "feature/theirs", sourceCommit: "c".repeat(40), nodes: theirNodes });
  const baseText = serializeSnapshot(base);
  const report = detectConflicts(base, ours, theirs);
  assert.equal(report.mergeable, false);
  assert.deepEqual(report.conflicts.map((entry) => [entry.nodeId, entry.kinds]), [["button-1", ["content"]], ["new-1", ["add-add"]]]);
  assert.equal(report.conflicts[0].ours.contentHash, hash("ours"));
  assert.equal(report.conflicts[0].theirs.contentHash, hash("theirs"));
  assert.equal(Object.hasOwn(report, "merged"), false);
  assert.equal(serializeSnapshot(base), baseText);
});

test("delete-modify, parent, and orphaned-child conflicts are reported", () => {
  const base = snapshot();
  const oursNodes = replaceNode(baseNodes().filter((entry) => entry.id !== "label-1"), "frame-1", { parentId: "page-1", name: "Moved?" });
  const ours = snapshot({ snapshotId: "snap-ours", sourceCommit: HEAD_COMMIT, nodes: [...replaceNode(oursNodes, "button-1", { parentId: "frame-2" })] });
  const theirNodes = replaceNode(baseNodes(), "label-1", { contentHash: hash("label-edit") });
  const theirs = snapshot({ snapshotId: "snap-theirs", sourceCommit: "c".repeat(40), nodes: replaceNode(theirNodes, "button-1", { parentId: "frame-1", contentHash: hash("b2") }) });
  const report = detectConflicts(base, ours, theirs);
  const kinds = Object.fromEntries(report.conflicts.map((entry) => [entry.nodeId, entry.kinds]));
  assert.deepEqual(kinds["label-1"], ["delete-modify"]);
  assert.equal(kinds["button-1"], undefined);

  const moveOurs = snapshot({ snapshotId: "snap-o2", sourceCommit: HEAD_COMMIT, nodes: replaceNode(baseNodes(), "button-1", { parentId: "frame-2" }) });
  const extraFrame = [...baseNodes(), node("frame-3", "frame", "page-1")];
  const moveTheirs = snapshot({ snapshotId: "snap-t2", sourceCommit: "c".repeat(40), nodes: replaceNode(extraFrame, "button-1", { parentId: "frame-3" }) });
  assert.deepEqual(detectConflicts(base, moveOurs, moveTheirs).conflicts.map((entry) => [entry.nodeId, entry.kinds]), [["button-1", ["parent"]]]);

  const orphanOurs = snapshot({ snapshotId: "snap-o3", sourceCommit: HEAD_COMMIT, nodes: [...baseNodes(), node("child-new", "node", "frame-2")] });
  const orphanTheirs = snapshot({ snapshotId: "snap-t3", sourceCommit: "c".repeat(40), nodes: baseNodes().filter((entry) => entry.id !== "frame-2") });
  assert.deepEqual(detectConflicts(base, orphanOurs, orphanTheirs).conflicts.map((entry) => [entry.nodeId, entry.kinds]), [["child-new", ["orphaned-child"]]]);
});

test("individually clean edits that combine into an invalid tree are conflicts", () => {
  const base = snapshot();
  const crossOurs = snapshot({ snapshotId: "snap-o4", sourceCommit: HEAD_COMMIT, nodes: replaceNode(baseNodes(), "frame-1", { parentId: "frame-2" }) });
  const crossTheirs = snapshot({ snapshotId: "snap-t4", sourceCommit: "c".repeat(40), nodes: replaceNode(baseNodes(), "frame-2", { parentId: "frame-1" }) });
  const cross = detectConflicts(base, crossOurs, crossTheirs);
  assert.equal(cross.mergeable, false);
  assert.deepEqual(cross.conflicts.map((entry) => [entry.nodeId, entry.kinds]), [["frame-1", ["cycle"]], ["frame-2", ["cycle"]]]);

  const kindOurs = snapshot({ snapshotId: "snap-o5", sourceCommit: HEAD_COMMIT, nodes: replaceNode(baseNodes(), "frame-2", { kind: "node" }) });
  const kindTheirs = snapshot({ snapshotId: "snap-t5", sourceCommit: "c".repeat(40), nodes: [...baseNodes(), node("frame-new", "frame", "frame-2")] });
  const nesting = detectConflicts(base, kindOurs, kindTheirs);
  assert.equal(nesting.mergeable, false);
  assert.deepEqual(nesting.conflicts.map((entry) => [entry.nodeId, entry.kinds]), [["frame-new", ["invalid-nesting"]]]);
});

test("independent and convergent edits are mergeable", () => {
  const base = snapshot();
  const ours = snapshot({ snapshotId: "snap-ours", sourceCommit: HEAD_COMMIT, nodes: replaceNode(baseNodes(), "frame-1", { name: "Hero" }) });
  const theirNodes = replaceNode(baseNodes(), "frame-1", { contentHash: hash("frame-edit") });
  const theirs = snapshot({ snapshotId: "snap-theirs", sourceCommit: "c".repeat(40), nodes: theirNodes });
  assert.equal(detectConflicts(base, ours, theirs).mergeable, true);
  const same = replaceNode(baseNodes(), "button-1", { contentHash: hash("same") });
  const convergent = detectConflicts(
    base,
    snapshot({ snapshotId: "snap-a", sourceCommit: HEAD_COMMIT, nodes: same }),
    snapshot({ snapshotId: "snap-b", sourceCommit: "c".repeat(40), nodes: same }),
  );
  assert.deepEqual(convergent.conflicts, []);
  assert.throws(() => detectConflicts(base, base, ours), VisualGitValidationError);
});

function gateInput(overrides = {}) {
  return {
    snapshot: snapshot({ snapshotId: "snap-head", sourceCommit: HEAD_COMMIT }),
    baseCommit: BASE_COMMIT,
    headCommit: HEAD_COMMIT,
    checks: [
      { name: "design-assurance", verdict: "pass", detail: "0 findings" },
      { name: "visual-diff", verdict: "pass", detail: "0 unexplained changes" },
    ],
    requiredChecks: ["design-assurance", "visual-diff"],
    ...overrides,
  };
}

test("acceptance gates pass on green and block on failing checks", () => {
  const green = evaluateAcceptance(gateInput());
  assert.equal(green.verdict, "accepted");
  assert.deepEqual(green.blocks, []);
  const red = evaluateAcceptance(gateInput({ checks: [{ name: "design-assurance", verdict: "fail", detail: "2 blockers" }, { name: "visual-diff", verdict: "pending", detail: "running" }] }));
  assert.equal(red.verdict, "blocked");
  assert.deepEqual(red.blocks, [{ reason: "failing-check", check: "design-assurance" }, { reason: "pending-check", check: "visual-diff" }]);
});

test("acceptance gates block on missing, skipped, empty, and stale evidence", () => {
  assert.deepEqual(evaluateAcceptance(gateInput({ checks: [{ name: "design-assurance", verdict: "pass", detail: "ok" }] })).blocks, [{ reason: "missing-required-check", check: "visual-diff" }]);
  assert.deepEqual(evaluateAcceptance(gateInput({ checks: [{ name: "design-assurance", verdict: "pass", detail: "ok" }, { name: "visual-diff", verdict: "skipped", detail: "n/a" }] })).blocks, [{ reason: "skipped-required-check", check: "visual-diff" }]);
  assert.equal(evaluateAcceptance(gateInput({ checks: [{ name: "optional", verdict: "skipped", detail: "n/a" }], requiredChecks: [] })).verdict, "accepted");
  assert.deepEqual(evaluateAcceptance(gateInput({ checks: [], requiredChecks: [] })).blocks, [{ reason: "no-checks", check: null }]);
  const stale = evaluateAcceptance(gateInput({ headCommit: "d".repeat(40) }));
  assert.equal(stale.verdict, "blocked");
  assert.deepEqual(stale.blocks[0], { reason: "stale-snapshot", check: null });
});

test("acceptance gate inputs fail closed when malformed", () => {
  const check = { name: "design-assurance", verdict: "pass", detail: "ok" };
  assert.throws(() => evaluateAcceptance(gateInput({ checks: [check, check] })), VisualGitConflictError);
  assert.throws(() => evaluateAcceptance(gateInput({ requiredChecks: ["a", "a"] })), VisualGitConflictError);
  assert.throws(() => evaluateAcceptance(gateInput({ checks: [{ ...check, verdict: "maybe" }] })), VisualGitValidationError);
  assert.throws(() => evaluateAcceptance(gateInput({ baseCommit: "HEAD" })), VisualGitValidationError);
  assert.throws(() => evaluateAcceptance({ ...gateInput(), extra: 1 }), VisualGitValidationError);
  assert.throws(() => evaluateAcceptance(gateInput({ checks: Array.from({ length: VISUAL_GIT_HARD_LIMITS.maxChecks + 1 }, (_, index) => ({ ...check, name: `c-${index}` })) })), /bounded budget/);
});

test("provenance records bind design state to source revision", () => {
  const head = snapshot({ snapshotId: "snap-head", branch: "feature/hero", sourceCommit: HEAD_COMMIT });
  const record = recordProvenance(head, { recordId: "prov-1", recordedBy: "visual-git", recordedAt: AT });
  assert.deepEqual(record, {
    recordId: "prov-1",
    snapshotId: "snap-head",
    snapshotDigest: snapshotDigest(head),
    branch: "feature/hero",
    sourceCommit: HEAD_COMMIT,
    recordedBy: "visual-git",
    recordedAt: AT,
  });
  assert.equal(verifyProvenance(record, head), true);
  const tampered = snapshot({ snapshotId: "snap-head", branch: "feature/hero", sourceCommit: HEAD_COMMIT, nodes: replaceNode(baseNodes(), "button-1", { name: "changed" }) });
  assert.throws(() => verifyProvenance(record, tampered), /does not match/);
  assert.throws(() => verifyProvenance({ ...record, sourceCommit: BASE_COMMIT }, head), /does not match/);
  assert.throws(() => recordProvenance(head, { recordId: "prov-1", recordedBy: "", recordedAt: AT }), VisualGitValidationError);
});

test("serialization is deterministic across repeated runs", () => {
  const head = snapshot({ snapshotId: "snap-head", sourceCommit: HEAD_COMMIT, nodes: [...baseNodes(), node("icon-1", "node", "frame-2")] });
  const first = canonicalVisualGitStringify(diffSnapshots(snapshot(), head));
  for (let run = 0; run < 3; run += 1) {
    assert.equal(canonicalVisualGitStringify(diffSnapshots(snapshot(), head)), first);
  }
  assert.doesNotThrow(() => JSON.parse(first));
});

test("accessor and proxy inputs are rejected so validated values cannot be swapped", () => {
  let reads = 0;
  const swapping = snapshot();
  Object.defineProperty(swapping, "branch", { enumerable: true, get: () => (reads++ === 0 ? "main" : "--upload-pack=evil") });
  assert.throws(() => normalizeSnapshot(swapping), /accessor/);
  const gate = gateInput();
  Object.defineProperty(gate, "headCommit", { enumerable: true, get: () => HEAD_COMMIT });
  assert.throws(() => evaluateAcceptance(gate), /accessor/);
  const check = { name: "design-assurance", detail: "ok" };
  Object.defineProperty(check, "verdict", { enumerable: true, get: () => "pass" });
  assert.throws(() => evaluateAcceptance(gateInput({ checks: [check] })), /accessor/);
  assert.throws(() => normalizeSnapshot(new Proxy(snapshot(), {})), /proxy/);
  assert.throws(() => normalizeSnapshot(snapshot({ nodes: new Proxy(baseNodes(), {}) })), /proxy/);
  assert.throws(() => normalizeSnapshot({ ...snapshot(), [Symbol("x")]: 1 }), /symbol/);
});

test("merges that exceed depth or node limits are not mergeable", () => {
  const chain = (prefix, root) => Array.from({ length: 100 }, (_, index) => node(`${prefix}-${index}`, "frame", index === 0 ? root : `${prefix}-${index - 1}`));
  const deepBase = [node("page-1", "page", null), ...chain("a", "page-1"), ...chain("b", "page-1"), ...chain("c", "page-1")];
  const base = snapshot({ nodes: deepBase });
  const ours = snapshot({ snapshotId: "snap-o6", sourceCommit: HEAD_COMMIT, nodes: replaceNode(deepBase, "b-0", { parentId: "a-99" }) });
  const theirs = snapshot({ snapshotId: "snap-t6", sourceCommit: "c".repeat(40), nodes: replaceNode(deepBase, "c-0", { parentId: "b-99" }) });
  const deep = detectConflicts(base, ours, theirs);
  assert.equal(deep.mergeable, false);
  assert.equal(deep.conflicts.length, 300 - VISUAL_GIT_HARD_LIMITS.maxDepth);
  assert.ok(deep.conflicts.every((entry) => entry.kinds.length === 1 && entry.kinds[0] === "depth-limit"));

  const half = VISUAL_GIT_HARD_LIMITS.maxNodes / 2;
  const grow = (prefix) => [node("page-1", "page", null), ...Array.from({ length: half }, (_, index) => node(`${prefix}-${index}`, "frame", "page-1"))];
  const wide = detectConflicts(
    snapshot({ nodes: [node("page-1", "page", null)] }),
    snapshot({ snapshotId: "snap-o7", sourceCommit: HEAD_COMMIT, nodes: grow("o") }),
    snapshot({ snapshotId: "snap-t7", sourceCommit: "c".repeat(40), nodes: grow("t") }),
  );
  assert.deepEqual(wide.conflicts, []);
  assert.equal(wide.exceedsNodeLimit, true);
  assert.equal(wide.mergeable, false);
});

test("boundary hardening: empty ranges, bidi text, git-hostile paths, malformed provenance records", () => {
  assert.deepEqual(evaluateAcceptance(gateInput({ baseCommit: HEAD_COMMIT })).blocks, [{ reason: "empty-range", check: null }]);
  assert.throws(() => normalizeSnapshot(snapshot({ nodes: replaceNode(baseNodes(), "frame-1", { name: "safe\u202etxt.exe" }) })), /control characters/);
  assert.throws(() => normalizeSnapshot(snapshot({ nodes: replaceNode(baseNodes(), "frame-1", { name: "c1\u0085" }) })), /control characters/);
  const link = { linkId: "link-x", snapshotId: "snap-base", nodeId: "button-1", file: "src/Button.tsx", symbol: "Button", sourceCommit: BASE_COMMIT, range: null };
  assert.equal(linkDesignToCode(snapshot(), link).file, "src/Button.tsx");
  for (const file of ["-rf/x.ts", "src/.git/config", ".GIT/HEAD"]) {
    assert.throws(() => linkDesignToCode(snapshot(), { ...link, file }), /normalized repository-relative path/);
  }
  assert.throws(() => verifyProvenance(null, snapshot()), VisualGitValidationError);
  assert.throws(() => verifyProvenance({ recordId: "../x" }, snapshot()), VisualGitValidationError);
});

test("array inputs must be dense plain arrays so map, iteration, and species cannot be forged", () => {
  const link = { linkId: "link-x", snapshotId: "snap-base", nodeId: "button-1", file: "src/Button.tsx", symbol: "Button", sourceCommit: BASE_COMMIT, range: null };
  const forged = [link];
  Object.setPrototypeOf(forged, { map: () => [{ ...link, file: "../../.git/hooks/x" }] });
  assert.throws(() => linkDesignToCodeAll(snapshot(), forged), /plain array/);
  const species = [link];
  species.constructor = { [Symbol.species]: function Forged() {} };
  assert.throws(() => linkDesignToCodeAll(snapshot(), species), /extra properties/);
  assert.throws(() => anchorComments(snapshot(), new Array(3)), /dense array/);
  assert.throws(() => linkDesignToCodeAll(snapshot(), [, ]), /dense array/);
  const holeAndExtra = [, ];
  holeAndExtra.extra = link;
  assert.throws(() => linkDesignToCodeAll(snapshot(), holeAndExtra), /dense array/);
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  assert.throws(() => linkDesignToCodeAll(snapshot(), proxy), VisualGitValidationError);
  assert.throws(() => normalizeSnapshot(new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } })), VisualGitValidationError);
});

test("invisible direction marks and Windows-normalized git paths are rejected", () => {
  for (const mark of ["\u200e", "\u200f", "\u061c", "\u2028", "\ufeff", "\u200b"]) {
    assert.throws(() => normalizeSnapshot(snapshot({ nodes: replaceNode(baseNodes(), "frame-1", { name: `a${mark}b` }) })), /control characters/);
  }
  const link = { linkId: "link-x", snapshotId: "snap-base", nodeId: "button-1", file: "src/Button.tsx", symbol: "Button", sourceCommit: BASE_COMMIT, range: null };
  assert.throws(() => linkDesignToCode(snapshot(), { ...link, file: "a/.git./x" }), /normalized repository-relative path/);
});

test("visual-git source is ASCII-only so no invisible or bidi characters hide in code", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../packages/visual-git/src/", import.meta.url);
  for (const file of readdirSync(dir)) {
    assert.doesNotMatch(readFileSync(new URL(file, dir), "utf8"), /[^\x00-\x7f]/u, file);
  }
  assert.doesNotMatch(readFileSync(new URL(import.meta.url), "utf8"), /[^\x00-\x7f]/u, "visual-git.test.mjs");
});

test("hidden text is rejected while visible joiners and line breaks stay legal", () => {
  const named = (name) => snapshot({ nodes: replaceNode(baseNodes(), "frame-1", { name }) });
  for (const hidden of ["\u{E0041}\u{E0042}", "\u{2060}", "\u{180e}", "\u{2062}", "\u{206a}", "\u{fff9}", "\u{ad}", "\u{34f}", "\u{3164}", "\u{115f}", "\ud800"]) {
    assert.throws(() => normalizeSnapshot(named(`a${hidden}b`)), /control characters/);
  }
  for (const visible of ["family \u{1F468}\u{200d}\u{1F469}", "\u{915}\u{94d}\u{200c}\u{937}", "line\nbreak\tand\rcr", "\u{644}\u{64a}\u{644}\u{643}"]) {
    assert.equal(normalizeSnapshot(named(visible)).nodes.find((entry) => entry.id === "frame-1").name, visible);
  }
});
