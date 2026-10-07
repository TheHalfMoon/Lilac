# P06 G5c: worktree, hard-link and evidence-root escapes (#119)

Part of P06 gate 5 (#100). The findings come from the second gate-5 probe of base `d0cdc7f`, which covered the import-stack filesystem, delivery-governance, collaboration and agent-supervisor. The frozen spec is in #119.

## Changes

1. **Git inspection** (`agent-supervisor/src/local.ts`). Every Git command the inspector runs:
   - turns off repository-controlled execution on the command line: `core.fsmonitor=false`, `core.hooksPath` set to the null device, `core.untrackedCache=false`, `core.pager=cat`, `diff.external=` and `--no-optional-locks`;
   - runs without system or global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` set to the null device) and with no `GIT_*` variable inherited from the caller;
   - sets every filter driver the repository's config names to empty `clean`, `smudge` and `process` with `required=false`. Listing the names executes nothing.

   `status` also passes `--ignore-submodules=dirty`, so Git never runs inside a submodule worktree, whose own filters are not overridden. Commit changes in a submodule still count as dirty. Untracked or modified content inside a submodule no longer does.
2. **Single link** (`import-stack/src/filesystem.ts`). `canonicalFileWithinRoots` refuses files with `nlink > 1`. This covers local sources, Docling input and mirror objects.
3. **Evidence root** (`delivery-governance/src/evidence.ts`). The store pins its canonical root's device and inode at creation. Each `writeBundle` refuses the write unless the root is still that directory and its real path is unchanged, which also rules out symlinks in the chain. The remaining window is a swap between this check and the write.
4. **Docling output** (`import-stack/src/docling.ts`). The output is checked with `lstat` (no symlink, regular file), then opened with `O_NOFOLLOW|O_NONBLOCK`, size-checked on the open handle and read from it.
5. **Mirror jobs** (`import-stack/src/filesystem.ts`, `mirror.ts`). `safeRemoveImportJobDirectory`, and through it `disposeStaticMirror`, removes only a direct child of the work root named `<prefix>-<24 hex>`.

   **Spec adjustment.** `proposalFromStaticMirror` is not given the work root. Its verify step therefore requires the job directory to be named `mirror-<24 hex>`, rather than checking that it sits under the work root. Every object it promotes is still hash-verified against the manifest.
6. **Collaboration store** (`collaboration/src/local-store.ts`).

   **Spec deviation.** The spec assumed `load()` already failed closed. A hard-linked state file was in fact read, so `load()` now opens with `O_NOFOLLOW|O_NONBLOCK` and checks the open handle: regular file, `nlink` of 1, at most `MAX_STATE_BYTES`.

## Tests

`tests/sandbox-surfaces.test.mjs` has 8 tests. Tests 1 to 7 fail on base `d0cdc7f`, with the package changes stashed and the tests unchanged.

1. A repository whose config sets `core.fsmonitor`, a `filter.evil.clean`/`process` driver (made to run by a newer mtime on an unchanged file) and `core.hooksPath` is inspected without running any of them. No marker file appears, and the evidence is still correct: branch, head, clean, then dirty after a real change.
2. A `GIT_DIR` in the caller's environment does not redirect inspection.
3. A hard link inside the repository root to an outside file is not read as a local source.
4. Docling refuses hard-linked input, a symlinked output and a FIFO output (without blocking), and cleans its job directory.
5. Mirror disposal refuses a non-job directory and a nested path inside the work root, and both survive. Promotion refuses a renamed job directory and accepts the original.
6. An evidence root swapped for a symlink, or replaced by a fresh directory, receives no bundle. A store created over the new root writes normally.
7. Collaboration state that is a hard link or a symlink to an outside file is refused.
8. A FIFO in place of collaboration state is refused without blocking. The test runs in a child process with a timeout. It passes on base, because the `lstat` pre-check already refused it, and guards the new open path.

FIFO cases use `mkfifo`. CI runs on Linux.

## Gate

Running `npm run check` as root in this container: every test passes except "a failed journal write poisons the store until reopen". That test depends on `chmod` being enforced, which root ignores. It passes as a non-root user and in CI.

## Residual

Browser-scan residuals for gate 5 remain open in #114: DNS rebinding, redirects and subresources during a scan.
