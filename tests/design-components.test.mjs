import test from "node:test";
import assert from "node:assert/strict";

import { buildCodeIr } from "../packages/code-ir/src/index.ts";
import {
  DESIGN_COMPONENTS_PROVENANCE,
  DESIGN_COMPONENTS_SCHEMA_VERSION,
  DesignComponentsDriftError,
  DesignComponentsValidationError,
  applyVariant,
  bindContract,
  canonicalComponentsStringify,
  detectDrift,
  normalizeContract,
  normalizeSystem,
  previewComponent,
  sha256Text,
  systemHas,
} from "../packages/design-components/src/index.ts";

const SOURCE = `export function Badge() {
  return (
    <span tone="neutral" count={0}>
      <icon name="dot" />
      New
    </span>
  );
}
`;

function ir(content = SOURCE) {
  return buildCodeIr([{ path: "Badge.jsx", content }]);
}

function contract(overrides = {}) {
  return {
    schemaVersion: DESIGN_COMPONENTS_SCHEMA_VERSION,
    contractId: "contract-badge-1",
    componentName: "Badge",
    sourceFile: "Badge.jsx",
    props: [
      { name: "tone", propType: { kind: "enum", values: ["neutral", "accent"] }, required: true },
      { name: "count", propType: { kind: "number" }, required: true },
    ],
    slots: [{ name: "glyph", tag: "icon", required: true }],
    states: ["hover", "active"],
    variants: [
      { name: "accent", props: { tone: "accent" } },
      { name: "zero", props: { count: 0 }, minWidth: 0, maxWidth: 640 },
    ],
    ...overrides,
  };
}

test("binding succeeds for matching shapes", () => {
  const bound = bindContract(ir(), contract());
  assert.equal(bound.componentName, "Badge");
  assert.equal(bound.sourceFile, "Badge.jsx");
  assert.deepEqual(bound.boundProps, { tone: "neutral", count: 0 });
  assert.ok(bound.range.startOffset < bound.range.endOffset);
});

test("binding fails with reasons for shape mismatches", () => {
  assert.throws(() => bindContract(ir(), contract({ componentName: "Chip" })), DesignComponentsDriftError);
  assert.throws(() => bindContract(ir(), contract({
    props: [
      { name: "tone", propType: { kind: "number" }, required: true },
      { name: "count", propType: { kind: "number" }, required: true },
    ],
  })), /violates its declared type/u);
  assert.throws(() => bindContract(ir(), contract({
    props: [
      { name: "tone", propType: { kind: "enum", values: ["neutral", "accent"] }, required: true },
      { name: "count", propType: { kind: "number" }, required: true },
      { name: "missing", propType: { kind: "string" }, required: true },
    ],
  })), /missing from/u);
  assert.throws(() => bindContract(ir(), contract({ slots: [] })), /declares 0 slots/u);
  assert.throws(() => bindContract(ir(), contract({ slots: [{ name: "glyph", tag: "svg", required: true }] })), /expects <svg>/u);
  assert.throws(() => bindContract(ir("<span>nope</span>"), contract()), DesignComponentsDriftError);
});

test("variants apply through verified patches and change only targeted props", () => {
  const live = ir();
  const bound = bindContract(live, contract());
  const result = applyVariant(live, [{ path: "Badge.jsx", content: SOURCE }], bound, contract(), "accent");
  assert.equal(result.applied, 1);
  assert.ok(result.files[0].content.includes('tone="accent"'));
  assert.ok(result.files[0].content.includes("count={0}"));
  assert.ok(!result.files[0].content.includes('tone="neutral"'));
  const again = applyVariant(live, [{ path: "Badge.jsx", content: SOURCE }], bound, contract(), "zero");
  assert.equal(again.applied, 0);
});

test("drifted contracts refuse updates", () => {
  const live = ir();
  const bound = bindContract(live, contract());
  const drifted = `export function Badge() {
  return (
    <span tone="wild" count={0}>
      <icon name="dot" />
      New
    </span>
  );
}
`;
  const driftedIr = ir(drifted);
  assert.throws(() => applyVariant(driftedIr, [{ path: "Badge.jsx", content: drifted }], bound, contract(), "accent"), /refused/u);
});

test("drift detection reports each drift class", () => {
  const live = ir();
  assert.deepEqual(detectDrift(live, contract()), []);
  const renamed = `export function Chip() {
  return (
    <span tone="neutral" count={0}>
      <icon name="dot" />
      New
    </span>
  );
}
`;
  assert.ok(detectDrift(ir(renamed), contract()).some((drift) => drift.kind === "missing-symbol"));
  const renamedIr = ir(renamed);
  const chipId = Object.values(renamedIr.symbols).find((symbol) => symbol.name === "Chip").id;
  assert.ok(detectDrift(renamedIr, contract(), chipId).some((drift) => drift.kind === "renamed-symbol"));
  const retyped = SOURCE.replace('tone="neutral"', "tone={7}");
  assert.ok(detectDrift(ir(retyped), contract()).some((drift) => drift.kind === "type-changed"));
  const offEnum = SOURCE.replace('tone="neutral"', 'tone="wild"');
  assert.ok(detectDrift(ir(offEnum), contract()).some((drift) => drift.kind === "enum-violated"));
  const extra = SOURCE.replace("count={0}", 'count={0} extra="yes"');
  assert.ok(detectDrift(ir(extra), contract()).some((drift) => drift.kind === "extra-prop"));
  const noSlot = `export function Badge() {
  return (
    <span tone="neutral" count={0}>
      New
    </span>
  );
}
`;
  const slotDrifts = detectDrift(ir(noSlot), contract());
  assert.ok(slotDrifts.some((drift) => drift.kind === "missing-slot" || drift.kind === "extra-slot"));
});

test("previews carry live source ranges", () => {
  const live = ir();
  const bound = bindContract(live, contract());
  const preview = previewComponent(live, bound, contract());
  assert.equal(preview.componentName, "Badge");
  assert.equal(preview.symbolId, bound.symbolId);
  assert.equal(preview.sourceRange.file, "Badge.jsx");
  assert.equal(preview.doc.root.tag, "span");
  assert.equal(preview.doc.root.props.tone, "neutral");
});

test("systems validate membership", () => {
  const system = {
    schemaVersion: DESIGN_COMPONENTS_SCHEMA_VERSION,
    systemId: "system-1",
    name: "Core",
    contracts: [contract(), contract({ contractId: "contract-2", componentName: "Chip", sourceFile: "Chip.jsx", props: [], slots: [], variants: [] })],
    tokens: ["space.4", "color.accent"],
  };
  const normalized = normalizeSystem(system);
  assert.equal(normalized.contracts.length, 2);
  assert.equal(systemHas(system, "contract-badge-1"), true);
  assert.equal(systemHas(system, "contract-missing"), false);
  assert.throws(() => normalizeSystem({ ...system, contracts: [contract(), contract()] }), DesignComponentsValidationError);
});

test("malformed contracts fail closed", () => {
  assert.throws(() => normalizeContract({ ...contract(), props: "nope" }), DesignComponentsValidationError);
  assert.throws(() => normalizeContract({ ...contract(), variants: [{ name: "bad", props: { unknown: 1 } }] }), /unknown prop/u);
  assert.throws(() => normalizeContract({ ...contract(), variants: [{ name: "bad", props: {}, minWidth: 900, maxWidth: 100 }] }), /inverted/u);
  assert.throws(() => normalizeContract({ ...contract(), states: ["hover", "hover"] }), DesignComponentsValidationError);
  assert.throws(() => normalizeContract({ schemaVersion: 999 }), DesignComponentsValidationError);
});

test("deterministic serialization for identical inputs", () => {
  assert.equal(canonicalComponentsStringify(contract()), canonicalComponentsStringify(JSON.parse(JSON.stringify(contract()))));
  assert.equal(sha256Text("ninerr").length, 64);
});

test("provenance marks the package as project-owned", () => {
  assert.equal(DESIGN_COMPONENTS_PROVENANCE.package, "@ninerr/design-components");
});
