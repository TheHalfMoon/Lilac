# Ninerr Donor and Provenance Ledger

This ledger tracks code, design, architecture, and behavior sources considered by Ninerr. The project was renamed in 2026-10 (N0); the authorization records cited below use its earlier name. It is not a substitute for legal advice or the original authorization documents. The A/B classification of every source is in `docs/provenance/LICENSE_REGISTER.json`, and the founder's authorization is in `docs/provenance/FOUNDER_AUTHORIZATION_2026-10-08.md`.

Paper, Paper.design and the other names in this ledger belong to their owners. They are named here as provenance only, and none of them is Ninerr's identity.

## Primary authorized donor

### Paper.design product source

- Role: **primary foundation / authorized donor**
- Authorization basis: project owner explicitly states they have full permission to copy, modify, and use the Paper.design source code for this project.
- Source access: the private product monorepo (`paper-design/paper`) was not available through connected GitHub sources, and the complete original repository was never recovered.
- Recovery study: a partial recovery from publicly shipped Paper Desktop packages was studied (state `PARTIAL_RECOVERY_PROVEN`). N0-G5 retired that tooling and its records.
- In Ninerr: no recovered Paper source was ever committed (`docs/provenance/LICENSE_REGISTER.json`, entry `paper-design/paper`).
- Public-repository boundary: raw proprietary source stays out of the public repository unless public redistribution rights are separately established.

The recovery records, retired from the tree in N0-G5 and pinned in `docs/provenance/RETIRED_PAPER_RECORDS.md`:

- `PAPER_PUBLIC_SHIPPED_RECOVERY_CENSUS_2026-10-01.md`
- `PAPER_DESKTOP_HISTORY_EXPANSION_2026-10-01.md`

### Public Paper repositories observed

| Repository | Observed purpose | Public license observed | Intended Ninerr use |
|---|---|---|---|
| `paper-design/shaders` | zero-dependency canvas shaders | Apache-2.0 | reference only; nothing copied. Separately licensed (category B): incorporating any of it would bring its own license obligations |
| `paper-design/paper-mono` | Paper Mono font | SIL OFL 1.1 | reference only; nothing copied. Separately licensed (category B): incorporating any of it would bring its own license obligations |
| `paper-design/opentype.js` | Paper fork of opentype.js | MIT | reference only; nothing copied. Separately licensed (category B): incorporating any of it would bring its own license obligations |
| `paper-design/agent-plugins` | agent harness integration | no license conclusion recorded here | architecture/reference only; a separately licensed public repository, outside the founder-authorized set (see `docs/provenance/FOUNDER_AUTHORIZATION_2026-10-08.md`) |
| `paper-design/google-fonts-scripts` | font metadata/build scripts | no license file at the upstream root (2026-10-07) | reference only; nothing copied |
| `paper-design/liquid-logo` | shader demo/application | PolyForm Shield 1.0.0, source-available (2026-10-07) | reference only; nothing copied |
| `paper-design/webmcp-agent-example` | WebMCP example harness | no license file at the upstream root (2026-10-07) | reference only; nothing copied |

## External MIT donor/reference: `vcashwin/paper-snapshot`

- Repository: `vcashwin/paper-snapshot`
- Observed main revision: `12920e03e5bd6758a5e5d20db92b68e0410b0fb0`
- License: MIT, copyright 2026 vcashwin.
- Classification: **independent third-party donor/reference**, not an official Paper repository and not proof of Paper ownership/original source.
- Purpose: readable TypeScript implementation of a Paper-compatible DOM capture and inline-style serialization pipeline.
- Relevant packages:
  - `@paper-snapshot/core` — picker, capture, serializer, clipboard, styles, text, wrapping;
  - `@paper-snapshot/react` — React capture UI/hook surface;
  - `@paper-snapshot/electron` — Electron clipboard and guest/webview capture support.
- High-value source paths include `packages/core/src/capture.ts`, `picker.ts`, `serialize-node.ts`, `serialize.ts`, `styles.ts`, `text.ts`, `types.ts`, and Electron/React adapters.
- Use in Ninerr: reference only; nothing copied, and no package refers to it (`docs/provenance/LICENSE_REGISTER.json`). Copying any substantial portion would require keeping its MIT copyright and permission notice.
- Provenance rule: any code imported from this repository must retain its own donor record and must never be mislabeled as recovered proprietary Paper source.

## Authorized external donor expansion — 2026-10-03

The project owner explicitly states that they have permission to use, copy, modify, combine, and adapt source code from the following projects for this project. The governing attestation is recorded in `docs/provenance/AUTHORIZED_DONOR_EXPANSION_2026-10-03.md`.

The middle column is the use intended at intake. What each donor actually contributed, its category and its license are in `docs/provenance/LICENSE_REGISTER.json`.

| Donor | Intended Ninerr use | Intake note |
|---|---|---|
| `kunchenguid/firstmate` | multi-agent orchestration, isolated worktrees, supervision, restart reconciliation | bounded extraction; do not import product identity |
| `kunchenguid/no-mistakes` | guarded review/test/PR delivery state machine | adapt pipeline concepts to Ninerr governance; no automatic force-push policy |
| `kgoedecke/doop` | multiplayer canvas, MCP collaboration, comments/activity, presence | reference only: its public license is AGPL-3.0, and no Doop code is in Ninerr (`packages/collaboration/src/provenance.ts`, `importedCode: false`) |
| `classifier.dev` public surfaces | decision/classification routing, retrieval pruning, uncertainty-aware escalation | hosted use optional only; core Ninerr must not require paid service |
| `caio0452/jev_search` | code/directory candidate search and decision-based filtering | upstream warns it is AI-generated/not production-ready; ideas require hardening/tests |
| `unreallabsai/unreal-agent` | durable async agent sessions, idempotency, serializable operations, recovery/forks | high-value agent-runtime donor |
| `AhmadIbrahiim/Website-downloader` | recursive website/asset capture fallback | sandbox, quotas, SSRF/network policy required |
| `Appllama/appllama-skills` | design research/build methodology, mobile/native quality and simulator verification | MIT skills observed; paid MCP must remain optional |
| `docling-project/docling` | local document/PDF/layout/table/OCR parsing | MIT codebase observed; model-specific licenses remain separate |
| `reinaldosimoes/design-resources` | design-resource taxonomy and discovery catalog | linked third-party assets retain independent licenses; catalog is not blanket asset permission |
| `firecrawl/firecrawl` | resilient crawl/scrape/action architecture and structured web extraction | extract self-hostable patterns; hosted API is not a required dependency |
| `pbakaus/impeccable` | deterministic design detectors and critique/polish/harden workflows | design-quality/decision-assurance donor |
| `bytedance/UI-TARS-desktop` | multimodal GUI/browser operator, event stream, local/remote operator architecture | visual fallback and computer-use architecture donor |

The integration plan that allocated these donors to grains 1 to 9 has been carried out. It is recorded in `docs/evidence/DONOR_INTEGRATION_MAP_2026-10-09.md`, with the study behind it in `docs/evidence/DONOR_DEEP_STUDY_2026-10-03.md`.

### Authorization does not erase upstream obligations

Owner authorization permits this project's use but does not automatically redefine third-party dependency licenses, contributor rights, trademark rights, or attribution requirements. Before importing code from any donor:

- pin the exact revision;
- preserve license/NOTICE/copyright files applicable to the imported portion;
- inventory material third-party dependencies;
- record any separate permission basis when it differs from the public license;
- keep donor branding and hosted-service credentials out of Ninerr identity.

## Intake requirements for every donor snapshot

Record:
1. donor name and repository/artifact source;
2. authorization/license basis;
3. exact commit/tag/version or artifact hash;
4. import date;
5. full SHA-256 file manifest;
6. original license/NOTICE/attribution files;
7. local modifications after intake;
8. third-party dependency inventory where practical.

## Branding rule

Authorization to use source code does not imply ownership of names, logos, or trademarks. Ninerr ships with its own product name, identifiers, visual identity, domains, update channels, and service endpoints. Required attribution remains in legal/provenance surfaces rather than masquerading as Paper.
