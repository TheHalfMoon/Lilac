import test from "node:test";
import assert from "node:assert/strict";

import { positiveIntegerFromEnv } from "./support/prng.mjs";
import { platform, soak } from "./support/soak.mjs";

// P08-G5 (#230, founder section P08.5): a soak at CI size. The session in
// tests/support/soak.mjs keeps its size steady, so its latency, its heap after a full
// collection and its open resources should hold steady too; once it closes, it must leave
// nothing running and nothing on disk but the project's own files; and the same seed must
// end in the same document. The long run is `node tests/support/soak.mjs`, recorded in
// docs/evidence/P08_G5_SOAK_2026-10-10.md. NINERR_SOAK_ROUNDS sets the rounds here.

const ROUNDS = positiveIntegerFromEnv("NINERR_SOAK_ROUNDS", 600);
const SEED = 230_005;
const PROJECT_FILE = /^(?:\.ninerr-agents\.json|\.ninerr-codebases\.json|soak\/|soak\/\.ninerr\/(?:|journal\.log|project\.json|snapshot\.json|objects\/|objects\/[0-9a-f]{2}\/(?:[0-9a-f]{62})?))$/u;

test("a long session holds steady, leaves nothing behind, and ends the same from the same seed", { timeout: 900_000 }, async (t) => {
  assert.ok(ROUNDS >= 200, "NINERR_SOAK_ROUNDS must be at least 200: the first window is a warm-up, compared with none");
  const first = await soak({ rounds: ROUNDS, seed: SEED, window: 100 });
  t.diagnostic(`${platform()}, ${ROUNDS} rounds: ${JSON.stringify(first.tally)}`);
  for (const window of first.windows) t.diagnostic(JSON.stringify(window));

  // The first window warms up (modules load, caches fill); later windows are compared with the
  // second. At CI size these are tripwires for a gross regression, not measures of slow drift:
  // the long run in the evidence is what shows that.
  const [, early] = first.windows;
  const late = first.windows.at(-1);
  assert.ok(late.editMs <= Math.max(2 * early.editMs, early.editMs + 25), `edit latency drifted: ${early.editMs} ms to ${late.editMs} ms`);
  assert.ok(late.heapMiB <= early.heapMiB + 16, `the heap after a full collection grew: ${early.heapMiB} MiB to ${late.heapMiB} MiB`);
  assert.ok(late.resources <= early.resources, `open resources grew: ${early.resources} to ${late.resources}`);

  assert.ok(first.streamed > 0, "the editor's event stream carried the session's changes");
  // Closed, the hosts leave nothing running, and on disk only the project's own files.
  assert.deepEqual(first.left.resourcesAfter, first.left.resourcesBefore, "what is running after every host closed");
  for (const path of first.left.projectFiles) assert.match(path, PROJECT_FILE, "nothing but the project's own files");
  assert.deepEqual(first.left.codeFiles, ["Notice.jsx"], "write-back leaves no temporary file in the codebase");

  // The same seed again: the same actions, the same outcomes, the same document.
  const second = await soak({ rounds: ROUNDS, seed: SEED, window: 100 });
  assert.deepEqual(second.tally, first.tally, "the same actions and outcomes");
  assert.deepEqual(second.document, first.document, "the same document");
  const disk = (run) => run.windows.map(({ round, layers, journalKiB, objectsKiB }) => ({ round, layers, journalKiB, objectsKiB }));
  assert.deepEqual(disk(second), disk(first), "the same layers, journal and objects at every window");
});
