# N0-G7a1: founder-authorized sources (A) and independent third parties (B)

Issue: #190 (N0 umbrella). This is the first part of the source-rights audit the founder required before Apache-2.0 is declared. N0-G7a2 resolves the two remaining entries and declares the license.

- **The founder's authorization** is recorded verbatim in `docs/provenance/FOUNDER_AUTHORIZATION_2026-10-08.md`, with the founder's license instruction.
  - Its scope is the projects that earlier owner attestations record: Paper.design (`PAPER_AUTHORIZATION.md`), and the thirteen donor projects in `AUTHORIZED_DONOR_EXPANSION_2026-10-03.md`.
  - The record states only what the founder wrote. It extends the authorization to nothing else and removes no category B obligation.
- **Every register entry now has a `category`.**
  - **A: 14 entries.** These are the authorized projects; Paper has two entries. Docling is the exception: its entry is the runtime the user installs, so it is B.
  - **B: 25 entries.** These are the shipped npm dependencies, the Electron runtime, optional runtimes Ninerr does not ship (including the Docling CLI), development tooling, and studied public repositories outside the authorized set.
  - The `impeccable` npm package is category B as a shipped dependency, although its upstream project is an authorized donor.
- **`tests/license-register.test.mjs` checks the classification.** It checks three things:
  - every attested project has a register entry;
  - an entry is A exactly when it is an attested project's own source;
  - every dependency, bundled runtime or optional runtime is B, even when its upstream project is attested.

The two Paper entries stay `founder-confirmation-required` in this part, so the existing gate still holds: no license is declared.
