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
