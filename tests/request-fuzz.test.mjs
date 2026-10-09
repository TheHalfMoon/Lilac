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
// component brought in from it, and an agent. Then, in a generated order, every API route
// (and unknown ones, and the wrong method) receives generated bodies: JSON of every shape,
// with the routes' own keys and prototype keys, hostile strings and numbers, deep nesting,
// and raw bodies that are not JSON at all or not UTF-8; and the MCP endpoint receives
// generated JSON-RPC messages and tool calls. Whatever comes in:
// - the host never answers 500, and every refusal names a typed error;
// - a refusal changes nothing: the document and its revision stay as they were;
// - the host stays healthy and the document valid after every request;
// - closing and reopening gives back exactly the document the session held.
// NINERR_FUZZ_RUNS sets the number of seeds (default 4) and NINERR_FUZZ_CASES the requests
// per seed (default 150); NINERR_PROPERTY_SEED=<seed> replays one seed.

const RUNS = positiveIntegerFromEnv("NINERR_FUZZ_RUNS", 4);
const CASES = positiveIntegerFromEnv("NINERR_FUZZ_CASES", 150);
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();

const ROUTES = [
  "GET /api/agents", "GET /api/codebase", "GET /api/confirmations", "GET /api/document", "GET /api/history", "GET /api/projects", "GET /api/session",
  "POST /api/agents/create", "POST /api/agents/revoke", "POST /api/checkpoint", "POST /api/code/export", "POST /api/code/import",
  "POST /api/codebase/connect", "POST /api/codebase/disconnect", "POST /api/codebase/import", "POST /api/codebase/preview", "POST /api/codebase/write",
  "POST /api/confirmations/decide", "POST /api/edit", "POST /api/import", "POST /api/import/commit", "POST /api/import/discard",
  "POST /api/projects/close", "POST /api/projects/create", "POST /api/projects/open", "POST /api/redo", "POST /api/revert", "POST /api/selection", "POST /api/undo",
  "GET /api/nowhere", "POST /api/document", "DELETE /api/edit", "PUT /api/projects/open",
];
// The keys the routes read, so generated bodies reach past the first check.
const KEYS = ["name", "title", "baseRevision", "operations", "intent", "nodeId", "nodeIds", "transactionId", "token", "folder", "file", "component", "proposalId", "html", "code", "id", "approve", "breakStaleLock", "reason", "agentId", "type", "node", "parentId", "index", "set", "unset"];
const TOOLS = ["project_info", "layer_tree", "layer_details", "layer_children", "find_layers", "selection", "layer_code", "guide", "finish_task", "create_frame", "set_text", "rename_layers", "set_styles", "move_layers", "duplicate_layers", "delete_layers", "no_such_tool"];
const TOOL_KEYS = ["nodeId", "nodeIds", "text", "name", "width", "height", "renames", "updates", "moves", "styles", "parentId", "index", "query", "depth"];

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
      return prng.pick(["", "x", "a".repeat(prng.pick([300, 70_000])), "\u0000", "\ud800", "é😀 مرحبا", "<script>alert(1)</script>", "../../../etc/passwd", "..\\..\\Windows", "con", "nul.txt", "__proto__", "constructor", context.folder, context.missingFolder, "Card.jsx", "PriceCard", ...context.ids]);
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

/** A generated request body: usually JSON, sometimes raw bytes that are not. */
function body(prng, context) {
  const roll = prng.next();
  if (roll < 0.75) return { bytes: Buffer.from(JSON.stringify(value(prng, context)) ?? "null", "utf8"), type: "application/json" };
  if (roll < 0.8) return { bytes: Buffer.from(JSON.stringify(value(prng, context)), "utf8"), type: prng.pick(["text/plain", "application/x-www-form-urlencoded", null]) };
  const raw = prng.pick([
    "{", "[", "", "nul", "{\"a\":1,\"a\":2}", "﻿{}", "[".repeat(20_000), "{\"a\":".repeat(5_000), "\"unterminated", "1e999999",
    Buffer.from([0xff, 0xfe, 0x00, 0x7b]), Buffer.from([0xc0, 0xaf]), Buffer.from("{\"name\":\"\ud800\"}", "utf8"),
  ]);
  return { bytes: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"), type: "application/json" };
}

/** Send one request as the host's owner; the answer and its JSON (or null when it has none). */
async function send(host, method, path, payload, token = host.token, url = `${host.url}${path}`) {
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

test("the host under generated hostile requests and MCP calls never fails open: typed refusals that change nothing", async (t) => {
  const totals = {};
  const tally = (what) => {
    totals[what] = (totals[what] ?? 0) + 1;
  };
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      const prng = createPrng(seed);
      const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-request-fuzz-")));
      // A short wait, so a deletion an agent asks for times out instead of holding the run.
      const pool = hostPool(now, { confirmationWaitMs: 20 });
      try {
        const projects = join(base, "projects");
        const folder = join(base, "code");
        mkdirSync(projects);
        mkdirSync(folder);
        writeFileSync(join(folder, "Card.jsx"), `export function PriceCard() {\n  return (\n    <section className="card">\n      <h2>Pro</h2>\n    </section>\n  );\n}\n`);
        let running = await pool.open(projects);
        const { host } = running;
        await ok(running.call("POST", "/api/projects/create", { name: "fuzz" }), "create");
        await ok(running.call("POST", "/api/edit", { baseRevision: 0, intent: "Seed", operations: [{ type: "insert-node", node: { id: "frame", type: "frame", props: { name: "Frame" } }, parentId: null }, { type: "insert-node", node: { id: "text", type: "text", props: { text: "Hello", tag: "p" } }, parentId: "frame" }] }), "seed content");
        await ok(running.call("POST", "/api/codebase/connect", { folder }), "connect");
        await ok(running.call("POST", "/api/codebase/import", { file: "Card.jsx", component: "PriceCard" }), "bring in");
        const { token: agentToken } = await ok(running.call("POST", "/api/agents/create", { name: "Fuzz agent" }), "agent");
        const context = { revision: 0, ids: [], folder, missingFolder: join(base, "missing") };
        const current = async () => {
          const result = await running.call("GET", "/api/document");
          return result.status === 200 ? result.json : null;
        };
        let state = await current();

        for (let index = 0; index < CASES; index += 1) {
          context.revision = state?.revision ?? 0;
          // Only ids a seed decides (not the random ids of an agent's frames and copies), so a seed
          // replays exactly.
          context.ids = state === null ? [] : Object.keys(state.document.nodes).filter((id) => !/^frame-|-copy-/u.test(id)).sort().slice(0, 6);
          const mcp = prng.next() < 0.3;
          let label;
          let answer;
          let changedOk = false;
          if (mcp) {
            // A JSON-RPC message to the MCP endpoint, as the agent.
            const method = prng.pick(["tools/call", "tools/call", "tools/call", "tools/list", "initialize", "ping", "resources/list", "", null]);
            const params = method === "tools/call" && prng.next() < 0.8
              ? { name: prng.pick(TOOLS), arguments: Object.fromEntries(Array.from({ length: prng.int(0, 3) }, () => [prng.pick(TOOL_KEYS), value(prng, context, 1)])) }
              : value(prng, context, 1);
            const message = prng.next() < 0.9 ? { jsonrpc: prng.pick(["2.0", "2.0", "2.0", "2.0", "1.0", 2]), id: prng.pick([1, 2, "a", "b", null, {}, 1.5]), method, params } : value(prng, context);
            label = `MCP ${JSON.stringify(method)} ${JSON.stringify(params)?.slice(0, 120)}`;
            answer = await send(host, "POST", "", { bytes: Buffer.from(JSON.stringify(message) ?? "null", "utf8"), type: "application/json" }, agentToken, host.mcpUrl);
            assert.ok(answer.status < 500, `${label}: the MCP endpoint answers ${answer.status} ${answer.text.slice(0, 200)}`);
            const result = answer.json?.result;
            changedOk = answer.status === 200 && result !== undefined && result.isError !== true;
            tally(`MCP ${answer.status}${result?.isError ? " tool error" : ""}${answer.json?.error ? " rpc error" : ""}`);
          } else {
            const [method, path] = prng.pick(ROUTES).split(" ");
            const payload = method === "GET" ? null : body(prng, context);
            label = `${method} ${path} ${payload?.bytes.subarray(0, 120).toString("utf8")}`;
            answer = await send(host, method, path, payload);
            assert.ok(answer.status < 500, `${label}: the host answers ${answer.status} ${answer.text.slice(0, 200)}`);
            if (answer.status >= 400) assert.equal(typeof answer.json?.error?.code, "string", `${label}: a refusal names a typed error: ${answer.text.slice(0, 200)}`);
            changedOk = answer.status === 200;
            tally(`${answer.status}`);
          }
          // The host stays healthy, and the document valid; a refusal changed nothing.
          const session = await running.call("GET", "/api/session");
          assert.equal(session.status, 200, `${label}: the host still answers`);
          let next = await current();
          if (next !== null) validateDocument(next.document);
          if (!changedOk && state !== null && next !== null && session.json.project === "fuzz") {
            assert.equal(next.revision, state.revision, `${label}: a refusal changed the revision`);
            assert.equal(serializeDocument(next.document), serializeDocument(state.document), `${label}: a refusal changed the document`);
          }
          // Keep the generated requests working on the fuzz project.
          if (session.json.project !== "fuzz") {
            const reopened = await running.call("POST", "/api/projects/open", { name: "fuzz" });
            assert.equal(reopened.status, 200, `${label}: the fuzz project opens again: ${JSON.stringify(reopened.json)}`);
            next = await current();
            tally("fuzz project reopened");
          }
          state = next;
        }

        // Closing and reopening, in a new host, gives back exactly the document the session held.
        const held = serializeDocument(state.document);
        await ok(running.call("POST", "/api/projects/close"), "close");
        await running.host.close();
        running = await pool.open(projects);
        await ok(running.call("POST", "/api/projects/open", { name: "fuzz" }), "reopen");
        assert.equal(serializeDocument((await current()).document), held, "the reopened document is the one the session held");
        assert.ok(readFileSync(join(folder, "Card.jsx"), "utf8").includes("PriceCard"), "the connected file is still a component");
      } finally {
        await pool.closeAll();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
  t.diagnostic(`answers: ${JSON.stringify(totals)}`);
});
