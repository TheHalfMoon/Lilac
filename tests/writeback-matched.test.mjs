import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStudioHost } from "../packages/studio-host/src/index.ts";

// A field changed both here and in the file is a conflict until the two agree again. Once
// they do, nothing needs writing, but the field's base must move to the agreed value, or every
// later change to it would conflict forever. Found by P08-G1's Journey C (#230).

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();
const CARD = `export function PriceCard() {
  return (
    <section className="card" style="padding: 16px">
      <h2>Pro</h2>
    </section>
  );
}
`;

test("a conflict resolved by taking the file's value is marked as matching, and later changes write back", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-matched-")));
  const projects = join(root, "projects");
  const code = join(root, "code");
  mkdirSync(projects);
  mkdirSync(code);
  const card = join(code, "Card.jsx");
  writeFileSync(card, CARD);
  const host = await startStudioHost({ projectsRoot: projects, now });
  const call = async (method, path, body) => {
    const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  try {
    await call("POST", "/api/projects/create", { name: "app" });
    await call("POST", "/api/codebase/connect", { folder: code });
    await call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" });
    const nodes = () => Object.values(host.session.document.nodes);
    const section = nodes().find((node) => node.props.tag === "section");
    const h2 = nodes().find((node) => node.props.tag === "h2");
    const edit = (set, nodeId = h2.id) => call("POST", "/api/edit", { baseRevision: host.session.revision, intent: "Edit", operations: [{ type: "set-props", nodeId, set }] });
    const preview = async () => (await call("POST", "/api/codebase/preview", { nodeId: section.id })).json;

    // Changed both here and in the file: a conflict.
    await edit({ text: "Here" });
    await edit({ style: { padding: "24px" } }, section.id);
    writeFileSync(card, CARD.replace("<h2>Pro</h2>", "<h2>Outside</h2>").replace("padding: 16px", "padding: 24px"));
    let plan = await preview();
    assert.deepEqual(plan.conflicts.map((conflict) => conflict.field), ["text"]);
    assert.deepEqual(plan.matched.map((entry) => entry.field), ["style"], "the style already agrees");

    // The person takes the file's text: both fields now agree; nothing to write, two to mark.
    await edit({ text: "Outside" });
    plan = await preview();
    // A plan to mark is stale once the file changes, like any other.
    const original = readFileSync(card, "utf8");
    writeFileSync(card, `${original}\n`);
    const stale = await call("POST", "/api/codebase/write", { nodeId: section.id, token: plan.token });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "plan-changed");
    writeFileSync(card, original);
    // And once the fields to mark change: the plan names exactly the fields it marks.
    await edit({ text: "Here" });
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: plan.token })).json.error.code, "plan-changed");
    await edit({ text: "Outside" });
    plan = await preview();
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.matched.map((entry) => `${entry.field}=${entry.value}`).sort(), ["style=padding: 24px", "text=Outside"]);
    assert.equal(plan.diff, "");
    const before = readFileSync(card, "utf8");
    const marked = await call("POST", "/api/codebase/write", { nodeId: section.id, token: plan.token });
    assert.equal(marked.status, 200, JSON.stringify(marked.json));
    assert.equal(marked.json.written, 0);
    assert.equal(marked.json.matched, 2);
    assert.equal(marked.json.intent, "Mark 2 fields as matching Card.jsx");
    assert.equal(readFileSync(card, "utf8"), before, "the file is not touched");
    assert.equal(host.session.document.nodes[h2.id].props.codeSource.base.text, "Outside", "the base moved to the agreed value");
    assert.equal(host.session.canUndo(), true, "the person's own edits stay undoable");
    assert.deepEqual((await preview()).matched, [], "nothing is left to mark");
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: (await preview()).token })).json.error.code, "nothing-to-write");

    // A later change to the field is a change again, not a conflict, and is written.
    await edit({ text: "Final" });
    plan = await preview();
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.changes.map((change) => `${change.field}:${change.from}->${change.to}`), ["text:Outside->Final"]);
    assert.equal((await call("POST", "/api/codebase/write", { nodeId: section.id, token: plan.token })).status, 200);
    assert.match(readFileSync(card, "utf8"), /<h2>Final<\/h2>/u);
    assert.match(readFileSync(card, "utf8"), /padding: 24px/u);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
