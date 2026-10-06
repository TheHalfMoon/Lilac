import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalWorkspaceStringify } from "../packages/agent-workspace/src/index.ts";
import { canonicalArchitectureStringify } from "../packages/architecture/src/index.ts";
import { canonicalCodeIrStringify } from "../packages/code-ir/src/index.ts";
import { canonicalDecisionStringify } from "../packages/decision-router/src/index.ts";
import { canonicalDeliveryStringify, createEvidenceStore } from "../packages/delivery-governance/src/index.ts";
import { canonicalComponentsStringify } from "../packages/design-components/src/index.ts";
import { canonicalMethodStringify } from "../packages/design-method/src/index.ts";
import { canonicalVisualGitStringify } from "../packages/visual-git/src/index.ts";

const SERIALIZERS = {
  canonicalWorkspaceStringify,
  canonicalArchitectureStringify,
  canonicalCodeIrStringify,
  canonicalDecisionStringify,
  canonicalDeliveryStringify,
  canonicalComponentsStringify,
  canonicalMethodStringify,
  canonicalVisualGitStringify,
};

const SAMPLE = { z: [1, { y: null, x: "a" }], a: { c: { d: true }, b: 2.5 }, m: [], e: {} };
const EXPECTED = '{"a":{"b":2.5,"c":{"d":true}},"e":{},"m":[],"z":[1,{"x":"a","y":null}]}';

for (const [name, stringify] of Object.entries(SERIALIZERS)) {
  test(`${name} emits parseable key-sorted JSON`, () => {
    const text = stringify(SAMPLE);
    assert.equal(text, EXPECTED);
    assert.deepEqual(JSON.parse(text), SAMPLE);
    assert.equal(stringify(JSON.parse(text)), text);
  });
}

test("delivery evidence bundles written to disk parse as JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lilac-canonical-json-"));
  try {
    const store = await createEvidenceStore({ evidenceRoot: dir });
    const { path } = await store.writeBundle({
      qualificationId: "delivery-qualification:json01",
      candidateHead: "9e25bd787b2e874120f6183beea1dfe07b1afba4",
      createdAt: "2026-10-06T00:00:00.000Z",
      records: [],
      askUserRequests: [],
    });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.equal(parsed.qualificationId, "delivery-qualification:json01");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
