import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// P07d (#187): the release workflow's trust boundaries. Repository and dependency code runs
// only in jobs that cannot sign or write; the jobs that sign and publish run on pushed tags
// only, run no repository code, publish only a draft, and create no tag.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const release = read(".github/workflows/release.yml");

/** The workflow's jobs, each as its own block of text (two-space indented keys under `jobs:`). */
function jobs(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const result = {};
  for (const block of body.split(/^(?=  [a-z][a-z-]*:$)/m)) {
    const name = /^  ([a-z][a-z-]*):$/m.exec(block)?.[1];
    if (name) result[name] = block;
  }
  return result;
}

const TAG_ONLY = "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
const all = jobs(release);

test("the release workflow has its five jobs, in their order of trust", () => {
  assert.deepEqual(Object.keys(all), ["build", "desktop", "collect", "attest", "publish"]);
  assert.match(all.desktop, /^    uses: \.\/\.github\/workflows\/desktop\.yml$/m, "the release reuses the Desktop workflow");
  assert.match(read(".github/workflows/desktop.yml"), /^  workflow_call:$/m);
  assert.match(all.collect, /^    needs: \[build, desktop\]$/m);
  // The build runs the full gate, so it sets up the desktop shell's tests exactly as CI does.
  const ci = read(".github/workflows/ci.yml");
  for (const step of ["run: node scripts/fetch-electron.mjs", "run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0", "npm run check 2>&1 | tee check.log"]) {
    assert.ok(ci.includes(step) && all.build.includes(step), `build runs "${step}" as CI does`);
  }
  assert.match(all.attest, /^    needs: collect$/m);
  assert.match(all.publish, /^    needs: attest$/m);
  assert.match(release, /^permissions:\n  contents: read\n/m, "every job reads only, unless it says otherwise");
});

test("only tag pushes sign or publish, and those jobs run no repository code", () => {
  for (const name of ["attest", "publish"]) {
    assert.ok(all[name].includes(TAG_ONLY), `${name} runs for pushed tags only`);
    assert.doesNotMatch(all[name], /actions\/checkout|actions\/setup-node|\bnpm\b|\bnode\b/, `${name} runs no repository or dependency code`);
  }
  assert.doesNotMatch(all.collect, /actions\/checkout|actions\/setup-node|\bnpm\b|\bnode\b/, "collect runs no repository or dependency code");
  for (const name of ["build", "desktop", "collect"]) assert.ok(!all[name].includes("if: github.event_name"), `${name} runs on every trigger`);
});

test("signing and writing are each granted to one job", () => {
  const granted = (permission) => Object.keys(all).filter((name) => new RegExp(`^      ${permission}$`, "m").test(all[name]));
  assert.deepEqual(granted("id-token: write"), ["attest"]);
  assert.deepEqual(granted("attestations: write"), ["attest"]);
  assert.deepEqual(granted("contents: write"), ["publish"]);
  assert.doesNotMatch(release.replace(/^ *#.*$/gm, ""), /write-all|permissions: write/);
});

test("the release is a draft for an existing tag, and every collected file is signed", () => {
  assert.match(all.publish, /gh release create "\$TAG" out\/\* --repo "\$GITHUB_REPOSITORY" --draft --verify-tag/);
  assert.doesNotMatch(release, /git tag|git push|gh release edit|--draft=false|gh api/);
  assert.match(all.attest, /subject-path: \|\n {12}dist\/release\/\*\*\n {12}dist\/out\/\*\n/);
  for (const target of ["linux-x64", "darwin-arm64", "win32-x64"]) assert.ok(all.collect.includes(target), `collect checks the ${target} archive`);
  assert.match(all.collect, /if \[ "\$count" -ne 7 \]/, "collect refuses a set missing any file");
});

test("a pull request that changes the release path runs the unsigned pipeline", () => {
  const on = release.slice(release.indexOf("\non:\n"), release.indexOf("\npermissions:"));
  assert.match(on, /^  pull_request:\n    paths:\n/m);
  for (const path of [".github/workflows/release.yml", ".github/workflows/desktop.yml", "scripts/release-bundle.mjs", "scripts/package-desktop.mjs", "scripts/fetch-electron.mjs"]) {
    assert.ok(on.includes(`      - ${path}\n`), `a change to ${path} runs the release workflow`);
  }
});
