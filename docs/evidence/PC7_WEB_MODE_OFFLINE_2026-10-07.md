# PC7: local web mode and the offline, local-first smoke flow

PC7 closes two PC gates:
- **Gate 6, local web mode:** one command serves the editor locally, with no network access beyond loopback.
- **Gate 16:** the offline, local-first smoke flow through the product surface.

## Local web mode

`npm start` (`scripts/lilac.mjs`) starts Lilac:
- **The command.** Options are `--projects <folder>`, `--port <n>` and `--open`. The projects folder defaults to `~/Lilac Projects`, or `LILAC_PROJECTS`.
- **On start**, it prints the projects folder and a single-use launch link on `127.0.0.1`. The studio host listens on loopback only (PC1).
- **New links.** Press Enter for a fresh link: a link works once, for two minutes.
- **`--open`** hands the link to the system's browser opener. That is the only helper process the command ever starts, and only when asked.
- **Stopping.** Ctrl+C or SIGTERM closes the host: the project's lock is released and the discovery file removed, and the process exits 0.

**Fixed here, found by these tests.** The host's `close()` waited for every open connection to end before dropping them, for example an editor's event stream or an idle keep-alive. Stopping Lilac could therefore hang. It now drops open connections, then waits for the server to close. A regression test holds an event stream and an idle socket open, and close returns in under a second. Against the old code, it hangs.

## No network beyond this computer

`tests/support/no-network.mjs` is a preload (`node --import`) that the tests run Lilac and the MCP relay under:
- a connection to a loopback address is allowed, because the editor and the relay talk to Lilac on `127.0.0.1`;
- any other connection, any DNS lookup of a name other than localhost, any UDP socket, and any helper process are refused and reported on stderr as `LILAC-NETWORK-ATTEMPT`.

The browser side refuses and records every request outside Lilac's origin. Test 1 checks the trap itself: loopback works, while a remote fetch, a DNS lookup and a spawn are refused and reported.

## Tests

**`tests/web-mode.test.mjs`:** 2 Node tests and 2 Chromium tests.
1. **The trap.** As described above.
2. **Gate 6: one command.**
   - `scripts/lilac.mjs` starts under the trap and prints the folder and a `127.0.0.1` link. The port is not reachable on any other IPv4 address of the machine.
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

## Catalog

`studio-host` notes that local web mode runs it directly.
