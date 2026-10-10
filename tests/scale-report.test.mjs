import test from "node:test";
import assert from "node:assert/strict";

import { markdown, measureDeep, measureFlat, measureHistory, measureImport, measureWriteBack, platform } from "./support/scale.mjs";

// P08-G4 (#230, founder section P08.4): large projects, measured through the studio host at CI
// size, so every CI run reports what they cost on its platform (the full sizes run with
// `node tests/support/scale.mjs`). The numbers are printed, not judged: the budgets proposed
// from them are in docs/evidence/P08_G4_SCALE_2026-10-10.md, for the founder to accept at the
// P08 exit gate. The only checks here are ceilings well above what CI runners measure, so a
// collapse fails, while a slower runner does not.

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

  // Ceilings well above the times measured (docs/evidence/P08_G4_SCALE_2026-10-10.md, and the CI
  // runs on #269). An edit has two: its median, at about ten times the measured time, and its
  // p95, at three times that. With 10 to 30 samples, p95 is the slowest one or two, so a stall on
  // a busy runner can set it: a Windows run whose median edit 1,000 levels deep was itself slow
  // (111 ms, usually 10 to 19) gave a p95 of 618 ms. The looser p95 ceiling still fails edits
  // that are slow only some of the time, such as every fifth one stalling for seconds.
  const edit = (label, times, median) => {
    assert.ok(times.p50 < median, `${label}: p50 ${times.p50} ms (ceiling ${median})`);
    assert.ok(times.p95 < median * 3, `${label}: p95 ${times.p95} ms (ceiling ${median * 3})`);
  };
  edit("an edit on 1,000 layers", flat1k.editMs, 500);
  edit("an edit on 10,000 layers", flat10k.editMs, 3_000);
  assert.ok(flat10k.reopenMs < 3_000, `reopening 10,000 layers: ${flat10k.reopenMs} ms`);
  // Closing writes a checkpoint and syncs it to disk. On CI runners it usually takes 36–94 ms,
  // but one Windows run spent 1,018 ms on the checkpoint's disk sync alone (1,275 ms to close).
  // Like reopening, it gets 3 s, about 30 to 80 times its usual time: a slow disk is not a
  // collapse.
  assert.ok(flat10k.closeMs < 3_000, `closing 10,000 layers: ${flat10k.closeMs} ms`);
  edit("an edit 1,000 levels deep", deep.editMs, 500);
  assert.ok(history.crashReopenMs < 15_000, `recovering 100 edits after a crash: ${history.crashReopenMs} ms`);
  assert.ok(imported.reviewMs + imported.commitMs < 15_000, `importing ${imported.workload}: ${imported.reviewMs + imported.commitMs} ms`);
  assert.ok(writeBack.previewMs + writeBack.writeMs < 10_000, `a write-back: ${writeBack.previewMs + writeBack.writeMs} ms`);
});
