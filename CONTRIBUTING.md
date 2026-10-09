# Contributing to Ninerr

## Setting up
Ninerr needs Node.js 22.18 or later.

```bash
npm ci --ignore-scripts
npm test
```

- `npm test` runs the test suite with Node's test runner.
- `npm run check` also syntax-checks every entry module, then runs the suite.
- `npm run smoke` runs the offline smoke workflow.

The browser end-to-end tests drive a local Chromium through `playwright-core`. They use `NINERR_TEST_BROWSER` when it is set, then the Playwright browser cache, then a system Chrome or Chromium. Locally, a test is skipped when no browser is found; in CI it fails. The desktop tests need the pinned Electron runtime: `node scripts/fetch-electron.mjs` downloads it and verifies its SHA-256.

CI runs on Linux. Some tests fail on Windows (#192).

## Before opening a pull request
- **Tests.** Add or update the tests that prove the change, and run the suite.
- **The identity gate.** Ninerr ships no other product's names, marks or identifiers. `node scripts/identity-census.mjs --check` must report no gated findings. If a change adds a deliberate exception, it belongs in `scripts/identity-policy.json` as a narrow rule with a reason. Afterwards `node scripts/identity-census.mjs --write` refreshes the census summary.
- **Sources and licenses.** Every dependency and every GitHub project the repository links to is recorded in `docs/provenance/LICENSE_REGISTER.json`, and the tests enforce it. If a change adds a third-party source, register it, and add its notices to `THIRD_PARTY_NOTICES.md` when its license requires them.
- **Documentation.** Update the docs that describe the changed behavior. Write in English, and claim only what the tests or evidence show.

## Pull requests
Keep a pull request to one focused change, and say what it changes and how it was tested. CI runs the Foundation checks and packages the desktop app for Linux, macOS and Windows. The Foundation checks confirm that the identity census summary is current, run the identity gate and the syntax checks, and run the test suite. The maintainers review every pull request before merging. They also run the exact-head qualification and Open Code Review checks (`.github/workflows/jev-exact-head.yml`, `.github/workflows/open-code-review-delegate.yml`). Pull requests are merged with merge commits; history is not squashed or rewritten.

## Security
Do not report a vulnerability in a public issue or pull request. `SECURITY.md` describes how to report one privately.

## License
Ninerr is licensed under the Apache License 2.0. Under section 5 of that license, any contribution you intentionally submit for inclusion is licensed under the same terms, unless you explicitly state otherwise.
