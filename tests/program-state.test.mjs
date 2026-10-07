import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The canonical program state (docs/CURRENT.md) must record every P06 quality gate the
// master plan defines, in plan order, and cite only evidence that exists in the repository.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function planGates() {
  const plan = read("docs/MASTER_PLAN.md");
  const section = plan.slice(plan.indexOf("### P06"), plan.indexOf("### P07"));
  return [...section.matchAll(/^- (.+?);?\.?$/gm)].map((match) => match[1].replace(/[;.]$/, ""));
}

test("the P06 record lists every master-plan gate in order", () => {
  const gates = planGates();
  assert.equal(gates.length, 11);
  const current = read("docs/CURRENT.md");
  const p06 = current.slice(current.indexOf("- P06 product hardening:"), current.indexOf("- Tooling during P06:"));
  const rows = [...p06.matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((match) => ({ number: Number(match[1]), gate: match[2].trim(), grains: match[3] }));
  assert.deepEqual(rows.map((row) => row.number), gates.map((_, index) => index + 1));
  for (const [index, row] of rows.entries()) {
    assert.equal(row.gate.toLowerCase(), gates[index].toLowerCase(), `gate ${row.number} is named as in the plan`);
    assert.match(row.grains, /#\d+ \u2192 #\d+ `[0-9a-f]{7}` \(\d+\/\d+\)/, `gate ${row.number} names an issue, PR, merge, and post-merge CI`);
  }
  assert.match(current, /\| P06 Product hardening \(11 gates\) \| CLOSED_CANONICAL \|/);
});

test("every repository path the program state cites exists", () => {
  const current = read("docs/CURRENT.md");
  const cited = [...current.matchAll(/`((?:docs|tests|scripts|packages)\/[^`\s]+)`/g)].map((match) => match[1]);
  assert.ok(cited.length > 0);
  for (const path of cited) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} does not exist`);
});
