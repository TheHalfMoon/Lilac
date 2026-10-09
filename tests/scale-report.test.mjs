import test from "node:test";
import assert from "node:assert/strict";

import { markdown, measureDeep, measureFlat, measureHistory, measureImport, measureWriteBack, platform } from "./support/scale.mjs";

// P08-G4 (#230, founder section P08.4): large projects, measured through the studio host at CI
// size, so every CI run reports what they cost on its platform (the full sizes run with
// `node tests/support/scale.mjs`). The numbers are printed, not judged: the budgets proposed
// from them are in docs/evidence/P08_G4_SCALE_2026-10-10.md, for the founder to accept at the
// P08 exit gate. The only checks here are ceilings at about ten times what was measured, so
// a collapse fails, while a slower runner does not.

test("large projects through the host: measured and reported", { timeout: 600_000 }, async (t) => {
  const results = [];
  const flat1k = await measureFlat(1_000);
  const flat10k = await measureFlat(10_000, { edits: 15 });
  const deep = await measureDeep(1_000);
  const history = await measureHistory(1_000, 100);
  const imported = await measureImport(8_000);
  const writeBack = await measureWriteBack(4_000);
  results.push(flat1k, flat10k, deep, history, imported, writeBack);
  t.diagnostic(`\n${markdown({ platform: platform(), results })}`);

  // Ceilings at about ten times the times measured on Windows (docs/evidence/P08_G4_SCALE_2026-10-10.md).
  assert.ok(flat1k.editMs.p95 < 500, `an edit on 1,000 layers: p95 ${flat1k.editMs.p95} ms`);
  assert.ok(flat10k.editMs.p95 < 3_000, `an edit on 10,000 layers: p95 ${flat10k.editMs.p95} ms`);
  assert.ok(flat10k.reopenMs < 3_000, `reopening 10,000 layers: ${flat10k.reopenMs} ms`);
  assert.ok(flat10k.closeMs < 1_000, `closing 10,000 layers: ${flat10k.closeMs} ms`);
  assert.ok(deep.editMs.p95 < 500, `an edit 1,000 levels deep: p95 ${deep.editMs.p95} ms`);
  assert.ok(history.crashReopenMs < 15_000, `recovering 100 edits after a crash: ${history.crashReopenMs} ms`);
  assert.ok(imported.reviewMs + imported.commitMs < 15_000, `importing ${imported.workload}: ${imported.reviewMs + imported.commitMs} ms`);
  assert.ok(writeBack.previewMs + writeBack.writeMs < 10_000, `a write-back: ${writeBack.previewMs + writeBack.writeMs} ms`);
});
