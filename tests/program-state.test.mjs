import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The canonical program state (docs/CURRENT.md) must record every P06 quality gate the
// master plan defines, in plan order, and cite only evidence that exists in the repository.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function planGates() {
  const plan = read("docs/MASTER_PLAN.md");
  const start = plan.indexOf("### P06");
  const section = plan.slice(start, plan.indexOf("\n### ", start + 1));
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

function productCompletionGates() {
  const plan = read("docs/MASTER_PLAN.md");
  const section = plan.slice(plan.indexOf("### PC "), plan.indexOf("### P07"));
  return [...section.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => ({ number: Number(match[1]), text: match[2] }));
}

test("the PC record mirrors every master-plan Product Completion gate in order", () => {
  const gates = productCompletionGates();
  assert.equal(gates.length, 17);
  const current = read("docs/CURRENT.md");
  const pc = current.slice(current.indexOf("- PC Product Completion:"), current.indexOf("Grain plan"));
  const rows = [...pc.matchAll(/^\| (\d+) \| ([^|]+) \| ([A-Z_]+) \|$/gm)].map((match) => ({ number: Number(match[1]), gate: match[2].trim(), state: match[3] }));
  assert.deepEqual(rows.map((row) => row.number), gates.map((gate) => gate.number));
  for (const [index, row] of rows.entries()) {
    assert.ok(gates[index].text.toLowerCase().startsWith(row.gate.toLowerCase()), `PC gate ${row.number} "${row.gate}" names the plan gate "${gates[index].text.slice(0, 60)}"`);
    assert.equal(row.state, "CLOSED_CANONICAL", `PC gate ${row.number} is closed, as the phase is`);
  }
});

test("each PC gate has exactly one closing grain in the plan", () => {
  const current = read("docs/CURRENT.md");
  assert.match(current, /\| PC Product completion \(17 gates\) \| CLOSED_CANONICAL \|/);
  assert.match(current, /- PC Product Completion: \*\*CLOSED_CANONICAL\*\*/);
  assert.match(current, /\| P07 Release \| ACTIVE \|/);
  const start = current.indexOf("Grain plan.");
  const plan = current.slice(start, current.indexOf(". PC-L:", start));
  const closers = new Map();
  for (const [, grain, list] of plan.matchAll(/(PC\d+): .*\(closes ([\d, ]+)[;)]/g)) {
    for (const gate of list.split(",").map((value) => Number(value.trim()))) {
      assert.ok(!closers.has(gate), `PC gate ${gate} is closed by both ${closers.get(gate)} and ${grain}`);
      closers.set(gate, grain);
    }
  }
  assert.deepEqual([...closers.keys()].sort((a, b) => a - b), Array.from({ length: 17 }, (_, index) => index + 1));
});
