# P08-G3b: requests and MCP calls under generated hostile input

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing MCP requests and the host's inputs; hostile sizes, nesting, Unicode and encodings; fail closed.

## What runs
`tests/request-fuzz.test.mjs` starts a studio host with a project that has:
- content;
- a connected codebase, with a component brought in from it;
- an agent.

Then, in a generated order, the host receives the following input.

**The API routes:** every route except the editor's event stream and its launch page, plus unknown routes and the wrong method. They get:
- **JSON of every shape:**
  - the routes' own keys and words (operation and node types);
  - prototype keys (`__proto__`, `constructor`, `prototype`);
  - strings that are empty, 70,000 characters long, NUL, a lone surrogate, markup, path traversal or a Windows device name;
  - numbers at the edges (`-0`, `1e308`, `2^53 + 2`, the current revision and the next);
  - arrays and nesting;
  - ids that exist: layers, and the ids the host gave out earlier (write-back previews, import proposals, transactions, confirmations, other agents).
- **Plausible edits,** 40% of edit requests: the right shape and revision, real ids, generated values.
- **Deep, valid JSON** (50,000 nested arrays, or 20,000 nested objects, under the 1 MiB limit), put where the route reads it. For edits, that is a layer's name.
- **The wrong content type.**
- **Bodies that are not JSON at all:** truncated JSON, 20,000 open brackets, 5,000 unclosed objects, `1e999999`, a byte-order mark, a duplicate key, bytes that are not UTF-8.

**The MCP endpoint, as the agent:** mostly well-formed tool calls (every tool and an unknown one) with generated arguments, sometimes with deep, valid JSON inside them. Also other methods, and envelopes with a wrong version or id. A deletion the agent asks for waits 20 ms for the person and then times out, so it changes nothing.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the requests per seed (default 120). `NINERR_PROPERTY_SEED=<seed>` replays one. The test has a 5-minute timeout.
- **Determinism:** a seed decides its whole run, and two runs of the default seeds give identical answers.
  - The random ids of an agent's frames and copies are never picked.
  - The other random ids (of the imported component, and of agents and previews the host gave out) are picked by position, never by value.
  - Each seed starts its own clock.
- **Cleanup:** the host and the folders are removed in the seed's `finally`.

## What must hold
- **The host never answers 500.** Every refusal (4xx) names a typed error code.
- **A refusal changes nothing.** The project stays open; its document, its revision, the agents and the connected codebase stay exactly as they were. The same holds for an MCP call answered with a JSON-RPC error or a tool error.
- **After every request,** the host still answers, and the open document is valid.
- **A request that is accepted and switches or closes the project, or disconnects the codebase,** is followed by reopening or reconnecting it, which must work.
- **At the end,** closing and reopening the project in a new host gives back exactly the document the session held. The connected source file is byte for byte as written.

## Results
**Locally (Windows 11, Node 24):** the default 4 seeds × 120 requests pass in 50 s.
- **API:** 114 answered 200, and the rest refused with typed errors (98 × 400, 83 × 404, 17 × 409, 10 × 415).
- **MCP:** 57 calls succeeded, 36 were tool errors, 62 were JSON-RPC errors, and 3 were notifications (202).
- **Repairs:** the fuzz project was reopened 8 times, and the codebase reconnected 15 times, after accepted requests.

With 150 requests per seed, two runs gave identical answers.

No request made the host answer 500 or left an untyped refusal, deep nesting included. No refusal changed the project, its document, its agents or its codebase, and the host never stopped answering.

## Not covered here
- **Already covered elsewhere, not repeated:**
  - authentication, `Host` and `Origin` checks, and wrong tokens: P06 tests in `studio-host.test.mjs`, `mcp-server.test.mjs` and `studio-web-serving.test.mjs`;
  - a body over the 1 MiB limit (413): `studio-web-serving.test.mjs`.
- **Concurrent requests:** P08-G6.
- **Import inputs** (HTML, CSS, SVG, code), deeper than this fuzz reaches through the API: P08-G3c.
- **Hostile names and paths on disk:** P08-G3d.
