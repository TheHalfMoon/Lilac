# P06 G5d: the scanning browser runs behind a policy proxy (#114)

Part of P06 gate 5 (#100). This closes the browser-scan residuals recorded in G5a: DNS rebinding, redirects and subresource loads. The frozen spec is on #114 (option 1).

## Why a proxy

`impeccable` 4.1.0 launches Chromium through a Puppeteer-style launcher. The launcher takes its executable from `IMPECCABLE_BROWSER`, then `PUPPETEER_EXECUTABLE_PATH`, then `CHROME_PATH`.

A probe in this container pointed `IMPECCABLE_BROWSER` at a wrapper. The wrapper started the real Chromium with `--proxy-server` aimed at a deny-all proxy and `--proxy-bypass-list=<-loopback>`. The proxy received every request: the loopback target, its favicon, and Chrome's background requests. The target server received none. The engine still exited 0 with no findings, so Lilac itself must fail the scan.

## Changes

1. **`startBrowserPolicyProxy`** (`design-assurance/src/browser-proxy.mjs`) is a loopback-only HTTP proxy that handles absolute-form HTTP and `CONNECT`. For each contact it:
   - resolves the host once, through the injectable lookup;
   - checks every answer;
   - connects to the pinned address, so the browser never resolves or connects on its own.

   **What it allows.** Public addresses are always allowed. With `allowPrivateNetwork === true`, loopback and private ranges are allowed too. Some addresses are never allowed in any mode:
   - unspecified and invalid addresses;
   - link-local and cloud-metadata addresses, in every IPv4 and IPv6 spelling.

   The last group is decided by `isLinkLocalOrMetadataAddress` in `@lilac/network-policy`, which parses the address. It covers 169.254.0.0/16, fe80::/10, `100.100.100.200` and `fd00:ec2::254`, including mapped, compatible, translated, NAT64 and 6to4 forms.

   **Handling.**
   - Non-http absolute-form requests and URLs with credentials are refused.
   - A DNS failure returns 502 and is not recorded as a policy denial.
   - Redirects pass through to the browser unfollowed, so each hop arrives as a new contact and is checked again.
   - Denials (host, reason) are recorded, capped at 100.
2. **`createImpeccableCliRunner`** takes `browserExecutable` (default: `IMPECCABLE_BROWSER`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, then well-known paths) and `browserFlags`.

   When `scanTarget` is given a `proxyUrl` (which must be a `http://127.0.0.1:<port>` URL), it writes a mode-0700 wrapper in a fresh temp directory. All three variables point the engine at the wrapper, and the wrapper is removed after the scan. The wrapper:
   - starts the real browser with these flags first: `--proxy-server`, `--proxy-bypass-list=<-loopback>`, `--disable-quic`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and `--dns-prefetch-disable`;
   - drops any proxy, QUIC, WebRTC-policy or `--host-resolver-rules` switch the launcher passes, in both `--` and single-dash form.

   On Windows a wrapper cannot be exec'd without a shell, so URL scans fail closed with a typed error.
3. **`scanBrowserUrl`** always runs the browser behind the proxy and keeps the existing pre-checks. It throws when the proxy recorded any policy denial, from the target, a redirect or a subresource, and names up to five of them.

## Tests

`tests/browser-proxy.test.mjs` has 13 tests. Tests 10 to 12 were added in review delta 1 and test 13 in review delta 2, both described below. To check them against base `15c6158`, the package changes were removed and the tests that do not import the new export were run. Tests 4 to 9 fail there; tests 1 to 3 exercise the new proxy directly.

1. By default the proxy refuses loopback (by name and by literal), private, IPv6 loopback and metadata destinations, over HTTP and `CONNECT`. Nothing reaches the server.
2. An unresolvable host gets a 502 and is not recorded as a denial.
3. An allowed contact reaches the pinned address with its original `Host` and is resolved once. A redirect passes through unfollowed, and its metadata target is refused when requested.
4. **Rebinding.** The pre-check sees a public answer and the browser's contact sees loopback. The contact is refused, the scan fails, and the server receives nothing.
5. A redirect target and a subresource on private or metadata hosts fail the scan, and both are named.
6. Metadata stays denied with `allowPrivateNetwork`. A quiet private scan still succeeds.
7. Driven by the real engine with a stand-in browser that records its argv, the browser starts with the proxy flags first and no launcher proxy switch. The wrapper is removed, and a non-loopback `proxyUrl` is refused.
8. A stand-in engine that passes `--no-proxy-server`, `--proxy-server=direct://`, `--proxy-bypass-list=*`, `--host-resolver-rules` and `--enable-quic` has all of them dropped.
9. **End to end with a real Chromium.** This runs when one is found (`LILAC_TEST_BROWSER` or the usual paths). A page with a metadata image fails the scan, and the page itself was fetched through the proxy. It passed here with Playwright's Chromium 1194 (`--no-sandbox`, because the container runs as root). It is skipped when no browser is installed.

**Review delta 1.** The combined judge returned two must-fix findings, both confirmed with probes. The security judge returned no must-fix and independently reported the first one.
- **Metadata spellings.** In private mode, the metadata exception was a string-prefix check. Metadata written as hex IPv4-mapped (`[::ffff:a9fe:a9fe]`) or IPv4-compatible IPv6 got through, and so did Alibaba's `100.100.100.200`. The exception now uses the parsing classifier, and denials are checked in every mode.
- **Leaked upstream sockets.** Upstream HTTP requests were not tracked or aborted, so a silent upstream outlived `close()` and kept the process alive. They are now:
  - tracked, and destroyed by `close()`;
  - aborted when the browser's response closes;
  - subject to a 30 s idle timeout.

  CONNECT tunnels end both sides on close, and an upstream connection is not opened if the client left during the lookup.
- **Smaller fixes.** The wrapper also drops single-dash switches. A URL with credentials gets its own denial reason. The trailing-dot test now asserts a policy refusal rather than accepting a 502.

New tests, each failing on `d5fdc86`:

10. The classifier recognises every spelling (and the private/loopback/public controls are not caught).
11. With `allowPrivateNetwork`, five metadata spellings over HTTP and four over `CONNECT` are refused.
12. `close()` ends an upstream connection that never answered.

Test 8 now also passes single-dash switches, and it fails on `d5fdc86` too.

**Review delta 2.** The delta re-review had no must-fix. It confirmed the delta-1 fixes with probes, including real-DNS hex, octal and decimal metadata spellings over CONNECT and absolute-form requests. Two worth-considering items are fixed:
- **Shared connection pool.** Upstream requests used Node's shared global agent, so closing one proxy broke another live proxy's in-flight request. Each proxy now has its own keep-alive agent, destroyed by `close()`.
- **Half-closed clients.** A CONNECT client that half-closes during the lookup is now treated as gone.

13. Closing one proxy leaves another proxy's slow in-flight request intact. This test fails on `026db1a`.

## Gate

I ran `npm run check` as root here twice.
- **Run 1:** "model and history operations on 50k nodes stay within budget" failed once. The same test passed when run alone straight afterwards; this machine was loaded, and no browser process was left over.
- **Run 2:** every test passed except "a failed journal write poisons the store until reopen". That test needs `chmod` to be enforced, which root ignores. It passes as non-root and in CI.
- **After review delta 1:** 551 passed. The same root-only test failed, and the real-browser test was skipped because `LILAC_TEST_BROWSER` was not set in the full run. Run on its own with Playwright Chromium, the real-browser test passed.

## Residual

- Chromium contacts that ignore a configured HTTP proxy are outside this check. Proxy mode already turns off DNS prefetch and non-proxied WebRTC UDP, and QUIC is disabled.
- Browser URL scans are unavailable on Windows until a wrapper that can be exec'd exists there.
- The id-namespacing requirement for renderers, recorded on #114 from G6, applies to a future renderer and is not part of this grain.
