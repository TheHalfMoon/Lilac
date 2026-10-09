import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostPool, ok } from "./support/host-api.mjs";
import { createPrng, positiveIntegerFromEnv, propertySeeds } from "./support/prng.mjs";

// P08-G2b (#230, founder section P08.2): source-linked editing as a state machine. One
// component is brought in from a file; then, in a generated order, the person changes its
// fields in Ninerr, someone changes them in the file, the person previews and writes back
// (or marks fields as matching, #234), undoes and redoes, writes with a plan the file or
// Ninerr has since outdated, and reopens the project in a new host. A model keeps, for every
// field, the value both last agreed on (the base), Ninerr's value and the file's, and predicts
// each preview exactly: what is a change, what is matched, what is a conflict, what is not
// written. After every step the host's layers and bases must be the model's, and the file
// must be byte for byte what the model says it is. NINERR_MACHINE_RUNS sets the number of
// seeds (default 4), NINERR_MACHINE_STEPS the steps per seed (default 80).

const RUNS = positiveIntegerFromEnv("NINERR_MACHINE_RUNS", 4);
const STEPS = positiveIntegerFromEnv("NINERR_MACHINE_STEPS", 80);
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();

const text = (value) => value.replace(/&/gu, "&amp;");
const attribute = (value) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
/** The file for these field values, as the test writes it and as a write-back must leave it. */
const render = (values) => `export function PriceCard() {
  return (
    <section className="${attribute(values.cls)}" style="${attribute(values.style)}">
      <h2>${text(values.h2)}</h2>
      <p title="${attribute(values.title)}">${text(values.p)}</p>
    </section>
  );
}
`;

// Each field: the layer it is on (by tag), its name in a plan, and the values either side may
// give it. A text with { or < is never written back as JSX text, so only Ninerr gives it. The
// styles include the same declarations in two orders, which are equal.
const FIELDS = {
  cls: { tag: "section", field: "className", values: ["card", "card wide", "box"] },
  style: { tag: "section", field: "style", values: ["padding: 16px", "padding: 8px", "margin: 4px", "padding: 8px; margin: 4px", "margin: 4px; padding: 8px", "padding: 16px; margin: 2px"], ninerrOnly: ["padding: 4px; margin: 8px", "margin: 6px; padding: 2px"] },
  h2: { tag: "h2", field: "text", values: ["Pro", "Team", "Fish & Chips", "Équipe"], ninerrOnly: ["a < b"] },
  title: { tag: "p", field: "title", values: ["Plan", "Plan B", "R&D \"x\""] },
  p: { tag: "p", field: "text", values: ["Everything in Free.", "All of it", "Prix: 12 €"], ninerrOnly: ["{oops}"] },
};
const START = { cls: "card", style: "padding: 16px; margin: 2px", h2: "Pro", title: "Plan", p: "Everything in Free." };
const parseStyle = (value) => Object.fromEntries(value.split(";").map((part) => part.split(":").map((piece) => piece.trim())).filter(([name]) => name));
const styleText = (style) => Object.entries(style).map(([name, value]) => `${name}: ${value}`).join("; ");
/** Two values of a field are the same: a style by its declarations, in any order. */
function same(key, a, b) {
  if (key !== "style") return a === b;
  const [left, right] = [parseStyle(a), parseStyle(b)];
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([name, value]) => right[name] === value);
}
/**
 * What a write leaves in the file for a changed field: Ninerr's value, and for a style its
 * declarations in the file's own order, with new ones after (in the layer's order, sorted).
 */
function writtenValue(key, file, mine) {
  if (key !== "style") return mine;
  const style = parseStyle(mine);
  const order = Object.keys(parseStyle(file));
  const names = [...order.filter((name) => Object.hasOwn(style, name)), ...Object.keys(style).sort().filter((name) => !order.includes(name))];
  return names.map((name) => `${name}: ${style[name]}`).join("; ");
}

/** A field's value on its layer, as Ninerr holds it. */
function layerValue(node, key) {
  if (key === "cls") return node.props.attributes?.class;
  if (key === "title") return node.props.attributes?.title;
  if (key === "style") return styleText(node.props.style ?? {});
  return node.props.text;
}
/** A field's base, as the layer's code source records it. */
function baseValue(node, key) {
  const { base } = node.props.codeSource;
  if (key === "h2" || key === "p") return base.text;
  return base.props[FIELDS[key].field];
}
/** The set-props that gives a field `value` on its layer. */
function setField(node, key, value) {
  if (key === "cls") return { attributes: { ...node.props.attributes, class: value } };
  if (key === "title") return { attributes: { ...node.props.attributes, title: value } };
  if (key === "style") return { style: parseStyle(value) };
  return { text: value };
}

/** What a preview must say of each field, from the model. */
function predict(fields) {
  const plan = { changes: [], matched: [], conflicts: [], notWritten: [] };
  for (const key of Object.keys(FIELDS)) {
    const { base, mine, file } = fields[key];
    if (same(key, mine, base)) continue;
    if (same(key, file, mine)) plan.matched.push(key);
    else if (!same(key, file, base)) plan.conflicts.push(key);
    else if ((key === "h2" || key === "p") && /[{}<>]/u.test(mine)) plan.notWritten.push(key);
    else plan.changes.push(key);
  }
  return plan;
}

/** The file a plan would leave, and the fields it would mark with their values: what its token names. */
function planIdentity(fields) {
  const expected = predict(fields);
  const after = render(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, expected.changes.includes(name) ? writtenValue(name, field.file, field.mine) : field.file])));
  return { expected, key: JSON.stringify([after, expected.matched.map((name) => [name, fields[name].file]).sort()]) };
}

async function runMachine(seed, root, pool) {
  const prng = createPrng(seed);
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const card = join(code, "Card.jsx");
  writeFileSync(card, render(START));
  let running = await pool.open(projects);
  await ok(running.call("POST", "/api/projects/create", { name: "linked" }), "create");
  await ok(running.call("POST", "/api/codebase/connect", { folder: code }), "connect");
  await ok(running.call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" }), "bring in");
  const imported = (await ok(running.call("GET", "/api/document"), "document")).document;
  const layer = Object.fromEntries(["section", "h2", "p"].map((tag) => [tag, Object.values(imported.nodes).find((node) => node.props.tag === tag).id]));
  const model = { fields: Object.fromEntries(Object.entries(START).map(([key, value]) => [key, { base: value, mine: value, file: value }])), undo: [], redo: [] };
  const fileValues = () => Object.fromEntries(Object.entries(model.fields).map(([key, field]) => [key, field.file]));
  const tally = {};
  const count = (what) => {
    tally[what] = (tally[what] ?? 0) + 1;
  };
  const editField = async (key, value) => {
    const { revision, document } = await ok(running.call("GET", "/api/document"), "document");
    const node = document.nodes[layer[FIELDS[key].tag]];
    await ok(running.call("POST", "/api/edit", { baseRevision: revision, intent: `Set ${key}`, operations: [{ type: "set-props", nodeId: node.id, set: setField(node, key, value) }] }), `set ${key}`);
  };
  const changeInNinerr = async (key, value) => {
    await editField(key, value);
    model.undo.push({ key, from: model.fields[key].mine, to: value });
    model.redo = [];
    model.fields[key].mine = value;
  };
  const fieldOf = (entry) => Object.keys(FIELDS).find((key) => layer[FIELDS[key].tag] === entry.nodeId && FIELDS[key].field === entry.field);
  /** The text field an entry not written is about, or its reason when it is anything else. */
  const notWrittenField = (entry) => {
    if (!/\{ \} < or >/u.test(entry.reason)) return entry.reason;
    return entry.nodeId === layer.h2 ? "h2" : "p";
  };
  /** Preview: exactly the plan the model predicts, and nothing written. */
  const previewChecked = async (step) => {
    const plan = await ok(running.call("POST", "/api/codebase/preview", { nodeId: layer.section }), "preview");
    const expected = predict(model.fields);
    const named = (entries) => entries.map(fieldOf).sort();
    assert.deepEqual(named(plan.changes), [...expected.changes].sort(), `step ${step}: the changes`);
    assert.deepEqual(named(plan.matched), [...expected.matched].sort(), `step ${step}: the matched fields`);
    assert.deepEqual(named(plan.conflicts), [...expected.conflicts].sort(), `step ${step}: the conflicts`);
    assert.deepEqual(plan.notWritten.map(notWrittenField).sort(), [...expected.notWritten].sort(), `step ${step}: what is not written, and why`);
    assert.equal(plan.diff === "", expected.changes.length === 0, `step ${step}: a diff exactly when there are changes`);
    assert.equal(readFileSync(card, "utf8"), render(fileValues()), "previewing writes nothing");
    if (expected.notWritten.length > 0) count("preview with a text not written");
    return { plan, expected };
  };
  /** A write the host accepted: exactly the expected changes and marks, applied to the model. */
  const applyWrite = (written, expected) => {
    assert.equal(written.status, 200, JSON.stringify(written.json));
    assert.deepEqual([written.json.written, written.json.matched], [expected.changes.length, expected.matched.length]);
    for (const changed of expected.changes) {
      const field = model.fields[changed];
      // A style is written in the file's order, not the layer's (which keeps its keys sorted).
      if (changed === "style" && writtenValue(changed, field.file, field.mine) !== styleText(Object.fromEntries(Object.entries(parseStyle(field.mine)).sort()))) count("style written in the file's own order");
      field.file = writtenValue(changed, field.file, field.mine);
      field.base = field.file;
    }
    for (const agreed of expected.matched) model.fields[agreed].base = model.fields[agreed].file;
  };

  const check = async (step, action) => {
    const where = `seed ${seed}, step ${step} (${action})`;
    const { nodes } = (await ok(running.call("GET", "/api/document"), "document")).document;
    for (const key of Object.keys(FIELDS)) {
      const node = nodes[layer[FIELDS[key].tag]];
      assert.ok(same(key, layerValue(node, key), model.fields[key].mine), `${where}: Ninerr's ${key} is ${JSON.stringify(layerValue(node, key))}, the model's ${JSON.stringify(model.fields[key].mine)}`);
      assert.equal(baseValue(node, key), model.fields[key].base, `${where}: the base of ${key}`);
      assert.equal(node.props.codeSource.pending, undefined, `${where}: nothing is pending`);
    }
    assert.equal(readFileSync(card, "utf8"), render(fileValues()), `${where}: the file`);
  };

  for (let step = 0; step < STEPS; step += 1) {
    // With something to redo, the person sometimes redoes it, after whatever happened meanwhile.
    let roll = prng.next();
    if (model.redo.length > 0 && roll < 0.2) roll = 0.93;
    const key = prng.pick(Object.keys(FIELDS));
    let action;
    if (roll < 0.3) {
      // The person changes a field in Ninerr.
      action = `ninerr ${key}`;
      const value = prng.pick([...FIELDS[key].values, ...(FIELDS[key].ninerrOnly ?? [])]);
      if (value === model.fields[key].mine) continue;
      await changeInNinerr(key, value);
      count("edit in Ninerr");
    } else if (roll < 0.5) {
      // Someone changes a field in the file.
      action = `file ${key}`;
      model.fields[key].file = prng.pick(FIELDS[key].values);
      writeFileSync(card, render(fileValues()));
      count("edit in the file");
    } else if (roll < 0.75) {
      // Preview, then write: exactly the predicted plan, and the file exactly as predicted.
      action = "preview and write";
      const { plan, expected } = await previewChecked(step);
      const written = await running.call("POST", "/api/codebase/write", { nodeId: layer.section, token: plan.token });
      if (expected.changes.length === 0 && expected.matched.length === 0) {
        assert.deepEqual([written.status, written.json.error.code], [409, "nothing-to-write"]);
        count(expected.conflicts.length > 0 ? "write refused: only conflicts" : "write refused: nothing to write");
      } else {
        applyWrite(written, expected);
        count(expected.changes.length > 0 ? "write" : "mark as matching");
        if (expected.conflicts.length > 0) count("write beside a conflict");
        if (expected.changes.includes("style") || expected.matched.includes("style")) count("style written or matched");
      }
    } else if (roll < 0.82) {
      // A plan the file has outdated since is refused, and writes nothing.
      action = "stale plan";
      const { plan } = await previewChecked(step);
      model.fields[key].file = prng.pick(FIELDS[key].values.filter((candidate) => candidate !== model.fields[key].file));
      writeFileSync(card, render(fileValues()));
      // The plan names the file's bytes, which changed: refused before anything else is decided.
      const written = await running.call("POST", "/api/codebase/write", { nodeId: layer.section, token: plan.token });
      assert.deepEqual([written.status, written.json.error.code], [409, "plan-changed"], JSON.stringify(written.json));
      count("stale plan refused");
    } else if (roll < 0.86) {
      // A field changed in Ninerr after the preview: the old plan is refused exactly when what it
      // would write, or the fields it would mark, changed; otherwise it writes what was previewed.
      action = `stale plan, ninerr ${key}`;
      const { plan } = await previewChecked(step);
      const previewed = planIdentity(model.fields);
      await changeInNinerr(key, prng.pick([...FIELDS[key].values, ...(FIELDS[key].ninerrOnly ?? [])].filter((candidate) => candidate !== model.fields[key].mine)));
      const current = planIdentity(model.fields);
      const written = await running.call("POST", "/api/codebase/write", { nodeId: layer.section, token: plan.token });
      if (previewed.key !== current.key) {
        assert.deepEqual([written.status, written.json.error.code], [409, "plan-changed"], JSON.stringify(written.json));
        count("stale plan refused after an edit in Ninerr");
      } else if (current.expected.changes.length === 0 && current.expected.matched.length === 0) {
        assert.deepEqual([written.status, written.json.error.code], [409, "nothing-to-write"]);
        count("plan still current after an edit in Ninerr, nothing to write");
      } else {
        applyWrite(written, current.expected);
        count("plan still current after an edit in Ninerr, written");
      }
    } else if (roll < 0.92) {
      action = "undo";
      const entry = model.undo.at(-1);
      if (entry === undefined) continue;
      await ok(running.call("POST", "/api/undo"), "undo");
      model.undo.pop();
      model.redo.push(entry);
      model.fields[entry.key].mine = entry.from;
      count("undo");
    } else if (roll < 0.95) {
      action = "redo";
      const entry = model.redo.at(-1);
      if (entry === undefined) continue;
      await ok(running.call("POST", "/api/redo"), "redo");
      model.redo.pop();
      model.undo.push(entry);
      model.fields[entry.key].mine = entry.to;
      count("redo");
    } else {
      // Close, and reopen in a new host: bases persist; undo is per session.
      action = "reopen";
      await ok(running.call("POST", "/api/projects/close"), "close");
      await running.host.close();
      running = await pool.open(projects);
      await ok(running.call("POST", "/api/projects/open", { name: "linked" }), "reopen");
      model.undo = [];
      model.redo = [];
      count("reopen");
    }
    await check(step, action);
  }
  return tally;
}

test("source-linked editing as a state machine: previews, writes, matching, conflicts and reopens agree with a three-way model", async (t) => {
  const totals = {};
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-writeback-machine-")));
      const pool = hostPool(now);
      try {
        const tally = await runMachine(seed, root, pool);
        for (const [what, times] of Object.entries(tally)) totals[what] = (totals[what] ?? 0) + times;
      } finally {
        await pool.closeAll();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  t.diagnostic(`transitions: ${JSON.stringify(totals)}`);
  // Only for a full run, not a replayed seed.
  if (seeds.length >= 4 && STEPS >= 80) {
    for (const what of ["edit in Ninerr", "edit in the file", "write", "mark as matching", "write beside a conflict", "style written or matched", "style written in the file's own order", "write refused: only conflicts", "write refused: nothing to write", "preview with a text not written", "stale plan refused", "stale plan refused after an edit in Ninerr", "plan still current after an edit in Ninerr, written", "undo", "redo", "reopen"]) {
      assert.ok((totals[what] ?? 0) > 0, `the sessions include at least one ${what}`);
    }
  }
});
