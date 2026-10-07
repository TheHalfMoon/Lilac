# P06 G5a: sandbox escapes in network classification and browser scans (#112)

Part of P06 gate 5 (#100). The findings come from a fresh-context probe of base `f4aafd8`, which ran each attack rather than reading the code.

## Confirmed escapes and fixes

| # | Escape | Fix |
|---|---|---|
| 1 | `classifyAddress` classed IPv4-translated `::ffff:0:0:0/96` (SIIT) as `public`, so remote-mode `validateResolvedAddresses` accepted DNS answers `::ffff:0:7f00:1` (127.0.0.1), `::ffff:0:a00:1` and `::ffff:0:a9fe:a9fe` (cloud metadata). | The range is forbidden in every mode, like the deprecated IPv4-compatible `::/96`. An embedded `0.x.x.x` classes as `unspecified`. |
| 2 | `scanBrowserUrl` kept its own private-target classifier, duplicating network-policy. Without `allowPrivateNetwork` it passed `localhost.`, `foo.localhost.`, `[::ffff:127.0.0.1]`, `[::127.0.0.1]`, `[fec0::1]`, NAT64 `[64:ff9b::7f00:1]`, `198.18.0.1`, `192.0.0.192`, multicast, `metadata.google.internal`, and DNS names resolving privately (`127.0.0.1.nip.io`) to the browser. | IP literals are classified by `@lilac/network-policy` `classifyAddress`, a new workspace dependency, and only `public` passes. Hostnames lose one trailing dot, and `localhost`, `*.localhost`, `*.local` and `*.internal` are private. Without `allowPrivateNetwork`, a DNS name is resolved first through an injectable `lookup` (default `dns.promises.lookup`, all answers); the scan is refused if any answer is not public, there are no answers, or resolution fails. |
| 3 | `createImpeccableCliRunner().scanTarget` appended the target without `--`, so a `-`-prefixed target was parsed as a CLI option. | `--` precedes the target. The pinned Impeccable 4.1.0 CLI accepts it; this was verified with identical JSON output with and without it. |

Residual risk, documented in the code: the browser resolves the name again when it fetches. The pre-check blocks names that are private at scan time, but cannot prevent DNS rebinding between the check and the fetch.

An existing design-assurance test resolved `example.com` through real DNS. It now injects a lookup, so the suite makes no network calls.

## Evidence

`tests/sandbox-network.test.mjs` has 6 tests. Five fail on base; the sixth is a guard that public and opted-in private targets still scan.
- Translated-address classes.
- Remote-mode rejection of translated DNS answers, with a public control answer accepted.
- 16 private spellings refused before the runner is called.
- Private, mixed, translated, empty and failing resolutions refused.
- Public literals and names allowed. Literals are not resolved, and `allowPrivateNetwork` skips resolution.
- A `--help` target arrives after `--`, checked with an argv-echo CLI stand-in (`tests/support/argv-echo.mjs`).

## Not covered here

These were left for later grains:
- **G5b, persistence:** FIFO hang and post-open root swap.
- **G5c:** import-stack filesystem, delivery-governance, collaboration and agent-supervisor surfaces, plus the consolidated fail-closed suite.
