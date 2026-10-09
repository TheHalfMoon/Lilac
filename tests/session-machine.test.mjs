import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateDocument } from "../packages/document-model/src/index.mjs";
import { hostPool, mcpClient, ok } from "./support/host-api.mjs";
import { createPrng, propertySeeds } from "./support/prng.mjs";
import { applyOperations, generatedEdit, shape } from "./support/reference-model.mjs";

// P08-G2a (#230, founder section P08.2): the studio session as a state machine. A person (the
// editor's HTTP API) and an agent (MCP) act on one project in a generated order: edits, the
// agent's tools (deletions the person approves or declines), undo and redo per actor, the
// person reverting the agent's latest change, stale edits, checkpoints, and reopening in a new
// host. A reference model (tests/support/reference-model.mjs), with its own undo stacks and
// inverses, predicts every outcome: what is accepted, what is refused (an invalid edit, an undo
// another actor's change has made inapplicable), and the document after it. After every step
// the host must agree with it on the document, the revision and whether the person can undo
// or redo. NINERR_MACHINE_RUNS sets the number of seeds (default 4), NINERR_MACHINE_STEPS the
// steps per seed (default 120); NINERR_PROPERTY_SEED=<seed> replays one.

const positive = (name, fallback) => {
  const text = process.env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/u.test(text)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(text)}`);
  return Number(text);
};
const RUNS = positive("NINERR_MACHINE_RUNS", 4);
const STEPS = positive("NINERR_MACHINE_STEPS", 120);
const MAX_UNDO = 200; // the host's per-actor undo depth
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();

/** The model's view of the session: the document, the revision, and each actor's stacks. */
function createModel(document, revision) {
  return { doc: shape(document), revision, person: { undo: [], redo: [] }, agent: { undo: [] } };
}

const push = (stack, entry) => {
  stack.push(entry);
  if (stack.length > MAX_UNDO) stack.shift();
};

/** The operations an agent tool makes, computed from the model as the tool documents them. */
function agentOperations(model, name, args, result) {
  const value = result.structuredContent;
  switch (name) {
    case "create_frame":
      return [{ type: "insert-node", node: { id: value.nodeId, type: "frame", props: { tag: "main", style: { position: "relative", width: `${args.width}px`, height: `${args.height}px`, background: "#ffffff" }, name: args.name } }, parentId: null, index: model.doc.rootIds.length }];
    case "set_text":
      return [{ type: "set-props", nodeId: args.nodeId, set: { text: args.text } }];
    case "rename_layers":
      return args.renames.map(({ nodeId, name }) => (name === "" ? { type: "set-props", nodeId, set: {}, unset: ["name"] } : { type: "set-props", nodeId, set: { name } }));
    case "set_styles":
      return args.updates.map(({ nodeId, styles }) => {
        const style = { ...model.doc.nodes[nodeId].props.style };
        for (const [property, change] of Object.entries(styles)) {
          if (change === null) delete style[property];
          else style[property] = change;
        }
        return { type: "set-props", nodeId, set: { style } };
      });
    case "move_layers":
      return args.moves.map(({ nodeId, parentId, index }) => ({ type: "move-node", nodeId, parentId, ...(index === undefined ? {} : { index }) }));
    case "duplicate_layers": {
      // Only leaves are duplicated here, so the copy's id is the one the tool returns.
      const [original] = args.nodeIds;
      const node = model.doc.nodes[original];
      const siblings = node.parentId === null ? model.doc.rootIds : model.doc.nodes[node.parentId].children;
      const copy = value.copies[original];
      return [{ type: "restore-subtree", rootId: copy, parentId: node.parentId, index: siblings.indexOf(original) + 1, nodes: [{ id: copy, type: node.type, parentId: node.parentId, children: [], props: structuredClone(node.props) }] }];
    }
    case "delete_layers":
      return args.nodeIds.map((nodeId) => ({ type: "remove-node", nodeId }));
    default:
      throw new Error(`no model for ${name}`);
  }
}

/** A generated agent tool call against the model's document. */
function agentCall(prng, model, prefer) {
  const ids = Object.keys(model.doc.nodes);
  const preferred = prefer.filter((id) => Object.hasOwn(model.doc.nodes, id));
  const leaves = ids.filter((id) => model.doc.nodes[id].children.length === 0);
  const kinds = ids.length === 0 ? ["create_frame"] : ["create_frame", "set_text", "rename_layers", "set_styles", "move_layers", "duplicate_layers", "delete_layers", "delete_layers"];
  const name = prng.pick(kinds);
  const any = () => (preferred.length > 0 && prng.next() < 0.5 ? prng.pick(preferred) : prng.pick(ids));
  switch (name) {
    case "create_frame":
      return { name, args: { name: `Agent ${prng.int(0, 999)}`, width: prng.int(10, 900), height: prng.int(10, 900) } };
    case "set_text":
      return { name, args: { nodeId: any(), text: prng.pick(["Agent text", "نص", "🙂", ""]) } };
    case "rename_layers":
      return { name, args: { renames: [{ nodeId: any(), name: prng.pick(["Agent name", ""]) }] } };
    case "set_styles":
      return { name, args: { updates: [{ nodeId: any(), styles: { color: prng.pick(["#abcdef", null]), margin: prng.pick(["2px", null]) } }] } };
    case "move_layers": {
      const index = prng.pick([undefined, 0, 1, 50]);
      return { name, args: { moves: [{ nodeId: any(), parentId: prng.next() < 0.3 ? null : any(), ...(index === undefined ? {} : { index }) }] } };
    }
    case "duplicate_layers":
      return { name, args: { nodeIds: [prng.pick(leaves)] } };
    default:
      return { name, args: { nodeIds: [any()] } };
  }
}

/** One seed: a session of `STEPS` generated actions, the model checked after each. */
async function runMachine(seed, root, pool) {
  const prng = createPrng(seed);
  let running = await pool.open(root);
  await ok(running.call("POST", "/api/projects/create", { name: "machine" }), "create");
  const { token } = await ok(running.call("POST", "/api/agents/create", { name: "Machine agent" }), "connect an agent");
  let agent = mcpClient(running.host.mcpUrl, token);
  await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "machine", version: "1" } });
  const start = await ok(running.call("GET", "/api/document"), "document");
  const model = createModel(start.document, start.revision);
  const counter = { next: 0, prefix: "p" };
  // What each actor changed last, so the other's next change often meets it.
  const touched = { person: [], agent: [] };
  // Kept in the model's order: the host sorts layers by id, and the agent's ids are random, so
  // picking in the host's order would make a seed's run differ from one run to the next.
  const touch = (actor, ids) => {
    const changed = new Set(ids);
    touched[actor] = [...Object.keys(model.doc.nodes).filter((id) => changed.has(id)), ...touched[actor]].slice(0, 8);
  };
  // The agent's changes from before a reopen, which can no longer be reverted.
  const lost = [];
  let agentMetPerson = false;
  let personMetAgent = false;
  // Layers the person's last undo changed: the agent sometimes deletes one, which a redo then meets.
  let undone = [];
  const tally = {};
  const count = (what) => {
    tally[what] = (tally[what] ?? 0) + 1;
  };

  const check = async (step, action) => {
    const where = `seed ${seed}, step ${step} (${action})`;
    const { revision, document } = await ok(running.call("GET", "/api/document"), "document");
    validateDocument(document);
    assert.equal(revision, model.revision, `${where}: revision`);
    assert.deepEqual(shape(document), model.doc, `${where}: the host's document is the model's`);
    const session = await ok(running.call("GET", "/api/session"), "session");
    assert.deepEqual([session.canUndo, session.canRedo], [model.person.undo.length > 0, model.person.redo.length > 0], `${where}: what the person can undo and redo`);
  };

  for (let step = 0; step < STEPS; step += 1) {
    // Where conflicts come from, steered toward: right after the agent changed what the person
    // just changed (or undid), the person often redoes or undoes; right after the person changed
    // what the agent just changed, the person often reverts the agent's change.
    let roll = prng.next();
    if (agentMetPerson && model.person.redo.length > 0 && roll < 0.3) roll = 0.45;
    else if (agentMetPerson && model.person.undo.length > 0 && roll < 0.5) roll = 0.3;
    else if (personMetAgent && model.agent.undo.length > 0 && roll < 0.4) roll = 0.85;
    else if (model.person.redo.length > 0 && roll < 0.15) roll = 0.45;
    agentMetPerson = false;
    personMetAgent = false;
    let action;
    if (roll < 0.24) {
      // The person edits.
      action = "edit";
      const { revision } = await ok(running.call("GET", "/api/document"), "document");
      // Generated from the model (the same document, as check() asserts), in its order. Now and
      // then it removes a layer the agent's latest change made or changed, which a revert meets.
      const latest = (model.agent.undo.at(-1)?.affected ?? []).filter((id) => Object.hasOwn(model.doc.nodes, id));
      const edit = latest.length > 0 && prng.next() < 0.15
        ? { intent: "Remove the agent's layer", operations: [{ type: "remove-node", nodeId: prng.pick(latest) }] }
        : generatedEdit(prng, { nodes: model.doc.nodes }, counter, touched.agent);
      const expected = applyOperations(model.doc, edit.operations);
      const result = await running.call("POST", "/api/edit", { baseRevision: revision, ...edit });
      assert.equal(result.status, expected === null ? 400 : 200, `${edit.intent}: ${JSON.stringify(result.json)}`);
      if (expected === null) count("edit refused");
      else {
        count("edit");
        model.doc = expected.model;
        model.revision += 1;
        push(model.person.undo, { transactionId: result.json.transactionId, operations: edit.operations, inverse: expected.inverse });
        model.person.redo = [];
        personMetAgent = result.json.affectedNodeIds.some((id) => touched.agent.includes(id));
        touch("person", result.json.affectedNodeIds);
      }
    } else if (roll < 0.40) {
      // The person undoes their last change, or finds another actor's change has made it inapplicable.
      action = "undo";
      const entry = model.person.undo.at(-1);
      const expected = entry === undefined ? null : applyOperations(model.doc, entry.inverse);
      const result = await running.call("POST", "/api/undo");
      if (entry === undefined) {
        assert.deepEqual([result.status, result.json.error.code], [409, "nothing-to-undo"]);
        count("undo, nothing to undo");
      } else if (expected === null) {
        assert.deepEqual([result.status, result.json.error.code], [409, "undo-conflict"], JSON.stringify(result.json));
        count("undo conflict");
      } else {
        assert.equal(result.status, 200, JSON.stringify(result.json));
        assert.equal(result.json.undoOf, entry.transactionId);
        count("undo");
        model.doc = expected.model;
        model.revision += 1;
        model.person.undo.pop();
        push(model.person.redo, entry);
        touch("person", result.json.affectedNodeIds);
        undone = Object.keys(model.doc.nodes).filter((id) => result.json.affectedNodeIds.includes(id));
      }
    } else if (roll < 0.52) {
      action = "redo";
      const entry = model.person.redo.at(-1);
      const expected = entry === undefined ? null : applyOperations(model.doc, entry.operations);
      const result = await running.call("POST", "/api/redo");
      if (entry === undefined) {
        assert.deepEqual([result.status, result.json.error.code], [409, "nothing-to-redo"]);
        count("redo, nothing to redo");
      } else if (expected === null) {
        assert.deepEqual([result.status, result.json.error.code], [409, "redo-conflict"], JSON.stringify(result.json));
        count("redo conflict");
      } else {
        assert.equal(result.status, 200, JSON.stringify(result.json));
        assert.equal(result.json.redoOf, entry.transactionId);
        count("redo");
        model.doc = expected.model;
        model.revision += 1;
        model.person.redo.pop();
        push(model.person.undo, { transactionId: result.json.transactionId, operations: entry.operations, inverse: expected.inverse });
        touch("person", result.json.affectedNodeIds);
      }
    } else if (roll < 0.83) {
      // The agent calls a tool; a deletion waits for the person, who approves or declines it.
      const stillThere = undone.filter((id) => Object.hasOwn(model.doc.nodes, id));
      const { name, args } = stillThere.length > 0 && prng.next() < 0.5 ? { name: "delete_layers", args: { nodeIds: [prng.pick(stillThere)] } } : agentCall(prng, model, touched.person);
      undone = [];
      action = `agent ${name}`;
      let decision = null;
      const pending = agent.tool(name, args);
      pending.catch(() => {}); // awaited below; a failed assertion first must not leave it unhandled
      if (name === "delete_layers") {
        decision = prng.next() < 0.7;
        let waiting = [];
        for (const deadline = Date.now() + 10_000; waiting.length === 0 && Date.now() < deadline;) {
          ({ pending: waiting } = await ok(running.call("GET", "/api/confirmations"), "confirmations"));
          if (waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(waiting.length, 1, "the deletion asks the person");
        await ok(running.call("POST", "/api/confirmations/decide", { id: waiting[0].id, approve: decision }), "decide");
      }
      const result = await pending;
      if (decision === false) {
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /declined/u);
        count("agent deletion declined");
      } else {
        // Ids of a frame or copy the tool makes are only known from its result.
        const operations = result.isError ? null : agentOperations(model, name, args, result);
        const expected = operations === null ? null : applyOperations(model.doc, operations);
        if (result.isError) {
          // Refused: the model must refuse what the tool would have done, too. The model
          // accepts every frame and copy, and generates only moves that can be refused.
          assert.ok(name !== "create_frame" && name !== "duplicate_layers", `${name} ${JSON.stringify(args)} was refused: ${result.content[0].text}`);
          assert.equal(applyOperations(model.doc, agentOperations(model, name, args, { structuredContent: {} })), null, `${name} ${JSON.stringify(args)} was refused: ${result.content[0].text}`);
          assert.equal(name, "move_layers", `only a move is refused: ${result.content[0].text}`);
          assert.match(result.content[0].text, /subtree|index/u, "refused for the reason the model refuses it");
          count(`agent ${name} refused`);
        } else {
          assert.notEqual(expected, null, `${name} ${JSON.stringify(args)} was accepted, but the model refuses it`);
          count(`agent ${name}`);
          model.doc = expected.model;
          model.revision += 1;
          const affected = Object.keys(expected.model.nodes).filter((id) => result.structuredContent.affectedNodeIds.includes(id));
          push(model.agent.undo, { transactionId: result.structuredContent.transactionId, operations, inverse: expected.inverse, affected });
          agentMetPerson = result.structuredContent.affectedNodeIds.some((id) => touched.person.includes(id));
          touch("agent", result.structuredContent.affectedNodeIds);
        }
      }
    } else if (roll < 0.91) {
      // The person reverts the agent's latest change, or tries an earlier one, which is refused.
      action = "revert";
      const latest = model.agent.undo.at(-1);
      const earlier = model.agent.undo.at(-2);
      if (earlier !== undefined && prng.next() < 0.2) {
        const refused = await running.call("POST", "/api/revert", { transactionId: earlier.transactionId });
        assert.deepEqual([refused.status, refused.json.error.code], [409, "not-revertible"]);
        count("revert of an earlier change refused");
      } else if (latest !== undefined) {
        const expected = applyOperations(model.doc, latest.inverse);
        const result = await running.call("POST", "/api/revert", { transactionId: latest.transactionId });
        if (expected === null) {
          assert.deepEqual([result.status, result.json.error.code], [409, "revert-conflict"], JSON.stringify(result.json));
          count("revert conflict");
        } else {
          assert.equal(result.status, 200, JSON.stringify(result.json));
          assert.equal(result.json.revertOf, latest.transactionId);
          count("revert");
          model.doc = expected.model;
          model.revision += 1;
          model.agent.undo.pop();
          push(model.person.undo, { transactionId: result.json.transactionId, operations: latest.inverse, inverse: expected.inverse });
          model.person.redo = [];
          touch("person", result.json.affectedNodeIds);
        }
      } else if (lost.length > 0) {
        // Nothing of the agent's in this session: one from before the reopen is refused (#231).
        const refused = await running.call("POST", "/api/revert", { transactionId: prng.pick(lost) });
        assert.deepEqual([refused.status, refused.json.error.code], [409, "not-revertible"]);
        count("revert from before a reopen refused");
      } else {
        count("revert, nothing to revert");
      }
    } else if (roll < 0.95) {
      // An edit based on an earlier revision is refused, never rebased.
      action = "stale edit";
      if (model.revision === 0) continue;
      const stale = await running.call("POST", "/api/edit", { baseRevision: model.revision - 1, intent: "Stale", operations: [{ type: "insert-node", node: { id: `stale-${step}`, type: "frame", props: {} }, parentId: null }] });
      assert.deepEqual([stale.status, stale.json.error.code], [409, "stale-revision"]);
      count("stale edit refused");
    } else if (roll < 0.98) {
      action = "checkpoint";
      await ok(running.call("POST", "/api/checkpoint"), "checkpoint");
      count("checkpoint");
    } else {
      // Close, and reopen in a new host: the document and revision persist; undo stacks are per session.
      action = "reopen";
      await ok(running.call("POST", "/api/projects/close"), "close");
      await running.host.close();
      running = await pool.open(root);
      await ok(running.call("POST", "/api/projects/open", { name: "machine" }), "reopen");
      agent = mcpClient(running.host.mcpUrl, token);
      await agent.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "machine", version: "1" } });
      lost.push(...model.agent.undo.map((entry) => entry.transactionId));
      model.person = { undo: [], redo: [] };
      model.agent = { undo: [] };
      count("reopen");
    }
    await check(step, action);
  }
  return tally;
}

test("the session as a state machine: a person and an agent, undo, redo, revert, checkpoints and reopens agree with a reference model", async (t) => {
  const totals = {};
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-machine-")));
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
  // The generated sessions reached the states that matter, not only the easy ones.
  t.diagnostic(`transitions: ${JSON.stringify(totals)}`);
  // Only for a full run, not a replayed seed.
  if (seeds.length >= 4 && STEPS >= 120) {
    for (const what of ["edit", "edit refused", "undo", "undo conflict", "redo", "redo conflict", "agent create_frame", "agent move_layers refused", "agent delete_layers", "agent deletion declined", "revert", "revert conflict", "revert of an earlier change refused", "revert from before a reopen refused", "stale edit refused", "reopen", "checkpoint"]) {
      assert.ok((totals[what] ?? 0) > 0, `the sessions include at least one ${what}`);
    }
  }
});
