import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// P07 reproducible smoke test (#139): `npm run smoke` runs the offline core workflow and its
// report must be byte-identical across runs and equal to the committed expected report, so
// CI on a fresh runner proves it reproduces on another machine.

const SCRIPT = new URL("../scripts/smoke.mjs", import.meta.url).pathname;
const EXPECTED = readFileSync(new URL("./fixtures/smoke/expected-report.json", import.meta.url), "utf8");

const run = () => execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

test("the smoke workflow completes offline and reproduces the expected report exactly", () => {
  const first = run();
  const second = run();
  assert.equal(second, first, "two runs print identical reports");
  assert.equal(first, EXPECTED, "the report matches tests/fixtures/smoke/expected-report.json");
  const report = JSON.parse(first);
  assert.deepEqual(report.steps, ["create-edit", "undo-redo", "agent-edit", "import", "reopen", "code-round-trip"]);
  assert.equal(report.networkAttempts, 0);
  assert.deepEqual(Object.keys(report.projectFiles).filter((path) => !path.startsWith("objects/")), ["journal.log", "project.json", "snapshot.json"]);
});

test("npm run smoke runs the smoke script", () => {
  const npm = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(npm.scripts.smoke, "node scripts/smoke.mjs");
});
