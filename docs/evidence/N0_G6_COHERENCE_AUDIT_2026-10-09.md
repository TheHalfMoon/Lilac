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

## Donor and third-party names in code
Two kinds of name remain in `packages/`.

**Attributions** to studied or adapted sources:
- the provenance records of:
  - `@ninerr/agent-events` (UI-TARS);
  - `@ninerr/agent-runtime` (unreal-agent);
  - `@ninerr/agent-supervisor` (firstmate, also in its README and NOTICE, under firstmate's MIT terms);
  - `@ninerr/collaboration` (doop);
  - `@ninerr/decision-router` (classifier-dev);
  - `@ninerr/delivery-governance` (no-mistakes);
  - `@ninerr/design-method` (design-resources and Appllama, also in a note in `packs.ts`);
  - `@ninerr/import-stack` (docling, Website-downloader and firecrawl);
- the import stack's `firecrawl: "external-connector-only"` posture.

**Independent runtimes** Ninerr invokes. Their names are part of the interface:
- `impeccable` is a dependency of `@ninerr/design-assurance`. Its rule IDs (`impeccable/...`) and its `IMPECCABLE_BROWSER` setting carry its name.
- docling is an optional local adapter in `@ninerr/import-stack` (`adapter: "docling"`, `format: "docling-json"`).

The census policy classifies both as third-party obligations, not donor identity.

Neither kind is Ninerr's product name. Whether an attribution may be dropped is a license question, decided in N0-G7. Until then, every one stays: a third party's obligations are never removed on an identity basis.

## Product identity left in code
Four code references to `lilac` remain, each deliberate. Three refuse the old identity, and one recognizes it in history:
- `packages/desktop/src/resolve.mjs` and `scripts/package-desktop.mjs` refuse the `@lilac/` scope;
- `packages/renderer/src/index.mjs` refuses document attributes with the `data-lilac` prefix;
- `packages/studio-web/src/app.mjs` recognizes journal entries recorded with `lilac:` tools.

The legacy readers (`legacy.ts`) and their tests are classified as legacy identity. No census rule exempts these four yet; N0-G9's identity gate will allowlist them by rule.

## Architecture coherence
- **Packages and subsystems.** Each of the 26 workspace packages owns at least one subsystem, and no script is unreferenced. After this audit the catalog has 20 implemented, 9 stub and 6 planned subsystems.
- **Statuses.** "Stub" means a delivered slice with a planned remainder of its own, the meaning `docs/CURRENT.md` uses throughout. "Implemented" means the boundary describes no planned work of the subsystem's own; it may say that other subsystems are planned.
  - **Seven entries contradicted this.** Five stubs described only delivered work:
    - **`mcp-surface`** became a stub in P05 D6b, when the endpoint did not exist. PC5 delivered the endpoint and kept the status on purpose, because 15 of the 36 recorded Paper tools were implemented (`PC5_MCP_SERVER_2026-10-07.md`); PC6B made it 16. N0-G4 replaced that list with Ninerr's own 16-tool catalog, and all of it is implemented. That removed the remainder. `docs/MCP.md` already called the server implemented.
    - **`studio-host`** was a stub "for this slice" in PC1. PC4 through PC11 delivered the rest.
    - **`editor-shell`** remained a stub after PC4. Its named remainder, agent attribution with real agent grants (`PC4_EDITOR_2026-10-07.md`, "owned by later grains"), arrived with PC5.
    - **`canvas-viewport`** was a stub since PC3. Pan, zoom, viewport transforms and hit testing are implemented in `packages/canvas/src/index.mjs`. The remainder PC3 named (rotation, grouping, clipping and snapping) belongs to `selection-transform`, which stays a stub.
    - **`renderer`** is the same case. Its boundary names only other subsystems as planned: tokens, text, vector and media.

    Two implemented entries stated planned work of their own:
    - **`desktop-bridge`:** "Publisher signing and notarization are planned (#139)."
    - **`import-export`:** "Export side planned." That text was also stale, because export to code exists: a layer as a JSX component, through `POST /api/code/export` (PC6).
  - **Now.**
    - The five stubs are `implemented`.
    - `desktop-bridge` is a `stub`.
    - `import-export` is a `stub` whose boundary says what is delivered (export to code) and what is planned (images, PDF and other file formats).
  - **A test in `tests/architecture.test.mjs`** checks both directions. A stub's boundary must state a planned remainder, and an implemented boundary must not. It collects every contradiction before asserting, so run against the previous catalog it reports all seven entries in one failure.
  - **What a phrase cannot show.** No phrase can tell whose remainder a sentence names, which is how `renderer` passed an earlier draft of the test. Review checks that.
  - **Open for P08.** The delivered export to code lives in `@ninerr/code-ir` and `@ninerr/studio-host`, while `import-export` is owned by `@ninerr/import-stack`. `images-media` also claims export semantics, which overlaps the planned image export. P08's qualification decides which subsystem owns which export; this audit records the overlap without moving ownership.
