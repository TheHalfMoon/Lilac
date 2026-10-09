# P08-G3b: requests and MCP calls under generated hostile input

Issue: #230 (P08 umbrella), founder section P08.3: fuzzing MCP requests and the host's inputs; fail closed.

## What runs
`tests/request-fuzz.test.mjs` starts a studio host with a project that has:
- content;
- a connected codebase, with a component brought in from it;
- an agent.

Then, in a generated order, the host receives:
- **On every API route,** and on unknown routes and the wrong method:
  - JSON of every shape: the routes' own keys, prototype keys (`__proto__`, `constructor`, `prototype`), strings that are empty, 70,000 characters long, NUL, a lone surrogate, markup, path traversal or a Windows device name;
  - numbers at the edges (`-0`, `1e308`, `2^53 + 2`, the current revision and the next), arrays, nesting, and ids that exist;
  - the wrong content type;
  - bodies that are not JSON at all: truncated JSON, 20,000 open brackets, 5,000 nested objects, `1e999999`, a byte-order mark, a duplicate key, bytes that are not UTF-8.
- **On the MCP endpoint, as the agent:** JSON-RPC messages with valid and invalid versions, ids and methods, and tool calls (every tool and an unknown one) with generated arguments. A deletion the agent asks for waits 20 ms for the person and then times out, so it changes nothing.

- **Seeds:** each seed is its own subtest. `NINERR_FUZZ_RUNS` sets the number of seeds (default 4), and `NINERR_FUZZ_CASES` the requests per seed (default 150). `NINERR_PROPERTY_SEED=<seed>` replays one. A seed decides its whole run: ids from the agent's random frames and copies are never picked, and two runs of the default seeds give identical answers.
- **Cleanup:** the host and the folders are removed in the seed's `finally`.

## What must hold
- **The host never answers 500.** Every refusal (4xx) names a typed error code.
- **A refusal changes nothing:** the document and its revision stay exactly as they were. The same holds for an MCP call answered with a JSON-RPC error or a tool error.
- **After every request,** the host still answers, and the open document is valid.
- **A request that switches or closes the project** (creating or opening another, closing it) is followed by reopening the fuzz project, which must open.
- **At the end,** closing and reopening the project in a new host gives back exactly the document the session held. The connected source file is still a component.

## Results
**Locally (Windows 11, Node 24):**
- **The default 4 seeds × 150 requests pass in 24 s, identically on two runs:**
  - **API:** 117 answered 200, and the rest refused with typed errors (122 × 400, 106 × 404, 55 × 409, 12 × 415).
  - **MCP:** 34 calls succeeded, 21 were tool errors, 131 were JSON-RPC errors, and 2 were notifications (202).
  - **Reopens:** the fuzz project was reopened 11 times after a generated request switched or closed it.
- **A first run of 4 × 250 requests**, before the ids and envelopes were tuned for replay, also passed.

No request made the host answer 500, left an untyped refusal, changed the document while refusing, or left the host unable to answer.

## Not covered here
- **Concurrent requests:** P08-G6.
- **Import inputs** (HTML, CSS, SVG, code), deeper than this fuzz reaches through the API: P08-G3c.
- **Hostile names and paths** on disk (project names, codebase folders): P08-G3d.
