import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeDocument, validateDocument } from "../packages/document-model/src/index.mjs";
import { hostPool, ok } from "./support/host-api.mjs";
import { createPrng, positiveIntegerFromEnv, propertySeeds } from "./support/prng.mjs";

// P08-G3b (#230, founder section P08.3): the studio host's requests and MCP calls under
// generated hostile input. A host runs a project with content, a connected codebase and a
// component brought in from it, and an agent. Then, in a generated order, the API routes (and
// unknown ones, and the wrong method) receive generated bodies: JSON of every shape, with the
// routes' own keys, prototype keys, hostile strings and numbers, ids the host gave out
// earlier (previews, proposals, transactions, confirmations, agents), plausible edits, deeply
// nested JSON that is valid, and raw bodies that are not JSON or not UTF-8; and the MCP
// endpoint receives generated JSON-RPC messages and tool calls. Whatever comes in:
// - the host never answers 500, and every refusal names a typed error;
// - a refusal changes nothing: the project stays open, the document and its revision, the
//   agents and the connected codebase stay as they were;
// - the host stays healthy and the document valid after every request;
// - closing and reopening gives back exactly the document the session held, and the source
//   file is untouched.
// NINERR_FUZZ_RUNS sets the number of seeds (default 4) and NINERR_FUZZ_CASES the requests
// per seed (default 120); NINERR_PROPERTY_SEED=<seed> replays one seed.

const RUNS = positiveIntegerFromEnv("NINERR_FUZZ_RUNS", 4);
const CASES = positiveIntegerFromEnv("NINERR_FUZZ_CASES", 120);
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();
const CARD = `export function PriceCard() {\n  return (\n    <section className="card">\n      <h2>Pro</h2>\n    </section>\n  );\n}\n`;

// Every API route but the editor's event stream and launch page, and some that do not exist.
const ROUTES = [
  "GET /api/agents", "GET /api/codebase", "GET /api/confirmations", "GET /api/document", "GET /api/history", "GET /api/projects", "GET /api/session",
  "POST /api/agents/create", "POST /api/agents/revoke", "POST /api/checkpoint", "POST /api/code/export", "POST /api/code/import",
  "POST /api/codebase/connect", "POST /api/codebase/disconnect", "POST /api/codebase/import", "POST /api/codebase/preview", "POST /api/codebase/write",
  "POST /api/confirmations/decide", "POST /api/edit", "POST /api/edit", "POST /api/import", "POST /api/import/commit", "POST /api/import/discard",
  "POST /api/projects/close", "POST /api/projects/create", "POST /api/projects/open", "POST /api/redo", "POST /api/revert", "POST /api/selection", "POST /api/undo",
  "GET /api/nowhere", "POST /api/document", "DELETE /api/edit", "PUT /api/projects/open",
];
// The keys and words the routes read, so generated bodies reach past the first check.
const KEYS = ["name", "title", "baseRevision", "operations", "intent", "nodeId", "nodeIds", "transactionId", "token", "folder", "file", "component", "proposalId", "html", "code", "id", "approve", "breakStaleLock", "reason", "agentId", "type", "node", "parentId", "index", "set", "unset"];
const WORDS = ["insert-node", "set-props", "remove-node", "move-node", "restore-subtree", "frame", "text", "fuzz"];
const TOOLS = ["project_info", "layer_tree", "layer_details", "layer_children", "find_layers", "selection", "layer_code", "guide", "finish_task", "create_frame", "set_text", "rename_layers", "set_styles", "move_layers", "duplicate_layers", "delete_layers", "no_such_tool"];
const TOOL_KEYS = ["nodeId", "nodeIds", "text", "name", "width", "height", "renames", "updates", "moves", "styles", "parentId", "index", "query", "depth"];
// Valid JSON nested far deeper than any document allows, under the 1 MiB body limit.
const DEEP = ["[".repeat(50_000) + "]".repeat(50_000), `${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`];

/** The ids the host gave out, newest last; a seed picks them by position, so it replays. */
const recent = (list) => list.slice(-3);

/** A generated JSON value: every shape, hostile strings and numbers, ids that exist. */
function value(prng, context, depth = 0) {
  const kind = depth >= 4 ? prng.pick(["null", "bool", "number", "string"]) : prng.pick(["null", "bool", "number", "string", "string", "array", "object", "object", "object"]);
  switch (kind) {
    case "null":
      return null;
    case "bool":
      return prng.next() < 0.5;
    case "number":
      return prng.pick([0, -1, 1, 1.5, -0, 1e308, 2 ** 53 + 2, -(2 ** 31), context.revision, context.revision + 1]);
    case "string":
      return prng.pick([
        "", "x", "a".repeat(prng.pick([300, 70_000])), "\u0000", "\ud800", "é😀 مرحبا", "<script>alert(1)</script>", "../../../etc/passwd", "..\\..\\Windows", "con", "nul.txt", "__proto__", "constructor",
        context.folder, context.missingFolder, "Card.jsx", "PriceCard", ...WORDS, ...context.ids,
        ...recent(context.tokens), ...recent(context.proposals), ...recent(context.transactions), ...recent(context.confirmations), ...recent(context.agents),
      ]);
    case "array":
      return Array.from({ length: prng.int(0, 4) }, () => value(prng, context, depth + 1));
    default: {
      const record = {};
      for (let index = prng.int(0, 5); index > 0; index -= 1) {
        const key = prng.pick([...KEYS, ...TOOL_KEYS, "__proto__", "constructor", "prototype", "extra"]);
        Object.defineProperty(record, key, { value: value(prng, context, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return record;
    }
  }
}

/** A plausible edit: the right shape and revision, real ids, generated values. */
function plausibleEdit(prng, context) {
  const id = prng.pick([...context.ids, `fz-${prng.int(0, 9)}`]);
  const operation = prng.pick([
    { type: "insert-node", node: { id: `fz-${prng.int(0, 9)}`, type: prng.pick(["frame", "text", "image", "bogus"]), props: value(prng, context, 2) }, parentId: prng.pick([null, ...context.ids]), index: prng.pick([undefined, 0, 99, -1]) },
    { type: "set-props", nodeId: id, set: value(prng, context, 2), unset: prng.pick([undefined, ["name"], [""], "name"]) },
    { type: "remove-node", nodeId: id },
    { type: "move-node", nodeId: id, parentId: prng.pick([null, ...context.ids]), index: prng.pick([undefined, 0, 1, 99]) },
  ]);
  return { baseRevision: prng.pick([context.revision, context.revision, context.revision - 1]), intent: "Fuzz", operations: [operation] };
}

/** A generated request body for `path`: usually JSON, sometimes deep, sometimes not JSON. */
function body(prng, context, path) {
  const roll = prng.next();
  const json = (data, type = "application/json") => ({ bytes: Buffer.from(JSON.stringify(data) ?? "null", "utf8"), type });
  if (path === "/api/edit" && roll < 0.4) return json(plausibleEdit(prng, context));
  if (roll < 0.72) return json(value(prng, context));
  if (roll < 0.77) return json(value(prng, context), prng.pick(["text/plain", "application/x-www-form-urlencoded", null]));
  if (roll < 0.85) {
    // Deep, valid JSON in a place the route reads.
    const deep = prng.pick(DEEP);
    const text = path === "/api/edit"
      ? `{"baseRevision":${context.revision},"intent":"deep","operations":[{"type":"insert-node","node":{"id":"deep","type":"frame","props":{"name":${deep}}},"parentId":null}]}`
      : prng.pick([deep, `{"name":${deep}}`, `{"html":${deep}}`, `{"nodeId":${deep}}`]);
    return { bytes: Buffer.from(text, "utf8"), type: "application/json" };
  }
  const raw = prng.pick([
    "{", "[", "", "nul", "{\"a\":1,\"a\":2}", "﻿{}", "[".repeat(20_000), "{\"a\":".repeat(5_000), "\"unterminated", "1e999999",
    Buffer.from([0xff, 0xfe, 0x00, 0x7b]), Buffer.from([0xc0, 0xaf]), Buffer.from("{\"name\":\"\ud800\"}", "utf8"),
  ]);
  return { bytes: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"), type: "application/json" };
}

/** A generated JSON-RPC message for the agent: mostly a well-formed tool call. */
function mcpMessage(prng, context) {
  const method = prng.pick(["tools/call", "tools/call", "tools/call", "tools/call", "tools/list", "initialize", "ping", "resources/list", "", null]);
  const id = prng.next() < 0.9 ? prng.pick([1, 2, "a", "b"]) : prng.pick([null, {}, 1.5]);
  const jsonrpc = prng.next() < 0.9 ? "2.0" : prng.pick(["1.0", 2]);
  if (method === "tools/call" && prng.next() < 0.1) {
    // Deep, valid JSON inside a tool's arguments.
    return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_text","arguments":{"nodeId":"text","text":"x","extra":${prng.pick(DEEP)}}}}`;
  }
  const params = method === "tools/call" && prng.next() < 0.85
    ? { name: prng.pick(TOOLS), arguments: Object.fromEntries(Array.from({ length: prng.int(0, 3) }, () => [prng.pick(TOOL_KEYS), value(prng, context, 1)])) }
    : value(prng, context, 1);
  return JSON.stringify(prng.next() < 0.95 ? { jsonrpc, id, method, params } : value(prng, context)) ?? "null";
}

/** Send one request; the answer and its JSON (or null when it has none). */
async function send(url, method, token, payload) {
  const headers = { authorization: `Bearer ${token}`, ...(payload?.type ? { "content-type": payload.type } : {}) };
  const response = await fetch(url, { method, headers, ...(method === "GET" || payload === null ? {} : { body: payload.bytes }) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** Remember the ids an answer gives out, in the order they were given. */
function remember(context, path, json) {
  if (json === null || typeof json !== "object") return;
  if (path === "/api/codebase/preview" && typeof json.token === "string") context.tokens.push(json.token);
  if (path === "/api/import" && typeof json.proposalId === "string") context.proposals.push(json.proposalId);
  if (typeof json.transactionId === "string") context.transactions.push(json.transactionId);
  if (path === "/api/agents/create" && typeof json.agent?.agentId === "string") context.agents.push(json.agent.agentId);
  if (path === "/api/confirmations" && Array.isArray(json.pending)) for (const item of json.pending) if (!context.confirmations.includes(item.id)) context.confirmations.push(item.id);
}

test("the host under generated hostile requests and MCP calls never fails open: typed refusals that change nothing", { timeout: 300_000 }, async (t) => {
  const totals = {};
  const tally = (what) => {
    totals[what] = (totals[what] ?? 0) + 1;
  };
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      clock = 0;
      const prng = createPrng(seed);
      const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-request-fuzz-")));
      // A short wait, so a deletion an agent asks for times out instead of holding the run.
      const pool = hostPool(now, { confirmationWaitMs: 20 });
      try {
        const projects = join(base, "projects");
        const folder = join(base, "code");
        mkdirSync(projects);
        mkdirSync(folder);
        writeFileSync(join(folder, "Card.jsx"), CARD);
        let running = await pool.open(projects);
        const { host } = running;
        await ok(running.call("POST", "/api/projects/create", { name: "fuzz" }), "create");
        await ok(running.call("POST", "/api/edit", { baseRevision: 0, intent: "Seed", operations: [{ type: "insert-node", node: { id: "frame", type: "frame", props: { name: "Frame" } }, parentId: null }, { type: "insert-node", node: { id: "text", type: "text", props: { text: "Hello", tag: "p" } }, parentId: "frame" }] }), "seed content");
        await ok(running.call("POST", "/api/codebase/connect", { folder }), "connect");
        await ok(running.call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" }), "bring in");
        const { token: agentToken } = await ok(running.call("POST", "/api/agents/create", { name: "Fuzz agent" }), "agent");
        const context = { revision: 0, ids: [], folder, missingFolder: join(base, "missing"), tokens: [], proposals: [], transactions: [], confirmations: [], agents: [] };
        // What a refusal must leave as it was, besides the document.
        const surroundings = async () => JSON.stringify([(await running.call("GET", "/api/agents")).json?.agents, (await running.call("GET", "/api/codebase")).json?.folder ?? null]);
        const current = async () => {
          const result = await running.call("GET", "/api/document");
          return result.status === 200 ? result.json : null;
        };
        let state = await current();
        let around = await surroundings();

        for (let index = 0; index < CASES; index += 1) {
          context.revision = state?.revision ?? 0;
          // Only ids a seed decides (not the random ids of an agent's frames and copies).
          context.ids = state === null ? [] : Object.keys(state.document.nodes).filter((id) => !/^frame-|-copy-/u.test(id)).sort().slice(0, 6);
          let label;
          let answer;
          let changedOk;
          let path = "";
          if (prng.next() < 0.3) {
            // A JSON-RPC message to the MCP endpoint, as the agent.
            const message = mcpMessage(prng, context);
            label = `MCP ${message.slice(0, 160)}`;
            answer = await send(host.mcpUrl, "POST", agentToken, { bytes: Buffer.from(message, "utf8"), type: "application/json" });
            assert.ok(answer.status < 500, `${label}: the MCP endpoint answers ${answer.status} ${answer.text.slice(0, 200)}`);
            const result = answer.json?.result;
            changedOk = answer.status === 200 && result !== undefined && result.isError !== true;
            tally(`MCP ${answer.status}${result?.isError ? " tool error" : ""}${answer.json?.error ? " rpc error" : ""}`);
          } else {
            const route = prng.pick(ROUTES).split(" ");
            const method = route[0];
            path = route[1];
            const payload = method === "GET" ? null : body(prng, context, path);
            label = `${method} ${path} ${payload?.bytes.subarray(0, 160).toString("utf8")}`;
            answer = await send(`${host.url}${path}`, method, host.token, payload);
            assert.ok(answer.status < 500, `${label}: the host answers ${answer.status} ${answer.text.slice(0, 200)}`);
            if (answer.status >= 400) assert.equal(typeof answer.json?.error?.code, "string", `${label}: a refusal names a typed error: ${answer.text.slice(0, 200)}`);
            changedOk = answer.status === 200;
            if (changedOk) remember(context, path, answer.json);
            tally(`${answer.status}`);
          }
          // The host stays healthy and the document valid.
          const session = await running.call("GET", "/api/session");
          assert.equal(session.status, 200, `${label}: the host still answers`);
          let next = await current();
          if (next !== null) validateDocument(next.document);
          if (!changedOk) {
            // A refusal changed nothing: the project is still open, its document and revision,
            // the agents and the connected codebase are as they were.
            assert.deepEqual([session.json.project, session.json.failure], ["fuzz", undefined], `${label}: a refusal left the project open`);
            assert.equal(next.revision, state.revision, `${label}: a refusal changed the revision`);
            assert.equal(serializeDocument(next.document), serializeDocument(state.document), `${label}: a refusal changed the document`);
            assert.equal(await surroundings(), around, `${label}: a refusal changed the agents or the codebase`);
          }
          // Keep the generated requests working on the fuzz project and its codebase.
          if (session.json.project !== "fuzz") {
            await ok(running.call("POST", "/api/projects/open", { name: "fuzz" }), `${label}: the fuzz project opens again`);
            next = await current();
            tally("fuzz project reopened");
          }
          if ((await running.call("GET", "/api/codebase")).json?.folder === null) {
            await ok(running.call("POST", "/api/codebase/connect", { folder }), "reconnect");
            tally("codebase reconnected");
          }
          state = next;
          around = await surroundings();
        }

        // Closing and reopening, in a new host, gives back exactly the document the session held.
        const held = serializeDocument(state.document);
        await ok(running.call("POST", "/api/projects/close"), "close");
        await running.host.close();
        running = await pool.open(projects);
        await ok(running.call("POST", "/api/projects/open", { name: "fuzz" }), "reopen");
        assert.equal(serializeDocument((await current()).document), held, "the reopened document is the one the session held");
        assert.equal(readFileSync(join(folder, "Card.jsx"), "utf8"), CARD, "the connected source file is untouched");
      } finally {
        await pool.closeAll();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
  t.diagnostic(`answers: ${JSON.stringify(totals)}`);
});
