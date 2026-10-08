# N0-G2c: migrating projects from before the rename

Issue: #190 (N0 umbrella). Builds on N0-G2b, the Ninerr project format.

## Behaviour

- **`projectLayout(root)`** reports `current`, `legacy` (only a `.lilac` project) or `none`. It only reads.
- **`migrateLegacyProject(root, { owner, at })`** turns a legacy project into `<root>/.ninerr`. The order of work is what makes it safe:
  1. **Lock.** It takes the legacy project's own writer lock. There is no override, so a project still open in the earlier release refuses with `PersistenceLockError`.
  2. **Verify everything.** It runs `readVerifiedProject` on the legacy directory: manifest, built-in 1-to-2 migration, snapshot, document, the full journal chain from the legacy genesis domain, and replay. A newer, damaged or wrong-format legacy project is refused here, and nothing has been created yet.
  3. **Assemble.** It builds the new directory in a `.ninerr.tmp-*` sibling.
     - Every object is re-read through `getObject`, which checks its hash, and stored through `putObject`. An unreferenced damaged object is therefore caught by the copy, not only the snapshot document.
     - The journal is written byte for byte (a torn tail included), followed by the snapshot and the migrated manifest.
  4. **Re-check and rename.** It re-checks the legacy directory's identity, then renames the staging directory into place. A crash leaves either no `.ninerr` or a complete one, and a leftover staging directory is not a project.
  5. **Release.** The legacy lock is released. The legacy directory is otherwise never written.
- **The studio host** lists legacy projects with the others. Opening one migrates it first. The session's `recovery` carries `legacyProject: true` and `migratedFrom: 1`, and the editor shows a plain note that the project was copied into the Ninerr format and the original is unchanged.

## Tests

- **`tests/legacy-migration.test.mjs`**, on the frozen `v1-basic` corpus:
  - **Exact copy.** Journal, snapshot and objects are byte-identical, the migrated manifest bytes are pinned, and the legacy directory is byte-identical afterwards.
  - **Equivalence.** The migrated document equals the v2 golden document, which has the same history.
  - **Commits continue.** Commits and a checkpoint after migration extend the legacy chain.
  - **Determinism.** Two migrations produce the same bytes.
  - **Refusals create nothing and change nothing.** Covered cases: a newer schema, a corrupt journal, a wrong legacy format, a current-schema manifest in the legacy directory, a damaged unreferenced object, a newer journal format, a locked legacy project, an existing Ninerr project, and no legacy project.
  - **Torn tail and stale temporaries.** A torn legacy tail is carried over and recovered by the first open; stale temporaries are not copied.
- **`tests/crash-recovery.test.mjs`:** a migration interrupted before its directory rename leaves no Ninerr project, and simply migrates again.
- **`tests/legacy-host.test.mjs`:** the studio host lists and opens a legacy project, reports `legacyProject`, and leaves the legacy directory byte-identical.
- **`tests/release-docs.test.mjs`:** the `docs/MIGRATION.md` example runs as written on the legacy corpus.

## Residuals

- **Ninerr changes are not written back.** After migration, the earlier release still opens the legacy directory, but changes made in Ninerr are not written back to it. Once `.ninerr` exists, it is the project.
- **Leftover staging directories are not cleaned up.** A crash during migration can leave a `.ninerr.tmp-*` directory, as an interrupted `createProject` can. Neither is removed automatically.

## Review delta 1

The full ps-review panel found one host must-fix in this grain. A locked legacy project returned `project-locked`, so the editor offered a takeover that could never work, because migration never overrides a legacy lock.
- It now returns `409 legacy-project-locked` with what to do: close the project in the earlier release, or, if that release crashed, remove its `.lilac/lock`. The editor shows that message instead of the takeover dialog.
- This is tested both with and without `breakStaleLock`. Nothing is created and the legacy lock is left in place.

Also taken from the panel's worth-considering items:
- **Object fan-out entries.** A two-hex entry under the legacy `objects/` that is not a real directory is corruption. Before, it was skipped and its objects silently left behind (tested).
- **Staging is verified before the rename.** The staging copy is checked as a project (`readVerifiedProject`), so an incomplete copy can never become `.ninerr`.
- **Rename failures.** A rename that fails because `.ninerr` appeared meanwhile is reported as "already exists". Windows reports it as `EPERM`.
- **Concurrent hosts.** When another host migrated the project meanwhile, the studio host opens it.
- **Documentation.** `docs/MIGRATION.md` now says the snapshot reference is rewritten as the same canonical JSON, not copied byte for byte. It also states the read-only-storage residual.

## Review delta 2

The delta re-review found no must-fix. Taken from it: `legacy-project-locked` now distinguishes a running lock holder from a stopped one.
- **A running holder** can be the earlier release, or another Ninerr window migrating the project at that moment. The person is told to close it there or wait, and is never told to remove the lock.
- **A stopped holder** gets the advice to remove the lock.

Both cases are tested.
