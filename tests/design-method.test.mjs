import test from "node:test";
import assert from "node:assert/strict";

import {
  DESIGN_METHOD_PROVENANCE,
  DESIGN_METHOD_SCHEMA_VERSION,
  DesignMethodValidationError,
  NINERR_MOBILE_METHOD_PACK,
  RESOURCE_TAXONOMY_CATEGORIES,
  RESOURCE_TAXONOMY_VERSION,
  builtinChecklists,
  canonicalMethodStringify,
  evaluateSnapshot,
  normalizeChecklist,
  normalizeRegistry,
  normalizeRulePack,
  normalizeSnapshot,
  sha256Text,
} from "../packages/design-method/src/index.ts";

function node(overrides = {}) {
  return {
    id: overrides.id ?? "n1",
    kind: overrides.kind ?? "button",
    label: overrides.label ?? "Save",
    x: 0,
    y: 8,
    width: 120,
    height: 48,
    interactive: true,
    ...overrides,
  };
}

function snapshot(nodes, overrides = {}) {
  return {
    schemaVersion: DESIGN_METHOD_SCHEMA_VERSION,
    snapshotId: "snapshot-1",
    nodes,
    ...overrides,
  };
}

test("rule pack validation fails closed", () => {
  assert.equal(NINERR_MOBILE_METHOD_PACK.rules.length, 7);
  assert.throws(() => normalizeRulePack({ ...NINERR_MOBILE_METHOD_PACK, rules: [] }), DesignMethodValidationError);
  assert.throws(() => normalizeRulePack({ ...NINERR_MOBILE_METHOD_PACK, platform: "desktop" }), DesignMethodValidationError);
  assert.throws(() => normalizeRulePack({
    ...NINERR_MOBILE_METHOD_PACK,
    rules: [...NINERR_MOBILE_METHOD_PACK.rules, { ...NINERR_MOBILE_METHOD_PACK.rules[0] }],
  }), DesignMethodValidationError);
  assert.throws(() => normalizeRulePack({ ...NINERR_MOBILE_METHOD_PACK, rules: [{ id: "Bad Id", statement: "s", rationale: "r", severity: "minor" }] }), DesignMethodValidationError);
  assert.throws(() => normalizeRulePack({ ...NINERR_MOBILE_METHOD_PACK, rules: [{ id: "x", statement: "s", rationale: "r", severity: "catastrophic" }] }), DesignMethodValidationError);
});

test("deterministic evaluation finds seeded violations with exact references", () => {
  const candidates = evaluateSnapshot(
    snapshot([
      node({ id: "tiny", width: 20, height: 20 }),
      node({ id: "unlabeled-image", kind: "image", label: "", interactive: false, width: 100, height: 100 }),
      node({ id: "big-list", kind: "list", label: "Feed", interactive: false, width: 390, height: 844, itemCount: 120 }),
      node({ id: "off-grid", x: 3, width: 121 }),
      { id: "t1", kind: "text", text: "Hello", textSize: 34 },
      { id: "t2", kind: "text", text: "World", textSize: 40 },
    ], { themes: ["light", "dark"], tokensThemed: false }),
    NINERR_MOBILE_METHOD_PACK,
  );
  const byRule = Object.fromEntries(candidates.map((candidate) => [candidate.ruleId, candidate]));
  assert.equal(byRule["min-touch-target"].nodeId, "tiny");
  assert.equal(byRule["labeled-images"].nodeId, "unlabeled-image");
  assert.equal(byRule["virtualized-long-lists"].nodeId, "big-list");
  const gridNodes = candidates.filter((candidate) => candidate.ruleId === "spacing-grid").map((candidate) => candidate.nodeId).sort();
  assert.deepEqual(gridNodes, ["big-list", "off-grid"]);
  assert.equal(byRule["single-display-size"].nodeId, null);
  assert.equal(byRule["themed-tokens"].nodeId, null);
  assert.equal(byRule["named-interactive-nodes"], undefined);
  for (const candidate of candidates) {
    assert.equal(candidate.packId, "ninerr-mobile-method");
    assert.ok(["minor", "major"].includes(candidate.severity));
  }
  const again = evaluateSnapshot(
    snapshot([
      node({ id: "tiny", width: 20, height: 20 }),
      node({ id: "unlabeled-image", kind: "image", label: "", interactive: false, width: 100, height: 100 }),
      node({ id: "big-list", kind: "list", label: "Feed", interactive: false, width: 390, height: 844, itemCount: 120 }),
      node({ id: "off-grid", x: 3, width: 121 }),
      { id: "t1", kind: "text", text: "Hello", textSize: 34 },
      { id: "t2", kind: "text", text: "World", textSize: 40 },
    ], { themes: ["light", "dark"], tokensThemed: false }),
    NINERR_MOBILE_METHOD_PACK,
  );
  assert.deepEqual(again, candidates);
});

test("clean snapshots produce no candidates", () => {
  const candidates = evaluateSnapshot(
    snapshot([
      node({ id: "cta" }),
      { id: "hero", kind: "text", text: "Hello", textSize: 34 },
      { id: "body", kind: "text", text: "World", textSize: 17 },
      { id: "avatar", kind: "image", label: "Profile photo", interactive: false, width: 64, height: 64 },
      { id: "feed", kind: "list", label: "Feed", interactive: false, width: 392, height: 844, itemCount: 12, virtualized: true },
    ], { themes: ["light", "dark"], tokensThemed: true }),
    NINERR_MOBILE_METHOD_PACK,
  );
  assert.deepEqual(candidates, []);
});

test("snapshot validation fails closed", () => {
  assert.throws(() => normalizeSnapshot(snapshot([])), DesignMethodValidationError);
  assert.throws(() => normalizeSnapshot(snapshot([{ id: "x", kind: "hologram" }])), DesignMethodValidationError);
  assert.throws(() => normalizeSnapshot(snapshot([node({ id: "a" }), node({ id: "a" })])), DesignMethodValidationError);
  assert.throws(() => normalizeSnapshot(snapshot([node()], { schemaVersion: 999 })), DesignMethodValidationError);
  assert.throws(() => normalizeSnapshot(snapshot([node()], { themes: [] })), DesignMethodValidationError);
});

test("checklists reference only known rule ids", () => {
  const lists = builtinChecklists([NINERR_MOBILE_METHOD_PACK]);
  assert.equal(lists.length, 3);
  const known = new Set(NINERR_MOBILE_METHOD_PACK.rules.map((rule) => `ninerr-mobile-method/${rule.id}`));
  for (const list of lists) {
    for (const item of list.items) {
      for (const ruleId of item.ruleIds) assert.ok(known.has(ruleId), ruleId);
    }
  }
  assert.throws(() => normalizeChecklist({
    id: "bad-list",
    role: "critic",
    items: [{ id: "bad-item", text: "Check the vibes.", ruleIds: ["ninerr-mobile-method/no-such-rule"] }],
  }, known), DesignMethodValidationError);
});

test("registry accepts well-formed entries and rejects unknowns", () => {
  const registry = normalizeRegistry({
    schemaVersion: DESIGN_METHOD_SCHEMA_VERSION,
    taxonomyVersion: RESOURCE_TAXONOMY_VERSION,
    entries: [
      { id: "inter-font", name: "Inter", category: "fonts", source: "rsms", license: "OFL-1.1", url: "https://rsms.me/inter/" },
      { id: "lucide-icons", name: "Lucide", category: "icons", source: "lucide", license: "ISC" },
    ],
  });
  assert.equal(registry.entries.length, 2);
  assert.throws(() => normalizeRegistry({
    schemaVersion: DESIGN_METHOD_SCHEMA_VERSION,
    taxonomyVersion: RESOURCE_TAXONOMY_VERSION,
    entries: [{ id: "x", name: "X", category: "vibes", source: "s", license: "MIT" }],
  }), DesignMethodValidationError);
  assert.throws(() => normalizeRegistry({
    schemaVersion: DESIGN_METHOD_SCHEMA_VERSION,
    taxonomyVersion: RESOURCE_TAXONOMY_VERSION,
    entries: [{ id: "x", name: "X", category: "fonts", source: "s", license: "" }],
  }), DesignMethodValidationError);
  assert.throws(() => normalizeRegistry({
    schemaVersion: DESIGN_METHOD_SCHEMA_VERSION,
    taxonomyVersion: "99",
    entries: [],
  }), DesignMethodValidationError);
  assert.throws(() => normalizeRegistry({
    schemaVersion: DESIGN_METHOD_SCHEMA_VERSION,
    taxonomyVersion: RESOURCE_TAXONOMY_VERSION,
    entries: [
      { id: "dup", name: "A", category: "fonts", source: "s", license: "MIT" },
      { id: "dup", name: "B", category: "icons", source: "s", license: "MIT" },
    ],
  }), DesignMethodValidationError);
});

test("oversized packs, snapshots, and registries fail closed", () => {
  const rules = Array.from({ length: 65 }, (_, index) => ({ id: `rule-${index}`, statement: "s", rationale: "r", severity: "minor" }));
  assert.throws(() => normalizeRulePack({ ...NINERR_MOBILE_METHOD_PACK, rules }), DesignMethodValidationError);
  const nodes = Array.from({ length: 2049 }, (_, index) => node({ id: `n${index}` }));
  assert.throws(() => normalizeSnapshot(snapshot(nodes)), DesignMethodValidationError);
  const entries = Array.from({ length: 2049 }, (_, index) => ({ id: `e${index}`, name: "N", category: "fonts", source: "s", license: "MIT" }));
  assert.throws(() => normalizeRegistry({ schemaVersion: DESIGN_METHOD_SCHEMA_VERSION, taxonomyVersion: RESOURCE_TAXONOMY_VERSION, entries }), DesignMethodValidationError);
});

test("deterministic serialization for identical inputs", () => {
  const pack = NINERR_MOBILE_METHOD_PACK;
  assert.equal(canonicalMethodStringify(pack), canonicalMethodStringify(JSON.parse(JSON.stringify(pack))));
  assert.equal(sha256Text("lilac").length, 64);
});

test("provenance pins both donors with licenses", () => {
  const donors = Object.fromEntries(DESIGN_METHOD_PROVENANCE.guidanceDonors.map((donor) => [donor.donor, donor]));
  assert.equal(donors["Appllama/appllama-skills"].revision, "dd5caaec3d5d50ad7fc0324da238119c6b7c3707");
  assert.equal(donors["Appllama/appllama-skills"].license, "MIT");
  assert.equal(donors["reinaldosimoes/design-resources"].revision, "43fe2b5d801e34c21e22b5639711f7e250a798e5");
  assert.equal(donors["reinaldosimoes/design-resources"].license, "CC0-1.0");
  assert.ok(RESOURCE_TAXONOMY_CATEGORIES.includes("fonts"));
});
