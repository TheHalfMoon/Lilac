import test from "node:test";
import assert from "node:assert/strict";

import {
  DECISION_ROUTER_PROVENANCE,
  DECISION_SCHEMA_VERSION,
  DecisionConflictError,
  DecisionAdapterError,
  DecisionUnavailableError,
  DecisionValidationError,
  createDecisionRequestLedger,
  createJevAdapter,
  createRuleAdapter,
  defaultDecisionPolicy,
  normalizeDecisionRequest,
  packDecisionCells,
  readDimensions,
  recordDecisionRequest,
  routeDecision,
} from "../packages/decision-router/src/index.ts";

const AT = "2026-10-06T00:00:00.000Z";

function dimensions() {
  return [
    { name: "tone", labels: ["positive", "neutral", "negative"] },
    { name: "urgency", labels: ["now", "later"], instructions: "Time sensitivity only." },
  ];
}

function request(overrides = {}) {
  return {
    schemaVersion: overrides.schemaVersion ?? DECISION_SCHEMA_VERSION,
    requestId: overrides.requestId ?? "decision-1",
    actorId: overrides.actorId ?? "user-1",
    intent: overrides.intent ?? "Route bounded decisions",
    at: overrides.at ?? AT,
    inputs: overrides.inputs ?? ["I love this", "This can wait"],
    dimensions: overrides.dimensions ?? dimensions(),
    policy: overrides.policy ?? defaultDecisionPolicy(),
  };
}

function stubAdapter(byCell) {
  return {
    name: "stub-adapter",
    async classifyCells(cells) {
      return {
        status: "ok",
        value: cells.map((cell) => {
          const result = byCell[`${cell.itemIndex}:${cell.dimensionIndex}`];
          assert.ok(result, `missing stub for ${cell.itemIndex}:${cell.dimensionIndex}`);
          return result;
        }),
      };
    },
  };
}

function fullScores(labels, label, confidence) {
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((entry) => [entry, entry === label ? confidence : rest]));
}

test("dimension and label bounds fail closed", () => {
  assert.equal(readDimensions(dimensions()).length, 2);
  assert.throws(() => readDimensions([]), DecisionValidationError);
  assert.throws(() => readDimensions("tone"), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "tone", labels: ["only-one"] }]), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "tone", labels: ["a", "a"] }]), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "", labels: ["a", "b"] }]), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "x".repeat(65), labels: ["a", "b"] }]), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "tone", labels: ["a", "x".repeat(201)] }]), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "tone", labels: ["a", "b"], extra: true }]), DecisionValidationError);
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ name: `d${index}`, labels: ["a", "b"] }));
  assert.throws(() => readDimensions(tooMany), DecisionValidationError);
  assert.throws(() => readDimensions([{ name: "tone", labels: ["a", "x".repeat(20000)] }]), DecisionValidationError);
  let nested = ["a", "b"];
  for (let depth = 0; depth < 12; depth += 1) nested = [nested];
  assert.throws(() => readDimensions([{ name: "tone", labels: nested }]), DecisionValidationError);
});

test("threshold and policy bounds fail closed", () => {
  assert.equal(defaultDecisionPolicy().unsureBelow, 0.7);
  for (const unsureBelow of [0, 1, -0.5, 2, Number.NaN, "0.7"]) {
    assert.throws(() => defaultDecisionPolicy({ unsureBelow }), DecisionValidationError);
  }
  assert.throws(() => normalizeDecisionRequest(request({ policy: { unsureBelow: 0 } })), DecisionValidationError);
  assert.throws(() => normalizeDecisionRequest(request({ inputs: [] })), DecisionValidationError);
  assert.throws(() => normalizeDecisionRequest(request({ schemaVersion: 999 })), DecisionValidationError);
  assert.throws(() => normalizeDecisionRequest(request({ policy: { unsureBelow: 0.5, maxItems: 1 }, inputs: ["a", "b"] })), DecisionValidationError);
});

test("stub adapter decisions are deterministic with full distributions", async () => {
  const labels = ["positive", "neutral", "negative"];
  const results = {
    "0:0": { label: "positive", confidence: 0.9, scores: fullScores(labels, "positive", 0.9) },
    "0:1": { label: "now", confidence: 0.8, scores: { now: 0.8, later: 0.2 } },
    "1:0": { label: "negative", confidence: 0.95, scores: fullScores(labels, "negative", 0.95) },
    "1:1": { label: "later", confidence: 0.75, scores: { now: 0.25, later: 0.75 } },
  };
  const first = await routeDecision(request(), {
    adapter: stubAdapter(results),
  });
  const second = await routeDecision(request(), {
    adapter: stubAdapter(results),
  });
  assert.equal(first.record.decisions.length, 4);
  assert.equal(first.record.reviewQueue.length, 0);
  assert.deepEqual(first.record, second.record);
  assert.equal(first.record.threshold, 0.7);
  assert.equal(first.record.adapter, "stub-adapter");
  for (const decision of first.record.decisions) {
    assert.equal(decision.abstained, false);
    const dimension = dimensions()[decision.dimensionIndex];
    assert.deepEqual(Object.keys(decision.scores).sort(), [...dimension.labels].sort());
    const total = Object.values(decision.scores).reduce((sum, score) => sum + score, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  }
});

test("low confidence abstains with reason and enters review", async () => {
  const labels = ["positive", "neutral", "negative"];
  const { record } = await routeDecision(request({ policy: defaultDecisionPolicy({ unsureBelow: 0.7 }) }), {
    adapter: stubAdapter({
      "0:0": { label: "positive", confidence: 0.4, scores: fullScores(labels, "positive", 0.4) },
      "0:1": { label: "now", confidence: 0.9, scores: { now: 0.9, later: 0.1 } },
      "1:0": { label: "neutral", confidence: 0.69, scores: fullScores(labels, "neutral", 0.69) },
      "1:1": { label: "later", confidence: 0.7, scores: { now: 0.3, later: 0.7 } },
    }),
  });
  const byCell = Object.fromEntries(record.decisions.map((decision) => [`${decision.itemIndex}:${decision.dimensionIndex}`, decision]));
  assert.equal(byCell["0:0"].abstained, true);
  assert.equal(byCell["0:0"].label, null);
  assert.match(byCell["0:0"].abstainReason ?? "", /below-threshold/u);
  assert.equal(byCell["0:1"].abstained, false);
  assert.equal(byCell["1:0"].abstained, true);
  assert.equal(byCell["1:1"].abstained, false);
  assert.equal(record.reviewQueue.length, 2);
  for (const item of record.reviewQueue) {
    assert.equal(item.requestId, "decision-1");
    assert.equal(item.at, AT);
    assert.equal(item.threshold, 0.7);
  }
});

test("deterministic prechecks outrank probabilistic output both ways", async () => {
  const labels = ["positive", "neutral", "negative"];
  const { record } = await routeDecision(request(), {
    adapter: stubAdapter({
      "0:0": { label: "positive", confidence: 0.99, scores: fullScores(labels, "positive", 0.99) },
      "0:1": { label: "now", confidence: 0.99, scores: { now: 0.99, later: 0.01 } },
      "1:0": { label: "negative", confidence: 0.99, scores: fullScores(labels, "negative", 0.99) },
      "1:1": { label: "later", confidence: 0.99, scores: { now: 0.01, later: 0.99 } },
    }),
    prechecks: [
      { itemIndex: 0, dimensionIndex: 0, verdict: { kind: "label", label: "negative" } },
      { itemIndex: 1, verdict: { kind: "abstain", reason: "design-assurance violation" } },
    ],
  });
  const byCell = Object.fromEntries(record.decisions.map((decision) => [`${decision.itemIndex}:${decision.dimensionIndex}`, decision]));
  assert.equal(byCell["0:0"].label, "negative");
  assert.equal(byCell["0:0"].confidence, 1);
  assert.equal(byCell["0:0"].adapter, "deterministic-precheck");
  assert.equal(byCell["0:0"].abstained, false);
  assert.equal(byCell["1:0"].abstained, true);
  assert.equal(byCell["1:0"].abstainReason, "design-assurance violation");
  assert.equal(byCell["1:1"].abstained, true);
  assert.equal(record.prechecksApplied, 3);
});

test("precheck with unknown label or out-of-range target fails closed", async () => {
  const adapter = stubAdapter({});
  await assert.rejects(
    routeDecision(request({ inputs: ["only"] }), { adapter, prechecks: [{ itemIndex: 5, verdict: { kind: "abstain", reason: "x" } }] }),
    DecisionValidationError,
  );
  await assert.rejects(
    routeDecision(request({ inputs: ["only"] }), { adapter, prechecks: [{ itemIndex: 0, dimensionIndex: 0, verdict: { kind: "label", label: "nope" } }] }),
    DecisionValidationError,
  );
});

test("malformed adapter output fails closed, never silently decides", async () => {
  const labels = ["positive", "neutral", "negative"];
  const good = { label: "positive", confidence: 0.9, scores: fullScores(labels, "positive", 0.9) };
  for (const bad of [
    { label: "unknown-label", confidence: 0.9, scores: fullScores(labels, "positive", 0.9) },
    { label: "positive", confidence: 7, scores: fullScores(labels, "positive", 0.9) },
    { label: "positive", confidence: 0.9, scores: { positive: 0.9 } },
    { label: "positive", confidence: 0.9, scores: { ...fullScores(labels, "positive", 0.9), extra: 0 } },
    "not-an-object",
  ]) {
    await assert.rejects(routeDecision(request({ inputs: ["x"] }), { adapter: stubAdapter({ "0:0": good, "0:1": bad }) }), /adapter|Decision/);
  }
  await assert.rejects(
    routeDecision(request({ inputs: ["x"] }), {
      adapter: {
        name: "short-adapter",
        async classifyCells() { return { status: "ok", value: [good] }; },
      },
    }),
    DecisionAdapterError,
  );
});

test("failing adapter fails the route without partial decisions", async () => {
  await assert.rejects(
    routeDecision(request({ inputs: ["x"] }), {
      adapter: {
        name: "boom-adapter",
        async classifyCells() { return { status: "failed", reason: "upstream exploded" }; },
      },
    }),
    /boom-adapter failed/u,
  );
  await assert.rejects(
    routeDecision(request({ inputs: ["x"] }), {
      adapter: {
        name: "throw-adapter",
        async classifyCells() { throw new Error("kaput"); },
      },
    }),
    /throw-adapter threw/u,
  );
});

test("unconfigured Jev adapter is unavailable and routes to review", async () => {
  const { record } = await routeDecision(request({ inputs: ["hello"] }), { adapter: createJevAdapter() });
  assert.equal(record.adapter, "jev-adapter");
  assert.equal(record.decisions.length, 2);
  for (const decision of record.decisions) {
    assert.equal(decision.abstained, true);
    assert.match(decision.abstainReason ?? "", /adapter-unavailable/u);
  }
  assert.equal(record.reviewQueue.length, 2);
});

test("offline rule adapter decides or abstains without network", async () => {
  const adapter = createRuleAdapter({
    tone: [
      { label: "positive", anyOf: ["love", "great"], confidence: 0.9 },
      { label: "negative", anyOf: ["hate", "terrible"] },
    ],
  });
  const { record } = await routeDecision(
    request({ inputs: ["I love this", "utterly bland filler"], dimensions: [{ name: "tone", labels: ["positive", "neutral", "negative"] }] }),
    { adapter },
  );
  const byItem = Object.fromEntries(record.decisions.map((decision) => [decision.itemIndex, decision]));
  assert.equal(byItem[0].label, "positive");
  assert.equal(byItem[0].confidence, 0.9);
  assert.equal(byItem[0].abstained, false);
  assert.equal(byItem[1].abstained, true);
  assert.match(byItem[1].abstainReason ?? "", /below-threshold/u);
  assert.equal(record.reviewQueue.length, 1);
});

test("request ledger is idempotent only for identical input", async () => {
  const adapter = createRuleAdapter({ tone: [{ label: "positive", anyOf: ["love"] }] });
  const ledger = createDecisionRequestLedger();
  const first = await routeDecision(request({ inputs: ["I love this"], dimensions: [{ name: "tone", labels: ["positive", "negative"] }] }), { adapter, ledger });
  assert.equal(first.reused, false);
  const second = await routeDecision(request({ inputs: ["I love this"], dimensions: [{ name: "tone", labels: ["positive", "negative"] }] }), { adapter, ledger: first.ledger });
  assert.equal(second.reused, true);
  assert.deepEqual(second.record, first.record);
  const direct = recordDecisionRequest(first.ledger, request({ inputs: ["I love this"], dimensions: [{ name: "tone", labels: ["positive", "negative"] }] }), first.record.recordId);
  assert.equal(direct.reused, true);
  assert.throws(
    () => recordDecisionRequest(first.ledger, request({ inputs: ["different"], dimensions: [{ name: "tone", labels: ["positive", "negative"] }] }), first.record.recordId),
  DecisionConflictError,
  DecisionAdapterError,
  );
});

test("oversized batches and review overflow fail closed", async () => {
  const inputs = Array.from({ length: 10 }, (_, index) => `input ${index}`);
  assert.throws(() => normalizeDecisionRequest(request({ inputs, policy: defaultDecisionPolicy({ maxItems: 9 }) })), DecisionValidationError);
  const cells = packDecisionCells(normalizeDecisionRequest(request({ inputs: ["a", "b"] })));
  assert.equal(cells.flat().length, 4);
  const tiny = packDecisionCells(normalizeDecisionRequest(request({ inputs: ["a"], policy: defaultDecisionPolicy({ maxCellsPerBatch: 1 }) })));
  assert.equal(tiny.length, 2);
  await assert.rejects(
    routeDecision(request({ inputs: ["a"], policy: defaultDecisionPolicy({ maxReviewItems: 1 }) }), { adapter: createJevAdapter() }),
    DecisionValidationError,
  );
});

test("decision records carry provenance and threshold evidence", async () => {
  const { record } = await routeDecision(request({ requestId: "decision-9", intent: "Evidence check" }), {
    adapter: createRuleAdapter({ tone: [{ label: "positive", anyOf: ["love"] }], urgency: [{ label: "later", anyOf: ["wait"] }] }),
  });
  assert.equal(record.schemaVersion, DECISION_SCHEMA_VERSION);
  assert.match(record.recordId, /^decision-record:[a-f0-9]{32}$/u);
  assert.equal(record.requestId, "decision-9");
  assert.equal(record.actorId, "user-1");
  assert.equal(record.intent, "Evidence check");
  assert.equal(record.at, AT);
  assert.match(record.dimensionsSha256, /^[a-f0-9]{64}$/u);
  assert.equal(record.threshold, 0.7);
  assert.equal(typeof record.adapter, "string");
});

test("provenance pins the permissive donor and keeps SaaS out", () => {
  assert.equal(DECISION_ROUTER_PROVENANCE.guidanceDonor, "mrmps/classifier-dev");
  assert.equal(DECISION_ROUTER_PROVENANCE.donorRevision, "a17bf2b6353f6234af6e977a463da7cd1975b68e");
  assert.equal(DECISION_ROUTER_PROVENANCE.donorLicense, "MIT");
});

test("unused unavailable error stays importable for adapter hosts", () => {
  assert.equal(new DecisionUnavailableError("not configured").name, "DecisionUnavailableError");
});

function honestAnswers(cells) {
  return cells.map((cell) => ({ label: cell.dimension.labels[0], confidence: 0.9, scores: fullScores(cell.dimension.labels, cell.dimension.labels[0], 0.9) }));
}

test("adapters cannot alter router cells, indexes, or prototypes", async () => {
  const honest = { name: "isolated", async classifyCells(cells) { return { status: "ok", value: honestAnswers(cells) }; } };
  const hostile = {
    name: "isolated",
    async classifyCells(cells) {
      const answers = honestAnswers(cells);
      for (const cell of cells) {
        cell.itemIndex = "__proto__";
        cell.dimensionIndex = 99;
        cell.cellId = "forged";
        cell.input = "rewritten";
        cell.dimension.labels.push("injected");
      }
      return { status: "ok", value: answers };
    },
  };
  const expected = await routeDecision(request(), { adapter: honest });
  const actual = await routeDecision(request(), { adapter: hostile });
  assert.deepEqual(actual.record, expected.record);
  assert.equal(Array.prototype.fit, undefined);
  assert.ok(actual.record.decisions.every((decision) => Number.isSafeInteger(decision.itemIndex)));
});

test("adapter outcomes are read once as plain data", async () => {
  let reads = 0;
  const shifty = {
    name: "shifty",
    async classifyCells(cells) {
      return {
        status: "ok",
        value: honestAnswers(cells).map((answer) => {
          const copy = { confidence: answer.confidence, scores: answer.scores };
          const label = answer.label;
          Object.defineProperty(copy, "label", { enumerable: true, get: () => (reads++ === 0 ? label : "\u{202e}forged") });
          return copy;
        }),
      };
    },
  };
  // The first answer clones with its real label, the next ones clone as the forged label,
  // which validation rejects: the route fails closed instead of recording forged values.
  await assert.rejects(routeDecision(request(), { adapter: shifty }), DecisionAdapterError);
  assert.equal(reads, 4);
  const proxied = { name: "proxied", async classifyCells() { return new Proxy({ status: "ok", value: [] }, {}); } };
  await assert.rejects(routeDecision(request(), { adapter: proxied }), /not plain data/);
});

test("adapter identity is read once and adapter text is bounded", async () => {
  let reads = 0;
  const named = { async classifyCells(cells) { return { status: "ok", value: honestAnswers(cells) }; } };
  Object.defineProperty(named, "name", { get: () => (reads++ === 0 ? "stable-name" : "changed-name") });
  const result = await routeDecision(request(), { adapter: named });
  assert.equal(reads, 1);
  assert.equal(result.record.adapter, "stable-name");
  assert.ok(result.record.decisions.every((decision) => decision.adapter === "stable-name"));
  await assert.rejects(routeDecision(request(), { adapter: { name: "", async classifyCells() {} } }), DecisionValidationError);
  await assert.rejects(routeDecision(request(), { adapter: { name: "x".repeat(129), async classifyCells() {} } }), DecisionValidationError);

  const loud = { name: "loud", async classifyCells() { return { status: "unavailable", reason: "r".repeat(1_000_000) }; } };
  const unavailable = await routeDecision(request(), { adapter: loud });
  assert.ok(unavailable.record.decisions.every((decision) => decision.abstainReason.length <= 1100));
  const unprintable = { name: "unprintable", async classifyCells() { throw { toString() { throw new Error("nope"); } }; } };
  await assert.rejects(routeDecision(request(), { adapter: unprintable }), /non-string adapter reason/);
});

test("every adapter throw is re-issued by the router with a bounded, host-independent reason", async () => {
  const forged = { name: "forger", async classifyCells() { throw new DecisionAdapterError("z".repeat(1_000_000)); } };
  const huge = await routeDecision(request(), { adapter: forged }).catch((error) => error);
  assert.ok(huge instanceof DecisionAdapterError);
  assert.ok(huge.message.length <= 1100, String(huge.message.length));

  const sneaky = new Error("hidden");
  Object.defineProperty(sneaky, "message", { get() { throw new Error("gotcha"); } });
  await assert.rejects(routeDecision(request(), { adapter: { name: "sneaky", async classifyCells() { throw sneaky; } } }), (error) => error instanceof DecisionAdapterError && /unprintable adapter reason/.test(error.message));

  const dated = { name: "dated", async classifyCells() { return { status: "unavailable", reason: new Date(0) }; } };
  const result = await routeDecision(request(), { adapter: dated });
  assert.ok(result.record.decisions.every((decision) => decision.abstainReason === "adapter-unavailable: non-string adapter reason"));

  const badIdentity = { async classifyCells() {} };
  Object.defineProperty(badIdentity, "name", { get() { throw new Error("no name"); } });
  await assert.rejects(routeDecision(request(), { adapter: badIdentity }), DecisionValidationError);
});
