# PC7: local web mode and the offline, local-first smoke flow

PC7 closes two PC gates:
- **Gate 6, local web mode:** one command serves the editor locally, with no network access beyond loopback.
- **Gate 16:** the offline, local-first smoke flow through the product surface.

## Local web mode

`npm start` (`scripts/lilac.mjs`) starts Lilac:
- **The command.** Options are `--projects <folder>`, `--port <n>` and `--open`. The projects folder defaults to `~/Lilac Projects`, or `LILAC_PROJECTS`.
- **On start**, it prints the projects folder and a single-use launch link on `127.0.0.1`. The studio host listens on loopback only (PC1).
- **New links.** Press Enter for a fresh link: a link works once, for two minutes.
- **`--open`** hands the system's browser opener a private (0600) file that forwards to a fresh link. The link, which carries a ticket, therefore never appears in the process list. The file is removed after the ticket expires. That opener is the only helper process the command ever starts, and only when asked.
- **The projects folder** is created owner-only (0700). An existing folder is left as it is, since it may be shared on purpose, with a warning if others can read it. Lilac's own files in it are owner-only.
- **Option checking.** Options missing their value, and unknown options, are refused.
- **Stopping.** Ctrl+C or SIGTERM closes the host: the project's lock is released and the discovery file removed, and the process exits 0. A second Ctrl+C stops at once.

**Fixed here, found by these tests.** The host's `close()` waited for every open connection to end before dropping them, for example an editor's event stream or an idle keep-alive. Stopping Lilac could therefore hang. It now drops open connections, then waits for the server to close. A regression test holds an event stream and an idle socket open, and close returns in under a second. Against the old code, it hangs.

## No network beyond this computer

`tests/support/no-network.mjs` is a preload (`node --import`) that the tests run Lilac and the MCP relay under:
- a connection to a loopback address is allowed, because the editor and the relay talk to Lilac on `127.0.0.1`;
- these are refused and reported on stderr as `LILAC-NETWORK-ATTEMPT`:
  - any other connection, including one to "localhost" through a caller-supplied lookup;
  - any DNS lookup of a name other than localhost;
  - UDP (`dgram.createSocket`, `Socket#bind` and `#send`);
  - helper processes, through the functions and the `ChildProcess` class;
  - worker threads, which would not inherit the preload;
  - the raw bindings (`process.binding`) and native addons (`process.dlopen`) behind all of these.

The browser side refuses and records every request outside Lilac's origin that the page makes: HTTP through `context.route`, and WebSockets through `routeWebSocket`. Service workers are blocked, so none can make requests out of view, and every tab's record is kept until the browser closes. Chromium's own browser-level background traffic is outside the page and is not routed; Playwright starts it with background networking disabled. The editor's CSP (`default-src 'none'`, `connect-src 'self'`) backstops the page, and every test asserts there are no console errors, where a CSP block would show.

Test 1 checks the trap itself. Loopback works, and each of these is refused and reported: a remote fetch, DNS, a spawn, a worker, the `ChildProcess` class, a raw binding, `dlopen`, a custom-lookup connection to "localhost", and UDP.

## Tests

**`tests/web-mode.test.mjs`:** 3 Node tests and 2 Chromium tests. Test 5 and the hardening below were added in review delta 1.
1. **The trap.** As described above.
2. **Gate 6: one command.**
   - `scripts/lilac.mjs` starts under the trap and prints the folder and a `127.0.0.1` link. The port is not reachable on any other IPv4 address of the machine, and the test asserts there is at least one such address to probe.
   - The editor opened from the link creates a project and edits. A used link is refused. Enter prints a fresh link, which opens a second editor on the same project at the same revision.
   - SIGTERM exits 0 and removes the discovery file.
   - Neither the process nor the pages made any network attempt.
3. **Gate 16: the offline smoke flow**, under the trap:
   - create a project;
   - import an HTML page that links to a remote stylesheet, script, image and link;
   - rename it in the inspector;
   - bring a JSX component in;
   - connect an agent in the editor; the stdio relay, also under the trap, creates an artboard through MCP;
   - save;
   - stop Lilac and start it again, then reopen the project. Every layer is there by name, and the imported heading keeps its colour.

   Across both Lilac processes, the relay and every page, the recorded attempts are none.
4. **Stopping does not wait for open connections** (the regression test above).
5. **The command refuses options it does not understand**, such as a missing value, an out-of-range port or an unknown flag. It exits with 2.

## Catalog

`studio-host` notes that local web mode runs it directly.

## Review delta 1

The security and correctness judge approved, with no must-fix. It confirmed the `close()` regression claim against the old code, found no command injection in `--open`, and found the stdin link loop and signal handling correct. Its trap probe found ways around the first trap, none of them used by Lilac, since no product code uses workers, raw bindings, the `ChildProcess` class, dgram or `dlopen`. To make the gate claims hold beyond today's code, the trap now covers each of them (test 1).

**Also taken:**
- `--open` no longer puts the link in the process list;
- a new projects folder is owner-only, and an existing one is warned about;
- options are checked, with a new test 5;
- a second Ctrl+C forces a stop;
- the browser records WebSockets and blocks service workers, every tab's record is kept to the end, and the evidence now states the capture's limits;
- the interface probe asserts that there is something to probe.

## Review delta 2

The cycle-1 re-review confirmed that every new trap holds and that trapping `process.binding` and `dlopen` breaks nothing Lilac or the relay uses. It found one must-fix, which had been present from the first version:

**Fixed: http and https got past the trap unreported.** `http.Agent` connects with `path: null`, and the trap treated any defined path as a local socket. The trap now follows Node's own rule: only a non-empty string path is a local socket. This covers `http.get` and `https.get` to an IP literal, and import-stack's pinned-lookup request pattern. Test 1 now asserts that each of these is refused, along with a plain hostname request.

**Also taken:**
- a refused direct DNS call fails that one call, as a real resolution failure would, instead of crashing the process. A refused `net`, `http` or `https` connection is refused before any lookup, and throws from the call, still reported;
- an existing projects folder is no longer chmodded;
- the trap's header and this document now name the APIs the trap covers, instead of claiming every way out.
