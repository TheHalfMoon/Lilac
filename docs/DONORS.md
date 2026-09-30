# Lilac Donor and Provenance Ledger

This ledger tracks code, design, architecture, and behavior sources considered by Lilac. It is not a substitute for legal advice or the original authorization documents.

## Primary authorized donor

### Paper.design product source

- Role: **primary foundation / authorized donor**
- Authorization basis: project owner explicitly states they have full permission to copy, modify, and use the Paper.design source code for Lilac.
- Exact artifact/repository: **not yet available in connected sources**
- Exact revision/hash: **pending intake**
- Import state: **NOT IMPORTED**
- Rule: do not represent public utility repositories as the complete Paper product source.

### Public Paper repositories observed

| Repository | Observed purpose | Public license observed | Intended Lilac use |
|---|---|---|---|
| `paper-design/shaders` | zero-dependency canvas shaders | Apache-2.0 | donor/module candidate; preserve notices |
| `paper-design/paper-mono` | Paper Mono font | SIL OFL 1.1 | optional font asset; not app source |
| `paper-design/opentype.js` | Paper fork of opentype.js | MIT | typography dependency/reference |
| `paper-design/agent-plugins` | agent harness integration | no license conclusion recorded here | architecture/reference; user authorization applies to Paper source, but preserve upstream notices |
| `paper-design/google-fonts-scripts` | font metadata/build scripts | pending exact license check | tooling/reference |
| `paper-design/liquid-logo` | shader demo/application | pending exact license check | reference only unless intentionally imported |
| `paper-design/webmcp-agent-example` | WebMCP example harness | pending exact license check | MCP integration reference |

## External reference: Doop

`kgoedecke/doop` is a public Paper alternative and was reviewed only as a competitive/architectural reference. Its public repository is AGPL-3.0. **Do not copy Doop code into Lilac** unless a separate explicit licensing decision is made. Reading public behavior/architecture for interoperability and product analysis is not a donor import.

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

Authorization to use source code does not imply ownership of names, logos, or trademarks. Lilac ships with its own product name, identifiers, visual identity, domains, update channels, and service endpoints. Required attribution remains in legal/provenance surfaces rather than masquerading as Paper.
