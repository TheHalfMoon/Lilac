import test from "node:test";
import assert from "node:assert/strict";
import {
import { realpathSync } from "node:fs"; mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DELIVERY_GOVERNANCE_PROVENANCE,
  DELIVERY_SCHEMA_VERSION,
  DeliveryConflictError,
  DeliveryGateError,
  DeliveryValidationError,
  canonicalDeliveryStringify,
  createAskUserRequest,
  createEvidenceStore,
  createQualificationId,
  evaluateQualification,
  normalizeAskUserRequest,
  normalizeQualificationRecord,
  recordRepair,
  resolveAskUserRequest,
  verifyBaseUnmoved,
  verifyCiChecks,
  verifyExactHead,
  verifyWorktreeHeads,
} from "../packages/delivery-governance/src/index.ts";

const AT = "2026-10-06T00:00:00.000Z";
const HEAD = "9e25bd787b2e874120f6183beea1dfe07b1afba4";
const HEAD2 = "3955007ca055708bdb7efc0b4601cbd2df8bff6e";
const BASE = "a54517413267e3f1cf190128c24334e337403a18";

function gate(name = "tests", verdict = "pass", findings = []) {
  return { name, verdict, findings };
}

function ci(name = "Foundation checks", conclusion = "success", headSha = HEAD) {
  return { name, conclusion, headSha };
}

function record(overrides = {}) {
  return {
    schemaVersion: overrides.schemaVersion ?? DELIVERY_SCHEMA_VERSION,
    qualificationId: overrides.qualificationId ?? "delivery-qualification:test01",
    candidateHead: overrides.candidateHead ?? HEAD,
    base: overrides.base ?? BASE,
    parentQualificationId: overrides.parentQualificationId ?? null,
    actorId: "agent-1",
    intent: "Qualify bounded change",
    createdAt: AT,
    gates: overrides.gates ?? [gate()],
    ciChecks: overrides.ciChecks ?? [ci()],
    worktrees: overrides.worktrees ?? [],
    mergeStrategy: overrides.mergeStrategy ?? "merge",
    mutatedAfterQualification: overrides.mutatedAfterQualification ?? false,
  };
}

function observed(overrides = {}) {
  return {
    head: overrides.head ?? HEAD,
    base: overrides.base ?? BASE,
    ciChecks: overrides.ciChecks ?? [ci()],
  };
}

test("finding severity and surface validation fail closed", () => {
  assert.throws(() => normalizeQualificationRecord(record({ gates: [{ name: "x", verdict: "pass", findings: [{ severity: "nope", surface: "s", message: "m", tool: "t" }] }] })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ gates: [{ name: "x", verdict: "maybe", findings: [] }] })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ gates: [{ name: "x", verdict: "pass", findings: [], extra: 1 }] })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ ciChecks: [{ name: "CI", conclusion: "sort-of", headSha: HEAD }] })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ candidateHead: "not-a-sha" })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ mergeStrategy: "squash" })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ mergeStrategy: "rebase" })), DeliveryValidationError);
  assert.throws(() => normalizeQualificationRecord(record({ schemaVersion: 999 })), DeliveryValidationError);
});

test("exact-head proof passes only for the recorded head", () => {
  verifyExactHead(record(), HEAD);
  assert.throws(() => verifyExactHead(record(), HEAD2), DeliveryGateError);
  assert.throws(() => verifyExactHead(record({ mutatedAfterQualification: true }), HEAD), DeliveryGateError);
  verifyBaseUnmoved(record(), BASE);
  assert.throws(() => verifyBaseUnmoved(record(), HEAD), DeliveryGateError);
});

test("worktree head movement protection", () => {
  const withWorktree = record({ worktrees: [{ canonicalPath: "/tmp/wt-1", branch: "impl/x", head: HEAD, base: BASE }] });
  verifyWorktreeHeads(withWorktree, [{ canonicalPath: "/tmp/wt-1", head: HEAD }]);
  assert.throws(() => verifyWorktreeHeads(withWorktree, [{ canonicalPath: "/tmp/wt-1", head: HEAD2 }]), DeliveryGateError);
  assert.throws(() => verifyWorktreeHeads(withWorktree, []), DeliveryGateError);
});

test("CI model requires success on the candidate head", () => {
  verifyCiChecks(record(), [ci()]);
  assert.throws(() => verifyCiChecks(record(), [ci("Foundation checks", "failure")]), DeliveryGateError);
  assert.throws(() => verifyCiChecks(record(), []), DeliveryGateError);
  assert.throws(() => verifyCiChecks(record(), [ci("Foundation checks", "success", HEAD2)]), DeliveryGateError);
});

test("full evaluation qualifies only green exact-head evidence", () => {
  assert.deepEqual(evaluateQualification(record(), observed()), { verdict: "qualified", reasons: [] });
  assert.equal(evaluateQualification(record(), observed({ head: HEAD2 })).verdict, "blocked");
  assert.equal(evaluateQualification(record(), observed({ base: HEAD })).verdict, "blocked");
  assert.equal(evaluateQualification(record({ mutatedAfterQualification: true }), observed()).verdict, "blocked");
  const failing = evaluateQualification(record({ gates: [gate("tests", "fail")] }), observed());
  assert.equal(failing.verdict, "blocked");
  const blocking = evaluateQualification(
    record({ gates: [{ name: "review", verdict: "pass", findings: [{ severity: "blocking", surface: "auth", message: "hole", tool: "jev" }] }] }),
    observed(),
  );
  assert.equal(blocking.verdict, "blocked");
  const parked = evaluateQualification(record({ gates: [gate("review", "ask-user")] }), observed());
  assert.equal(parked.verdict, "ask-user");
  assert.equal(evaluateQualification(record({ gates: [] }), observed()).verdict, "blocked");
  assert.equal(evaluateQualification(record({ ciChecks: [] }), observed({ ciChecks: [] })).verdict, "blocked");
});

test("repair ancestry requires fresh evidence for the new head", () => {
  const parent = normalizeQualificationRecord(record());
  const child = recordRepair(parent, { candidateHead: HEAD2, actorId: "agent-1", intent: "Repair hole", createdAt: AT });
  assert.equal(child.parentQualificationId, parent.qualificationId);
  assert.equal(child.candidateHead, HEAD2);
  assert.equal(evaluateQualification(child, observed({ head: HEAD2, ciChecks: [] })).verdict, "blocked");
  assert.throws(() => recordRepair(parent, { candidateHead: HEAD, actorId: "a", intent: "i", createdAt: AT }), DeliveryValidationError);
  const { qualificationId: _dropped, ...rest } = record();
  assert.match(createQualificationId(rest), /^delivery-qualification:[a-f0-9]{32}$/u);
});

test("ask-user creation and explicit resolution round-trip", () => {
  const request = createAskUserRequest({
    requestId: "ask-1",
    reason: "Blocking review finding needs a human decision",
    blockedGates: ["review"],
    candidateHead: HEAD,
    createdAt: AT,
  });
  assert.equal(request.status, "open");
  assert.throws(() => createAskUserRequest({
    requestId: "ask-2", reason: "x", blockedGates: [], candidateHead: HEAD, createdAt: AT,
  }), DeliveryValidationError);
  const resolved = resolveAskUserRequest(request, { resolvedBy: "founder", resolutionNote: "Accepted with follow-up issue" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "founder");
  assert.throws(() => resolveAskUserRequest(resolved, { resolvedBy: "founder", resolutionNote: "again" }), DeliveryGateError);
  assert.throws(() => normalizeAskUserRequest({ ...request, status: "open", resolvedBy: "x" }), DeliveryValidationError);
});

test("evidence store pins one root outside disposable worktrees", async () => {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ninerr-delivery-outside-")));
  try {
    const bundle = {
      qualificationId: "delivery-qualification:test01",
      candidateHead: HEAD,
      createdAt: AT,
      records: [record()],
      askUserRequests: [],
    };
    const store = await createEvidenceStore({ evidenceRoot: dir, disposableRoots: ["/tmp/disposable-wt"] });
    assert.equal(store.root, dir);
    const first = await store.writeBundle(bundle);
    assert.match(first.bundleId, /^evidence-bundle:[a-f0-9]{32}$/u);
    await assert.rejects(store.writeBundle(bundle), DeliveryValidationError);
    await assert.rejects(createEvidenceStore({ evidenceRoot: join("/tmp/disposable-wt", "sub"), disposableRoots: ["/tmp/disposable-wt"] }), DeliveryValidationError);
    await assert.rejects(createEvidenceStore({ evidenceRoot: "/tmp/disposable-wt", disposableRoots: ["/tmp/disposable-wt"] }), DeliveryValidationError);
    await assert.rejects(createEvidenceStore({ evidenceRoot: "" }), DeliveryValidationError);
    const aliasedRoot = realpathSync.native(await mkdtemp(join(tmpdir(), "ninerr-delivery-root-")));
    try {
      const alias = join(tmpdir(), `ninerr-delivery-alias-${Date.now()}`);
      await symlink(aliasedRoot, alias, "junction");
      try {
        await assert.rejects(createEvidenceStore({ evidenceRoot: join(alias, "sub"), disposableRoots: [aliasedRoot] }), DeliveryValidationError);
        await assert.rejects(createEvidenceStore({ evidenceRoot: join(aliasedRoot, "sub"), disposableRoots: [alias] }), DeliveryValidationError);
      } finally {
        await rm(alias, { recursive: true, force: true });
      }
    } finally {
      await rm(aliasedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence store rejects malformed bundles with typed errors", async () => {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ninerr-delivery-malformed-")));
  try {
    const store = await createEvidenceStore({ evidenceRoot: dir });
    await assert.rejects(store.writeBundle(null), DeliveryValidationError);
    await assert.rejects(store.writeBundle({ records: "nope", askUserRequests: [] }), DeliveryValidationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized collections fail closed", () => {
  const findings = Array.from({ length: 257 }, (_, index) => ({ severity: "info", surface: `s${index}`, message: "m", tool: "t" }));
  assert.throws(() => normalizeQualificationRecord(record({ gates: [{ name: "g", verdict: "pass", findings }] })), DeliveryValidationError);
  const gates = Array.from({ length: 33 }, (_, index) => gate(`g${index}`));
  assert.throws(() => normalizeQualificationRecord(record({ gates })), DeliveryValidationError);
});

test("deterministic serialization for identical inputs", () => {
  const base = record();
  const reordered = {};
  for (const key of Object.keys(base).reverse()) reordered[key] = base[key];
  assert.equal(canonicalDeliveryStringify(base), canonicalDeliveryStringify(reordered));
  assert.equal(createQualificationId(base), createQualificationId(reordered));
});

test("provenance pins the permissive donor and keeps machinery out", () => {
  assert.equal(DELIVERY_GOVERNANCE_PROVENANCE.guidanceDonor, "kunchenguid/no-mistakes");
  assert.equal(DELIVERY_GOVERNANCE_PROVENANCE.donorRevision, "0616eb4911845e2ba04faa17186ecd2686d7d579");
  assert.equal(DELIVERY_GOVERNANCE_PROVENANCE.donorLicense, "MIT");
});

test("unused conflict error stays importable for ledger hosts", () => {
  assert.equal(new DeliveryConflictError("conflict").name, "DeliveryConflictError");
});
