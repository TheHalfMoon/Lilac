import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { createDocument } from "../packages/document-model/src/index.mjs";
import {
  DESIGN_ASSURANCE_SCHEMA_VERSION,
  DesignAssuranceError,
  IMPECCABLE_PIN,
  createRulePack,
  normalizeImpeccableFinding,
  scanBrowserSnapshot,
  scanBrowserUrl,
  scanDocument,
  scanSourceText,
  scanStaticHtml,
} from "../packages/design-assurance/src/index.mjs";

const require = createRequire(import.meta.url);

function upstreamFinding(overrides = {}) {
  return {
    antipattern: "nested-cards",
    name: "Nested cards",
    description: "Avoid redundant nested containers.",
    severity: "warning",
    category: "layout",
    file: "temporary-target.tsx",
    line: 7,
    snippet: "<Card><Card /></Card>",
    ...overrides,
  };
}

function documentWithBrokenBindings() {
  return createDocument({
    id: "doc-assurance",
    name: "Assurance fixture",
    metadata: {
      sources: {
        "src-known": { path: "src/App.tsx" },
      },
      designSystem: {
        tokens: {
          "color.primary": "#000000",
        },
      },
    },
    nodes: [
      {
        id: "root",
        type: "frame",
        parentId: null,
        children: ["target", "binding", "token"],
      },
      {
        id: "target",
        type: "element",
        parentId: "root",
      },
      {
        id: "binding",
        type: "source-binding",
        parentId: "root",
        props: {
          sourceId: "src-missing",
          targetNodeId: "ghost",
          range: { start: 8, end: 3 },
        },
      },
      {
        id: "token",
        type: "token-reference",
        parentId: "root",
        props: { tokenId: "color.missing" },
      },
    ],
  });
}

test("pins the exact Impeccable donor and runtime versions", () => {
  assert.equal(IMPECCABLE_PIN.revision, "e103efe779e2dd01274dabae83531fef00bf2563");
  assert.equal(IMPECCABLE_PIN.packageVersion, "4.1.0");
  assert.equal(IMPECCABLE_PIN.sourceEngineVersion, "0.1.11");
  assert.equal(IMPECCABLE_PIN.engineVersion, "0.1.5");
  assert.equal(IMPECCABLE_PIN.license, "Apache-2.0");
});

test("installed Impeccable runtime matches the recorded package and engine pin", () => {
  const packageJson = JSON.parse(readFileSync(require.resolve("impeccable/package.json"), "utf8"));
  assert.equal(packageJson.version, IMPECCABLE_PIN.packageVersion);
  const osName = process.platform === "win32" ? "windows" : process.platform;
  const platformPackage = `@impeccable/cli-${osName}-${process.arch}`;
  assert.equal(packageJson.optionalDependencies[platformPackage], IMPECCABLE_PIN.engineVersion);
});

test("local rule evidence must be JSON-serializable", async () => {
  const badPack = createRulePack({
    namespace: "bad-evidence",
    rules: [{
      id: "bigint",
      title: "Bad evidence",
      severity: "warning",
      surfaces: ["browser-snapshot"],
      check: () => [{ evidence: { value: 1n } }],
    }],
  });
  await assert.rejects(
    scanBrowserSnapshot({ snapshot: {}, rulePacks: [badPack] }),
    /evidence must be JSON-serializable/,
  );
});

test("normalizes upstream findings into the Ninerr contract", () => {
  const finding = normalizeImpeccableFinding(upstreamFinding({ severity: "advisory" }), {
    surface: "source",
    virtualPath: "src/App.tsx",
  });
  assert.equal(finding.ruleId, "impeccable/nested-cards");
  assert.equal(finding.severity, "info");
  assert.equal(finding.originalSeverity, "advisory");
  assert.equal(finding.location.path, "src/App.tsx");
  assert.equal(finding.provenance.revision, IMPECCABLE_PIN.revision);
  assert.equal(finding.fixability, "manual");
});

test("rule packs reserve the upstream namespace and reject duplicate ids", () => {
  const rule = {
    id: "example-rule",
    title: "Example",
    severity: "warning",
    surfaces: ["source"],
    check: () => [],
  };
  assert.throws(
    () => createRulePack({ namespace: "impeccable", rules: [rule] }),
    DesignAssuranceError,
  );
  assert.throws(
    () => createRulePack({ namespace: "demo", rules: [rule, rule] }),
    /duplicate rule id/,
  );
});

test("runtime rejects a manually constructed pack using the reserved upstream namespace", async () => {
  await assert.rejects(
    scanBrowserSnapshot({
      snapshot: {},
      rulePacks: [{
        namespace: "impeccable",
        rules: [{
          id: "impersonation",
          title: "Impersonation",
          severity: "warning",
          surfaces: ["browser-snapshot"],
          check: () => [],
        }],
      }],
    }),
    /reserved rule pack namespace/,
  );
});

test("source adapter accepts the upstream CSS-family extension set", async () => {
  const report = await scanSourceText({
    content: "body { font-family: Arial; }",
    filePath: "styles/theme.scss",
  });
  assert.equal(report.surface, "source");
  assert.equal(report.subject.path, "styles/theme.scss");
  assert.ok(report.findings.some((finding) => finding.ruleId === "impeccable/overused-font"));
});

test("source adapter hides temporary paths and is deterministic", async () => {
  const targets = [];
  const runner = {
    async scanTarget(target) {
      targets.push(target);
      assert.equal(existsSync(target), true);
      return {
        exitCode: 2,
        stderr: "",
        findings: [
          upstreamFinding({ file: target }),
          upstreamFinding({ file: target }),
        ],
      };
    },
  };
  const input = {
    content: "export const Card = () => <div />;",
    filePath: "src/Card.tsx",
    runner,
  };
  const first = await scanSourceText(input);
  const second = await scanSourceText(input);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, DESIGN_ASSURANCE_SCHEMA_VERSION);
  assert.equal(first.surface, "source");
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0].location.path, "src/Card.tsx");
  assert.equal(first.summary.active, 1);
  assert.equal(existsSync(targets[0]), false);
  assert.equal(existsSync(targets[1]), false);
});

test("pinned Impeccable runtime scans static HTML locally", async () => {
  const report = await scanStaticHtml({
    html: '<html><body><div style="font-family: Arial">Hello</div></body></html>',
    filePath: "fixtures/arial.html",
  });
  assert.equal(report.surface, "static-html");
  assert.equal(report.subject.path, "fixtures/arial.html");
  assert.ok(report.findings.some((finding) => finding.ruleId === "impeccable/overused-font"));
  assert.ok(report.findings.every((finding) => finding.location.path === "fixtures/arial.html"));
});

test("malformed untrusted HTML is parsed as data rather than executed", async () => {
  const report = await scanStaticHtml({
    html: '<html><body><script>throw new Error("must-not-run")</script><div><span>',
    filePath: "fixtures/malformed.html",
  });
  assert.equal(report.surface, "static-html");
  assert.ok(Array.isArray(report.findings));
});

test("browser adapter uses the shared report contract and protects private targets", async () => {
  const calls = [];
  const runner = {
    async scanTarget(target, options) {
      calls.push({ target, options });
      return {
        exitCode: 2,
        stderr: "",
        findings: [upstreamFinding({ file: target, line: 0 })],
      };
    },
  };
  const report = await scanBrowserUrl({
    url: "https://example.com/demo",
    viewport: { width: 390, height: 844 },
    runner,
    // No real DNS in tests: a public answer for the pre-scan resolution check.
    lookup: async () => [{ address: "93.184.215.14", family: 4 }],
  });
  assert.equal(report.surface, "browser");
  assert.equal(report.findings[0].location.url, "https://example.com/demo");
  assert.equal(calls[0].options.viewport.width, 390);
  await assert.rejects(
    scanBrowserUrl({ url: "http://127.0.0.1:3000", runner }),
    /allowPrivateNetwork/,
  );
  await assert.rejects(
    scanBrowserUrl({ url: "http://[::1]:3000", runner }),
    /allowPrivateNetwork/,
  );
  await assert.rejects(
    scanBrowserUrl({ url: "http://[fd00::1]:3000", runner }),
    /allowPrivateNetwork/,
  );
  await assert.rejects(
    scanBrowserUrl({ url: "https://user:secret@example.com", runner }),
    /must not contain credentials/,
  );
});

test("browser snapshot seam normalizes upstream and Ninerr rule-pack findings", async () => {
  const snapshotPack = createRulePack({
    namespace: "snapshot-test",
    rules: [{
      id: "empty-page",
      title: "Snapshot should contain elements",
      severity: "warning",
      surfaces: ["browser-snapshot"],
      check: ({ snapshot }) => snapshot.elements.length === 0
        ? [{ message: "Snapshot has no elements", evidence: { count: 0 } }]
        : [],
    }],
  });
  const report = await scanBrowserSnapshot({
    snapshot: { elements: [] },
    upstreamFindings: [upstreamFinding({ file: "https://example.com" })],
    rulePacks: [snapshotPack],
  });
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId).sort(),
    ["impeccable/nested-cards", "snapshot-test/empty-page"],
  );
  assert.ok(report.findings.every((finding) => finding.surface === "browser-snapshot"));
});

test("malformed snapshots fail before any runner is invoked", async () => {
  let invoked = false;
  const runner = {
    async scanSnapshot() {
      invoked = true;
      return { findings: [] };
    },
  };
  const circular = {};
  circular.self = circular;
  await assert.rejects(scanBrowserSnapshot({ snapshot: circular, runner }), /JSON-serializable/);
  await assert.rejects(
    scanBrowserSnapshot({ snapshot: { elements: {} }, runner }),
    /snapshot.elements must be an array/,
  );
  assert.equal(invoked, false);
});

test("document rules catch source-binding and token-registry drift deterministically", () => {
  const report = scanDocument({ document: documentWithBrokenBindings() });
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    [
      "ninerr/source-binding-range",
      "ninerr/source-binding-source-id",
      "ninerr/source-binding-target",
      "ninerr/token-reference-resolution",
    ],
  );
  assert.equal(report.summary.active, 4);
  assert.equal(report.summary.bySeverity.error, 4);
  assert.ok(report.findings.every((finding) => finding.invariant));
});

test("document token-registry shape is an explicit invariant", () => {
  const document = createDocument({
    id: "doc-token-registry",
    metadata: { designSystem: { tokens: [] } },
    nodes: [{ id: "root", type: "frame" }],
  });
  const report = scanDocument({ document });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].ruleId, "ninerr/design-token-registry");
});

test("policy cannot silently disable or downgrade structural invariants", () => {
  const document = documentWithBrokenBindings();
  assert.throws(
    () => scanDocument({
      document,
      policy: { disabledRules: ["ninerr/source-binding-target"] },
    }),
    /cannot be disabled/,
  );
  assert.throws(
    () => scanDocument({
      document,
      policy: { severityOverrides: { "ninerr/source-binding-target": "warning" } },
    }),
    /cannot be severity-downgraded/,
  );
  assert.throws(
    () => scanDocument({
      document,
      policy: { waivers: [{ ruleId: "ninerr/source-binding-target", reason: "migration" }] },
    }),
    /acknowledgeInvariant/,
  );
});

test("explicit invariant waivers remain visible in the report", () => {
  const report = scanDocument({
    document: documentWithBrokenBindings(),
    policy: {
      waivers: [{
        ruleId: "ninerr/source-binding-target",
        reason: "known migration fixture",
        acknowledgeInvariant: true,
      }],
    },
  });
  const finding = report.findings.find((item) => item.ruleId === "ninerr/source-binding-target");
  assert.equal(finding.policy.waived, true);
  assert.equal(finding.policy.waiverReason, "known migration fixture");
  assert.equal(report.summary.waived, 1);
  assert.equal(report.summary.total, 4);
});

test("non-invariant upstream rules can be explicitly suppressed without disappearing", async () => {
  const runner = {
    async scanTarget(target) {
      return { exitCode: 2, stderr: "", findings: [upstreamFinding({ file: target })] };
    },
  };
  const report = await scanSourceText({
    content: "export const x = 1;",
    filePath: "src/example.tsx",
    runner,
    policy: { disabledRules: ["impeccable/nested-cards"] },
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].policy.suppressed, true);
  assert.equal(report.summary.suppressed, 1);
  assert.equal(report.summary.active, 0);
});
