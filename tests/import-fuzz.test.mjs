import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeDocument, validateDocument } from "../packages/document-model/src/index.mjs";
import { hostPool, ok } from "./support/host-api.mjs";
import { createPrng, positiveIntegerFromEnv, propertySeeds } from "./support/prng.mjs";

// Every way out of this computer is trapped for this file (it runs in its own process): an
// attempt is refused and reported on stderr, which is watched here.
const attempts = [];
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (String(chunk).includes("NINERR-NETWORK-ATTEMPT")) attempts.push(String(chunk).trim());
  return write(chunk, ...rest);
};
await import("./support/no-network.mjs");

// P08-G3c (#230, founder section P08.3): imports through the studio host under mutated real
// input. The corpus is the malicious-markup corpus, realistic pages, and the JSX fixtures;
// each case mutates one or two of them (bytes flipped, markup and syntax characters inserted,
// ranges removed or repeated, truncation, two inputs spliced) and brings the result in, as
// an HTML import (reviewed, then committed or discarded), as code, or as a file in the
// connected codebase. Whatever comes in:
// - the host never answers 500, every refusal names a typed error and changes nothing, and
//   no case takes more than a few seconds;
// - what is committed leaves a valid document, and code brought in exports, and that export
//   brought in again exports the very same code;
// - nothing tries to reach the network;
// - closing and reopening gives back exactly the document the session held.
// NINERR_FUZZ_RUNS sets the number of seeds (default 4) and NINERR_FUZZ_CASES the cases per
// seed (default 50); NINERR_PROPERTY_SEED=<seed> replays one seed. P06's package-level
// properties (import idempotence, the code IR round trip) are not repeated here.

const RUNS = positiveIntegerFromEnv("NINERR_FUZZ_RUNS", 4);
const CASES = positiveIntegerFromEnv("NINERR_FUZZ_CASES", 50);
const CASE_MS = 5_000;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + clock++ * 1000).toISOString();

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const MARKUP = readdirSync(join(FIXTURES, "malicious")).filter((name) => /\.(html|svg|css)$/u.test(name)).sort().map((name) => readFileSync(join(FIXTURES, "malicious", name), "utf8"));
const PAGES = [
  "<style>.card{padding:8px}</style><main><section class=\"card\"><h1>Plans &amp; pricing</h1><p>From <b>$12</b>&nbsp;/ seat</p><a href=\"/signup\" title=\"Sign &quot;up&quot;\">Start</a></section></main>",
  "<nav><ul><li><a href=\"#a\">A</a></li><li><a href=\"#b\">B</a></li></ul></nav><svg viewBox=\"0 0 10 10\"><use xlink:href=\"#icon\" href=\"/sprite.svg#icon\"></use><title>Icon</title></svg>",
  "<table><thead><tr><th>Plan</th></tr></thead><tbody><tr><td>Free<form><input name=\"q\"></form></td></tr></tbody></table><form action=\"/x\"><label>Email <input type=\"email\"></label><button>Go</button></form>",
];
const CODE = readdirSync(join(FIXTURES, "code-ir")).filter((name) => name.endsWith(".jsx")).sort().map((name) => readFileSync(join(FIXTURES, "code-ir", name), "utf8"));
const INSERTS = ["<", ">", "\"", "'", "&", "&amp;", "\u0000", "<!--", "-->", "]]>", "<![CDATA[", "</script>", "<script>", "<svg>", "</div>", "{", "}", "{/*", "*/}", "=>", "<>", "</>", "\\", "\ud800", "é😀", "\r\n"];

/** One input mutated: a corpus entry changed in one or two ways, or two spliced. */
function mutate(prng, corpus) {
  let text = prng.pick(corpus);
  for (let times = prng.int(1, 2); times > 0; times -= 1) {
    const at = prng.int(0, Math.max(0, text.length - 1));
    switch (prng.pick(["insert", "insert", "remove", "repeat", "truncate", "splice", "flip"])) {
      case "insert":
        text = `${text.slice(0, at)}${prng.pick(INSERTS)}${text.slice(at)}`;
        break;
      case "remove":
        text = `${text.slice(0, at)}${text.slice(at + prng.int(1, 40))}`;
        break;
      case "repeat": {
        // A range repeated many times: deeper nesting, longer lists, larger input.
        const range = text.slice(at, at + prng.int(1, 60));
        text = `${text.slice(0, at)}${range.repeat(prng.pick([2, 50, 400]))}${text.slice(at)}`;
        break;
      }
      case "truncate":
        text = text.slice(0, at);
        break;
      case "splice": {
        const other = prng.pick(corpus);
        text = `${text.slice(0, at)}${other.slice(prng.int(0, other.length - 1))}`;
        break;
      }
      default: {
        const code = text.charCodeAt(at);
        text = `${text.slice(0, at)}${String.fromCharCode(Number.isNaN(code) ? 32 : code ^ (1 << prng.int(0, 6)))}${text.slice(at + 1)}`;
      }
    }
  }
  return text;
}

test("imports under mutated real input: typed refusals that change nothing, valid documents, stable code, no network", { timeout: 600_000 }, async (t) => {
  const totals = {};
  const tally = (what) => {
    totals[what] = (totals[what] ?? 0) + 1;
  };
  const seeds = propertySeeds(RUNS);
  for (const seed of seeds) {
    await t.test(`seed ${seed}`, async () => {
      clock = 0;
      const prng = createPrng(seed);
      const base = realpathSync(mkdtempSync(join(tmpdir(), "ninerr-import-fuzz-")));
      const pool = hostPool(now);
      try {
        const projects = join(base, "projects");
        const folder = join(base, "code");
        mkdirSync(projects);
        mkdirSync(folder);
        let running = await pool.open(projects);
        await ok(running.call("POST", "/api/projects/create", { name: "imports" }), "create");
        await ok(running.call("POST", "/api/codebase/connect", { folder }), "connect");
        const current = async () => (await ok(running.call("GET", "/api/document"), "document"));
        let state = await current();

        for (let index = 0; index < CASES; index += 1) {
          const route = prng.pick(["html", "html", "code", "codebase"]);
          const input = route === "html" ? mutate(prng, [...MARKUP, ...PAGES]) : mutate(prng, CODE);
          const where = `seed ${seed}, case ${index} (${route}, ${input.length} characters): ${JSON.stringify(input.slice(0, 120))}`;
          const started = Date.now();
          const accepted = [];
          const refuse = (answer, what) => {
            assert.ok(answer.status < 500, `${where}: ${what} answers ${answer.status} ${JSON.stringify(answer.json)?.slice(0, 200)}`);
            if (answer.status !== 200) assert.equal(typeof answer.json?.error?.code, "string", `${where}: ${what} names a typed error`);
            return answer.status === 200;
          };
          if (route === "html") {
            const review = await running.call("POST", "/api/import", { html: input, name: "Fuzzed page" });
            if (refuse(review, "the review")) {
              tally(review.json.commitReady ? "html reviewed, ready" : "html reviewed, blocked");
              if (review.json.commitReady && prng.next() < 0.8) {
                const committed = await running.call("POST", "/api/import/commit", { proposalId: review.json.proposalId });
                if (refuse(committed, "the commit")) {
                  accepted.push("committed");
                  tally("html committed");
                } else tally(`html commit refused (${committed.json.error.code})`);
              } else {
                await ok(running.call("POST", "/api/import/discard", { proposalId: review.json.proposalId }), "discard");
                tally("html discarded");
              }
            } else tally(`html refused (${review.json.error.code})`);
          } else if (route === "code") {
            const brought = await running.call("POST", "/api/code/import", { code: input });
            if (refuse(brought, "bringing code in")) {
              accepted.push("code");
              tally("code brought in");
              // Code brought in exports, and that export brought in again exports the same code.
              const component = (await current()).document.nodes[brought.json.frameId].children[0];
              const exported = await ok(running.call("POST", "/api/code/export", { nodeId: component }), "export");
              const again = await ok(running.call("POST", "/api/code/import", { code: exported.code }), "bring the export in");
              const second = (await current()).document.nodes[again.frameId].children[0];
              assert.equal((await ok(running.call("POST", "/api/code/export", { nodeId: second }), "export again")).code, exported.code, `${where}: the export is stable`);
              tally("code round trip stable");
            } else tally(`code refused (${brought.json.error.code})`);
          } else {
            // A file in the connected codebase: scanned, and brought in when it is a component.
            writeFileSync(join(folder, "Fuzzed.jsx"), input);
            const scan = await running.call("GET", "/api/codebase");
            refuse(scan, "the scan");
            const found = scan.status === 200 ? scan.json.components.find((entry) => entry.file === "Fuzzed.jsx") : undefined;
            if (found) {
              const brought = await running.call("POST", "/api/codebase/import", { file: found.file, component: found.component });
              if (refuse(brought, "bringing the file in")) {
                accepted.push("codebase");
                tally("codebase component brought in");
              } else tally(`codebase component refused (${brought.json.error.code})`);
            } else tally("codebase file not a component");
          }
          assert.ok(Date.now() - started < CASE_MS, `${where}: took ${Date.now() - started} ms`);
          // A refusal changed nothing; what was accepted left a valid document.
          const next = await current();
          validateDocument(next.document);
          if (accepted.length === 0) {
            assert.equal(next.revision, state.revision, `${where}: a refusal changed the revision`);
            assert.equal(serializeDocument(next.document), serializeDocument(state.document), `${where}: a refusal changed the document`);
          }
          state = next;
        }

        // Closing and reopening, in a new host, gives back exactly the document the session held.
        const held = serializeDocument(state.document);
        await ok(running.call("POST", "/api/projects/close"), "close");
        await running.host.close();
        running = await pool.open(projects);
        await ok(running.call("POST", "/api/projects/open", { name: "imports" }), "reopen");
        assert.equal(serializeDocument((await current()).document), held, "the reopened document is the one the session held");
      } finally {
        await pool.closeAll();
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
  assert.deepEqual(attempts, [], "nothing tried to reach the network");
  t.diagnostic(`outcomes: ${JSON.stringify(totals)}`);
});
