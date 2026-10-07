# PC-L1: Apache-2.0 source, provenance and license audit

The founder's target project license is Apache-2.0. Per the founder's decision, it is applied only after this audit proves the posture. This grain lands the audit, the evidence register and the notice fixes. It does not declare the project license, because one item cannot be proven from the repository (see "Blocking item").

Audited at main `e702f58914cb4df13e005447889665b1ca36060c`. The machine-readable result is `docs/provenance/LICENSE_REGISTER.json`, and `tests/license-register.test.mjs` keeps it complete and consistent.

## Method

1. Every lockfile package (`package-lock.json`).
2. Every donor named in package provenance records (`repository:`, `donor:` or `guidanceDonor:` in `packages/*/src`) and in the donor ledger tables of `docs/DONORS.md`.
3. Optional runtime components invoked from package code.
4. Everything vendored under `.claude/skills`.
5. Fixtures, fonts and images. There are no font or image files in the repository.

For each item, the use was taken from the repository's own provenance records and grain evidence. Upstream license files were fetched at the pinned revision on 2026-10-07 from `raw.githubusercontent.com`.

| Upstream file | Result | sha256 |
|---|---|---|
| `phthomas/pstack@faa4e9f/LICENSE` | MIT, Copyright (c) 2026 Philip (@phthomas) | `ebabcf493e18dc0eb4a22117c9b307d26f4ac05ba6bafdd2038d414b1e348164` |
| `okooo5km/jev` HEAD `LICENSE` / `NOTICE` | Apache-2.0; byte-identical to the vendored `.claude/skills/jev/LICENSE.txt` and `NOTICE` | `4dd1386924…cdb9` / `9d46eb7bd8…fe4e` |
| `pbakaus/impeccable@e103efe…/LICENSE` | Apache-2.0; identical to the installed package's LICENSE | `02bb8c3b4e…1812` |
| `pbakaus/impeccable@e103efe…/NOTICE.md` | third-party notice for MIT-licensed platform reference files that are not in the npm package | `c60a093c28…fdcb` |
| `bytedance/UI-TARS-desktop@2ff41a9…/LICENSE` | Apache-2.0; no NOTICE file at that revision (HTTP 404) | `c71d239df9…0ab4` |
| `unreallabsai/unreal-agent@1b9f778…/LICENSE` | MIT, Copyright (c) 2026 Unreal Labs | `1d34f490ef…12f6` |
| `kgoedecke/doop@d99c8b1…/LICENSE` | GNU AGPL v3 | — |

## Findings

**Proven compatible with an Apache-2.0 project.** Every item below is permissive or reference-only, and none places obligations beyond the notices recorded.
- **Dependencies:** parse5 (MIT), entities (BSD-2-Clause), impeccable and its platform binaries (Apache-2.0, run as a separate process).
- **Code donors, with concepts adapted into Lilac-authored code:** Unreal Agent (MIT), Firstmate (MIT), UI-TARS (Apache-2.0, no NOTICE upstream).
- **Guidance-only donors:** classifier-dev, no-mistakes, Appllama and Website-downloader (all MIT), design-resources (CC0-1.0), and the Impeccable project.
- **Optional runtime components, never shipped:** Docling, Playwright and system browsers.
- **Dev tooling:** jev (Apache-2.0) and pstack (MIT).

**Reference-only, and kept that way.** Nothing is copied from these.
- Doop (AGPL-3.0-only) and Firecrawl (AGPL-3.0). Their provenance records say `importedCode: false`, and the test enforces it. The Firecrawl surface is a connector interface only.
- jev_search (no license).
- The public `paper-design/*` repositories without a recorded license.

**Fixed in this grain:**
- `THIRD_PARTY_NOTICES.md` now covers all of these:
  - the Unreal Agent copyright line;
  - the substance of Impeccable's upstream NOTICE;
  - Firstmate;
  - the guidance-only and reference-only lists;
  - optional runtime components;
  - dev tooling.
- `packages/agent-supervisor/NOTICE.md` (the Firstmate MIT text) and the register ship in the release bundle.
- pstack's MIT license is vendored as `.claude/skills/PSTACK-LICENSE`. The vendored skills had none.

## Blocking item: founder confirmation required

**Paper.design** is proprietary. `docs/provenance/PAPER_AUTHORIZATION.md` records that the owner has full permission to use, copy and modify the Paper source for Lilac. It does not address distribution or sublicensing, which an Apache-2.0 grant passes on to every recipient.

The repository has never committed Paper source: there is no `imports/` directory in history. But Lilac does carry Paper-derived interface facts and behaviour, written in Lilac's own code:
- the 36 public MCP tool names and their classification (`packages/mcp-protocol/src/paper-tools.mjs`);
- behaviour compatibility in `collaboration` and `import-stack`, written after studying recovered runtime evidence.

Before Apache-2.0 is declared, the owner must confirm one of two things:
1. the Paper authorization permits public distribution and sublicensing of these Lilac-authored, Paper-compatible interfaces and behaviour; or
2. which of them must be isolated from the Apache-2.0 grant, or replaced.

Paper names and marks are not licensed either way. Until confirmation, `tests/license-register.test.mjs` keeps the project license undeclared (no `license` field, no `LICENSE` file). After confirmation, a follow-up grain (PC-L2) does the following:
- adds the `LICENSE` and `NOTICE` files;
- sets `"license": "Apache-2.0"` in the root and workspace manifests, and regenerates the lockfile;
- carries the workspace license through the SBOM, replacing `NOASSERTION`;
- bundles `LICENSE` and `NOTICE`;
- pins their line endings.

## Not proven here, and not needed for the decision

- The owner's recorded permission for the AGPL donors (`docs/provenance/AUTHORIZED_DONOR_EXPANSION_2026-10-03.md`) is not needed while they stay reference-only.
- The models used by the optional Docling runtime keep their own licenses, which matters only if they are ever bundled.
