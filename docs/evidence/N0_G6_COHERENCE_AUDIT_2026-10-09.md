# N0-G6: architectural coherence and Paper independence audit

Issue: #190 (N0 umbrella). The audit was made on `main` at `825bb3e`, after N0-G1 through N0-G5.

## Paper independence
- **Product code.** No package, script or test depends on Paper.
  - No package imports, mirrors or checks against a Paper artifact. Since N0-G4, the MCP surface is Ninerr's own 16-tool catalog with Ninerr names.
  - The only Paper mentions left in `packages/` are two provenance records: `@ninerr/collaboration` and `@ninerr/import-stack`. They cite retired behaviour evidence through `docs/provenance/RETIRED_PAPER_RECORDS.md`.
  - In `scripts/`, the only mentions are the census policy rules that keep the retired recovery paths gated.
  - In `tests/`, they are the provenance assertions and the census rule inputs.
- **Tooling and evidence.** N0-G5 retired every Paper recovery workflow, script and dated evidence record. Git history keeps each one, and the retired record pins each by blob.
- **Source.** The PC-L1 audit found that no Paper source was ever committed. `tests/license-register.test.mjs` keeps checking the working tree for it.
- **Still to do.**
  - **N0-G7:** the Paper authorization record and the license register's Paper entry, as part of the license work.
  - **N0-G8:** the Paper mentions in `README.md`, `docs/ARCHITECTURE.md`, `docs/CURRENT.md`, `docs/MASTER_PLAN.md`, `docs/PARITY_MATRIX.md` and `THIRD_PARTY_NOTICES.md`. These are documents, not code.

## Donor identity in code
Every donor name left in `packages/` is an attribution:
- the provenance constants of `@ninerr/agent-events` (UI-TARS), `@ninerr/agent-runtime` (unreal-agent) and `@ninerr/agent-supervisor` (firstmate);
- the agent supervisor's README and NOTICE, citing firstmate's MIT terms;
- the method pack's note on the studied Appllama skill;
- the import stack's `firecrawl: "external-connector-only"` posture.

None is used as a product or identifier name. Whether an attribution may be dropped is a license question, and N0-G7 decides it. These stay until then: a third party's obligations are never removed on an identity basis.

## Product identity left in code
Four code references to `lilac` remain, each a deliberate refusal of the old identity:
- `packages/desktop/src/resolve.mjs` and `scripts/package-desktop.mjs` refuse the `@lilac/` scope;
- `packages/renderer/src/index.mjs` refuses document attributes with the `data-lilac` prefix;
- `packages/studio-web/src/app.mjs` recognizes journal entries recorded with `lilac:` tools.

The legacy readers (`legacy.ts`) and their tests are classified as legacy identity. N0-G9's identity gate allowlists these refusals by rule.

## Architecture coherence
- **Packages and subsystems.** Each of the 26 workspace packages owns at least one subsystem, and no script is unreferenced. The catalog has 21 implemented, 8 stub and 6 planned subsystems.
- **Statuses.** "Stub" means a delivered slice with a planned remainder, the meaning `docs/CURRENT.md` uses throughout. Four subsystems were stubs whose boundaries described only delivered work:
  - **`mcp-surface`** became a stub in P05 D6b because the endpoint did not exist yet. PC5 delivered the endpoint, but the status was not updated. `docs/MCP.md` already called the server implemented, so the two contradicted each other.
  - **`studio-host`** was a stub "for this slice" in PC1. PC4 through PC11 delivered the rest.
  - **`editor-shell`** was a stub for part 1 of PC4, which "PC4 completes".
  - **`canvas-viewport`** was a stub since PC3. Pan, zoom, viewport transforms and hit testing are implemented in `packages/canvas/src/index.mjs`. The remainder that PC3 named (rotation, grouping, clipping and snapping) belongs to `selection-transform`, which stays a stub.

  All four are now `implemented`. A new test in `tests/architecture.test.mjs` requires every stub's boundary to name what remains planned, so a delivered subsystem cannot stay a stub. It fails on the previous catalog, naming `canvas-viewport` first.
