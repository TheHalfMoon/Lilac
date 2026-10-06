# P05 D6b - Network capability policy, provider registry, offline guarantee

Date: 2026-10-06

Issue: #80

## Scope

Second slice of Master Plan D6 (local/private mode): an explicit, default-deny network capability policy; a bring-your-own provider registry; offline readiness reporting; and a test that proves the core workflow runs with all network access disabled. With D6a (#74) this makes `docs/PARITY_MATRIX.md` LILAC-D6 provable.

Target package: `packages/network-policy` (no runtime dependencies)

## Single owner for address classification

The Grain 6 IPv4/IPv6 classifier (loopback, RFC 1918 and other private/reserved ranges, link-local, CGNAT, documentation, IPv4-mapped, NAT64, 6to4, multicast) was moved from `@lilac/import-stack` into `@lilac/network-policy`, then tightened after review: deprecated site-local `fec0::/10` and IPv4-compatible `::/96` are now forbidden, and unspecified addresses (`0.0.0.0/8`, `::`, and `0.x.x.x` embedded in IPv4-mapped, IPv4-compatible, NAT64, and 6to4 forms) form their own class that is denied in every mode, including as grant hosts and provider endpoints (on common stacks they reach local services). Grant hosts whose last label is a number are refused, because URL parsing would turn them into IPv4 addresses. `@lilac/import-stack` now imports it and re-exports the same functions; its tests pass unchanged, and a test asserts the re-exports are the same function objects.

## Policy

- Modes: `offline` (default; no network, no loopback), `local-only` (loopback only), `allowlist` (explicit grants; only this mode may carry grants).
- Grants: capability (`provider.inference`, `import.fetch`, `asset.fetch`, `update.check`, `collaboration.sync`), scheme, exact host or `*.suffix` (strict subdomains, at least two labels), port (null means the scheme default only), `allowPrivateNetwork`, purpose.
- `evaluateUrl` (before DNS) refuses non-http(s) schemes, embedded credentials, and unmatched grants; loopback targets need an explicit loopback grant; private IP literals need `allowPrivateNetwork`.
- `evaluateResolved` (after DNS) checks every resolved address against the decision: loopback grants must stay on loopback, other grants may never resolve to loopback, and private or reserved addresses need `allowPrivateNetwork`. This defeats DNS rebinding when callers pass the addresses they actually connect to.
- Decisions are frozen data with reasons. `evaluateResolved` honors only decisions issued by `evaluateUrl` (tracked in a module-private `WeakSet`), so forged or copied decision objects are refused. Wildcard grants match DNS names only, never IP literals, and numeric wildcard bases are rejected.
- The package never opens connections or resolves names. **It enforces nothing on its own:** callers must ask it before connecting. Its only real network consumer today, `@lilac/import-stack`, still enforces its own `ImportPolicy`; routing import through this policy is tracked in #83.

## Providers

- Kinds: `in-process`, `local-process` (no network), `loopback-http`, `remote-http` (endpoint required; loopback and remote are enforced by endpoint host).
- Credentials are references only (`env` variable name or `os-keychain` id). Descriptors reject unknown fields, so values such as `apiKey` cannot be registered; endpoints may not embed credentials, queries, fragments, or path segments shaped like well-known credentials (`sk-`/`rk-` keys, GitHub `gh*_` tokens, Slack `xox*-` tokens, AWS access key ids, JWTs; percent-decoded first). This is a deliberately narrow heuristic: UUIDs, model ids, and deployment names are never refused, and secrets in other shapes are not detected. Remote providers with a credential must use https.
- A single `provider.inference` network capability gates every provider capability (text, image, embedding, OCR, segmentation, vectorize).
- `resolveProvider` returns the first provider the policy permits, with a reason for each rejected provider.

## Offline guarantee

`tests/offline-guarantee.test.mjs` replaces `net.connect`, `net.createConnection`, `net.Socket#connect`, `tls.connect`, `http/https.request/get`, `http2.connect`, `dgram.createSocket`, every `dns` lookup/resolve/reverse method (callback, promise, and `Resolver` instances), every `child_process` spawn/exec/fork form, and `fetch` with recorders that throw, then calls `syncBuiltinESMExports()`. A first test proves each trap intercepts. The second loads every workflow module only after the trap (so no pre-trap reference can escape) and runs the core workflow: create a project, edit, checkpoint, undo and redo through history, an edit by an agent actor (owned by the user) through the collaboration authority whose attributed transaction (actor kind `agent`, owner recorded) is the one persisted, close, reopen; design-method review; decision assurance across two candidates with rule packs; offline HTML import. It asserts that exactly the required `CORE_FEATURES` were exercised and that there were zero network attempts.

Not covered because it does not exist yet: the local MCP endpoint named in Master Plan D6 (#82). The P03 catalog previously marked `mcp-surface` as an implemented endpoint; it is corrected to `stub` in this change, since `@lilac/mcp-protocol` only validates MCP contracts.

## Parity

LILAC-D6 ("core workflow passes with external network disabled") is moved to `PARITY_PROVEN` citing this test, `tests/network-policy.test.mjs`, and `tests/persistence.test.mjs`.

## Non-goals

No HTTP client, resolver, provider implementation, OS keychain integration, or policy UI.

## Qualification

Recorded on Issue #80 after exact-head CI, Alibaba Open Code Review delegation with host-agent rule application, the pstack review panel, and Jev. Cubic, CodeRabbit, and Qodo are not qualification evidence.
