# P05 D6b - Network capability policy, provider registry, offline guarantee

Date: 2026-10-06

Issue: #80

## Scope

Second slice of Master Plan D6 (local/private mode): an explicit, default-deny network capability policy; a bring-your-own provider registry; offline readiness reporting; and a test that proves the core workflow runs with all network access disabled. With D6a (#74) this makes `docs/PARITY_MATRIX.md` LILAC-D6 provable.

Target package: `packages/network-policy` (no runtime dependencies)

## Single owner for address classification

The Grain 6 IPv4/IPv6 classifier (loopback, RFC 1918 and other private/reserved ranges, link-local, CGNAT, documentation, IPv4-mapped, NAT64, 6to4, multicast) was moved verbatim from `@lilac/import-stack` into `@lilac/network-policy`. `@lilac/import-stack` now imports it and re-exports the same functions; its tests pass unchanged, and a test asserts the re-exports are the same function objects.

## Policy

- Modes: `offline` (default; no network, no loopback), `local-only` (loopback only), `allowlist` (explicit grants; only this mode may carry grants).
- Grants: capability (`provider.inference`, `import.fetch`, `asset.fetch`, `update.check`, `collaboration.sync`), scheme, exact host or `*.suffix` (strict subdomains, at least two labels), port (null means the scheme default only), `allowPrivateNetwork`, purpose.
- `evaluateUrl` (before DNS) refuses non-http(s) schemes, embedded credentials, and unmatched grants; loopback targets need an explicit loopback grant; private IP literals need `allowPrivateNetwork`.
- `evaluateResolved` (after DNS) checks every resolved address against the decision: loopback grants must stay on loopback, other grants may never resolve to loopback, and private or reserved addresses need `allowPrivateNetwork`. This defeats DNS rebinding when callers pass the addresses they actually connect to.
- Decisions are data with reasons; the package never opens connections or resolves names.

## Providers

- Kinds: `in-process`, `local-process` (no network), `loopback-http`, `remote-http` (endpoint required; loopback and remote are enforced by endpoint host).
- Credentials are references only (`env` variable name or `os-keychain` id). Descriptors reject unknown fields, so values such as `apiKey` cannot be registered; endpoints may not embed credentials, queries, or fragments.
- `resolveProvider` returns the first provider the policy permits, with a reason for each rejected provider.

## Offline guarantee

`tests/offline-guarantee.test.mjs` replaces `net.connect`, `net.createConnection`, `net.Socket#connect`, `tls.connect`, `http.request/get`, `https.request/get`, `dns.lookup/resolve*` (callback and promise APIs), and `fetch` with recorders that throw, then calls `syncBuiltinESMExports()` so named ESM imports of those builtins (as used by `@lilac/import-stack`) are trapped too. A first test proves the trap intercepts. The second runs the core workflow: create a project, commit, checkpoint, commit, close, reopen; design-method review; decision assurance across two candidates with rule packs; offline HTML import; and the default policy and readiness checks. It asserts zero network attempts.

Static review: none of the exercised packages captures `fetch` or a network function at load time; the only network imports are named builtin imports in `@lilac/import-stack` (`mirror.ts`, `transport.ts`), which the trap covers.

## Parity

LILAC-D6 ("core workflow passes with external network disabled") is moved to `PARITY_PROVEN` citing this test, `tests/network-policy.test.mjs`, and `tests/persistence.test.mjs`.

## Non-goals

No HTTP client, resolver, provider implementation, OS keychain integration, or policy UI.

## Qualification

Recorded on Issue #80 after exact-head CI, Alibaba Open Code Review delegation with host-agent rule application, the pstack review panel, and Jev. Cubic, CodeRabbit, and Qodo are not qualification evidence.
