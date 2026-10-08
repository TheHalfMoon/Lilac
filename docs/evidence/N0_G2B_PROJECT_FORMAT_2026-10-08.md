# N0-G2b: the Ninerr project format

Issue: #190 (N0 umbrella). Builds on N0-G2a, which extracted `readVerifiedProject`.

## Format

- **Location.** Projects live in `<root>/.ninerr`, with `format: "ninerr-project"` and `schemaVersion: 2`.
- **Journal genesis.** The manifest gains `journalGenesis`, the domain the journal's genesis digest is computed from (`sha256("<domain>:<projectId>")`).
  - New projects record `ninerr-journal-genesis`.
  - A project upgraded from schema 1 records `lilac-journal-genesis`, so its existing chain and every recorded digest still verify. History is never re-chained.
  - Only the two known domains are accepted. Any other value, or a missing one, is corruption.
  - Recording the other known domain breaks the chain, and that is reported as corruption too.
- **The 1-to-2 step.** `PROJECT_MIGRATIONS` gains the built-in step from schema 1 to 2.
  - It requires the legacy format, because schema 1 only ever existed in it.
  - Host steps for earlier versions run first. A built-in step always wins for its own version (`withBuiltInMigrations`).
- **The legacy identity has one home.** `packages/persistence/src/legacy.ts` holds all of it: the `.lilac` directory, the `lilac-project` format and the legacy genesis domain.

## Refusals

- **A root with only a legacy `.lilac` project.** `openProject` refuses it with a `PersistenceVersionError` and writes nothing, and `createProject` refuses to shadow it. N0-G2c adds the directory migration.
- **A schema-1 manifest inside `.ninerr`.** It upgrades in place under the existing rule: the repair is written only after every check passes. A refused open leaves the files byte-identical, even when the upgrade and a torn-tail repair were due.

## Host and tooling

These used the `.lilac` path directly and now take it from `PROJECT_FILES`:

- **Stale-lock liveness check (`packages/studio-host/src/session.ts`).** It read `${root}/.lilac/lock`. After the rename, that path no longer exists, so a stale-lock override would have broken a lock held by a live process. `tests/studio-host.test.mjs` caught this before commit.
- **The project listing.**
- **The smoke script and its expected report.** Only the manifest, journal and snapshot digests change. The document digest is unchanged.
- **The desktop smoke and journey scripts.** Their lock checks would otherwise have passed vacuously, because nothing exists under `.lilac`.
- **Every test that addressed project files by path.**

## Fixtures

- `tests/fixtures/projects/v2-basic` is the golden project of this release. `tests/support/golden-project.mjs` writes it byte for byte; its tool string is `@ninerr/import-stack`, and its project id is `golden-v2`.
- `tests/fixtures/projects/v1-basic` is unchanged and frozen as the legacy corpus. `tests/legacy-migration.test.mjs` pins its file list and manifest bytes.
- The compatibility suite now resolves fixture paths with `fileURLToPath`. On Windows, `URL.pathname` gave `/C:/...` and failed the golden tests (#192).

## Tests

- **`tests/legacy-migration.test.mjs`:**
  - A legacy-only root is refused without writing.
  - A schema-1 manifest upgrades in place, including through host steps.
  - A refused open leaves a legacy-schema project unchanged.
  - The frozen corpus is pinned.
- **`tests/migration-compatibility.test.mjs`:** schema 2 is current, schema 3 is refused, and genesis-domain validation is checked.
- **`tests/persistence.test.mjs`:** older versions need a step that yields their real format.
- **`tests/crash-recovery.test.mjs`:** an in-place upgrade interrupted before its manifest rename upgrades again.
- **`tests/release-docs.test.mjs`:** `docs/MIGRATION.md` states the current constants and the one built-in step, and its example runs as written on the legacy corpus.

Local run (Windows 11, Node 24.19.0): 735 tests, 675 pass, 26 fail, 34 skipped. Every failure is in the pre-existing Windows set recorded on #192, and none is new.
