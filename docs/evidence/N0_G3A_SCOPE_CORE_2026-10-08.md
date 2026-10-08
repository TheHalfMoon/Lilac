# N0-G3a: the core packages move to the @ninerr scope

Issue: #190 (N0 umbrella). This is the first of the batches that move the workspace packages from `@lilac/*` to `@ninerr/*`.

## Approach
- **Batches.** The move happens in batches, so each pull request stays within the exact-head reviewer's context. Each batch renames a set of packages together with every reference to them: manifests, the lockfile, imports, provenance records, documentation and tests. The tree is consistent after every merge.
- **One script.** `@lilac/<name>` is rewritten to `@ninerr/<name>` in every tracked text file except dated evidence (`docs/evidence/`) and the frozen legacy corpus (`tests/fixtures/projects/v1-*`).
- **Both scopes during the transition.** The places that resolve or validate a workspace package by scope accept both `@ninerr` and `@lilac`:
  - the packaged desktop app's resolver (`packages/desktop/src/bootstrap.mjs`);
  - the packaging dependency walk (`scripts/package-desktop.mjs`);
  - the architecture catalog's owner validation.

  The last batch removes `@lilac`.

## This batch
`document-model`, `history`, `persistence`, `network-policy`, `code-ir`, `renderer` and `canvas`: 150 references in all.

`npm ci` installs from the rewritten lockfile, and links the seven packages under `node_modules/@ninerr`.

One test compared a sorted dependency list with a hand-ordered expectation. With both scopes present that order no longer holds, so the expectation is now sorted as well.

## Persisted data
Package names are not persisted for behaviour. Journal entries from earlier releases record tool names such as `@lilac/import-stack` as attribution only, and nothing reads them back.

## Review delta 1

The light ps-review panel, with the resolver checked for security, found no must-fix. Taken from its worth-considering items, the packaged app's resolver is now in `packages/desktop/src/resolve.mjs`, as a plain function that `bootstrap.mjs` registers:
- **Case-insensitive scope.** The workspace scope is matched without regard to case. On Windows and macOS, `@Ninerr/…` or `@Lilac/…` could otherwise reach a workspace link outside the app.
- **Names must match.** A resolved package's manifest must name itself exactly as the specifier does. A packaged build can therefore not quietly accept a stale name that a checkout would refuse.
- **Tested.** `tests/desktop-package.test.mjs` covers entries, normal resolution, a look-alike scope, subpaths, empty and traversing names, other spellings of the scope, and a stale name.
