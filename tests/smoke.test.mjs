import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// P07 reproducible smoke test (#139): `npm run smoke` runs the offline core workflow and its
// report must be byte-identical across runs and equal to the committed expected report, so
// CI on a fresh runner proves it reproduces on another machine.

const SCRIPT = fileURLToPath(new URL("../scripts/smoke.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/smoke/expected-report.json", import.meta.url));
const EXPECTED = readFileSync(new URL("./fixtures/smoke/expected-report.json", import.meta.url), "utf8");

// Only what Node needs to find binaries and a temp directory on each platform.
const BASE_ENV = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR"].filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]]));
const run = (env = {}, cwd = undefined) => execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd, env: { ...BASE_ENV, ...env } });

test("the smoke workflow completes offline and reproduces the expected report exactly", () => {
  const first = run();
  // The second run differs in every ambient input the report must not depend on.
  const otherTmp = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-smoke-other-tmp-with-a-longer-name-")));
  let second;
  try {
    second = run({ TMPDIR: otherTmp, TZ: "Pacific/Kiritimati", LC_ALL: "tr_TR.UTF-8", LANG: "tr_TR.UTF-8" }, "/");
  } finally {
    rmSync(otherTmp, { recursive: true, force: true });
  }
  assert.equal(second, first, "two runs print identical reports");
  assert.equal(first, EXPECTED, "the report matches tests/fixtures/smoke/expected-report.json");
  const report = JSON.parse(first);
  assert.deepEqual(report.steps, ["create-edit", "undo-redo", "agent-edit", "import", "reopen", "code-round-trip"]);
  assert.equal(report.networkAttempts, 0);
  assert.deepEqual(Object.keys(report.projectFiles).filter((path) => !path.startsWith("objects/")), ["journal.log", "project.json", "snapshot.json"]);
});

test("npm run smoke runs the smoke script", () => {
  const npm = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(npm.scripts.smoke, "node scripts/smoke.mjs --expect tests/fixtures/smoke/expected-report.json");
  execFileSync(process.execPath, [SCRIPT, "--expect", FIXTURE], { encoding: "utf8", env: BASE_ENV });
});

test("--expect fails on a mismatch and works from any directory", () => {
  const options = { encoding: "utf8", cwd: "/", env: BASE_ENV, stdio: "pipe" };
  execFileSync(process.execPath, [SCRIPT, "--expect", "tests/fixtures/smoke/expected-report.json"], options);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-smoke-expect-")));
  try {
    const tampered = join(dir, "expected.json");
    writeFileSync(tampered, EXPECTED.replace(/"networkAttempts": 0/, '"networkAttempts": 1'));
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--expect", tampered], options), (error) => error.status === 1 && /differs from/.test(String(error.stderr)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--expect"], options), (error) => error.status === 2);
});
