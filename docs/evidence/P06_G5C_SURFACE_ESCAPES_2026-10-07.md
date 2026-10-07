# P06 G5c: worktree, hard-link and evidence-root escapes (#119)

Part of P06 gate 5 (#100). The findings come from the second gate-5 probe of base `d0cdc7f`, which covered the import-stack filesystem, delivery-governance, collaboration and agent-supervisor. The frozen spec is in #119.

## Changes

1. **Git inspection** (`agent-supervisor/src/local.ts`). Every Git command the inspector runs:
   - turns off repository-controlled execution with command-scope config, which outranks repository config: `core.fsmonitor=false`, `core.hooksPath` set to the null device, `core.untrackedCache=false`, `core.pager=cat`, `core.sshCommand=false`, `diff.external=`, `protocol.allow=never`, and `--no-optional-locks`, plus `GIT_ALLOW_PROTOCOL=none` in the environment;
   - runs without system or global config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` set to the null device), with no `GIT_*` variable inherited from the caller, and with `GIT_NO_LAZY_FETCH=1` set;
   - sets every filter driver the repository's config names to empty `clean`, `smudge` and `process` with `required=false`. Listing the names executes nothing.

   `status` also passes `--ignore-submodules=dirty`, so Git never runs inside a submodule worktree, whose own filters are not overridden. Commit changes in a submodule still count as dirty. Untracked or modified content inside a submodule no longer does.
2. **Single link** (`import-stack/src/filesystem.ts`). `canonicalFileWithinRoots` refuses files with `nlink > 1`. This covers local sources, Docling input and mirror objects.
3. **Evidence root** (`delivery-governance/src/evidence.ts`). The store pins its canonical root's device and inode at creation. Each `writeBundle` refuses the write unless the root is still that directory and its real path is unchanged, which also rules out symlinks in the chain. The remaining window is a swap between this check and the write.
4. **Docling output** (`import-stack/src/docling.ts`). The output is read through `readSingleLinkFile`, which opens it with `O_NOFOLLOW|O_NONBLOCK` and checks the open handle: regular file, single link, bounded size.
5. **Mirror jobs** (`import-stack/src/filesystem.ts`, `mirror.ts`). `safeRemoveImportJobDirectory`, and through it `disposeStaticMirror`, removes only a direct child of the work root named `<prefix>-<24 hex>`.

   **Spec adjustment.** `proposalFromStaticMirror` is not given the work root. Its verify step therefore requires the job directory to be named `mirror-<24 hex>`, rather than checking that it sits under the work root. Every object it promotes is still hash-verified against the manifest.
6. **Collaboration store** (`collaboration/src/local-store.ts`).

   **Spec deviation.** The spec assumed `load()` already failed closed. A hard-linked state file was in fact read, so `load()` now opens with `O_NOFOLLOW|O_NONBLOCK` and checks the open handle: regular file, `nlink` of 1, at most `MAX_STATE_BYTES`.

## Tests

`tests/sandbox-surfaces.test.mjs` has 9 tests. All except the FIFO test (8) fail on base `d0cdc7f`, with the package changes stashed and the tests unchanged.

1. A repository's config sets `core.fsmonitor`, a `filter.evil.clean`/`process` driver, a `filter.a=b.clean` driver and a `core.hooksPath` holding a `post-index-change` hook; a newer mtime on unchanged files makes the filters run. Inspection runs none of them. No marker file appears, and the evidence is still correct: branch, head, clean, then dirty after a real change.
2. A `GIT_DIR` in the caller's environment does not redirect inspection.
3. A hard link inside the repository root to an outside file is not read as a local source.
4. Docling refuses hard-linked input, a symlinked output and a FIFO output (without blocking), and cleans its job directory.
5. Mirror disposal refuses a non-job directory and a nested path inside the work root, and both survive. Promotion refuses a renamed job directory and accepts the original.
6. An evidence root swapped for a symlink, or replaced by a fresh directory, receives no bundle. A store created over the new root writes normally.
7. Collaboration state that is a hard link or a symlink to an outside file is refused.
8. A FIFO in place of collaboration state is refused without blocking. The test runs in a child process with a timeout. It passes on base, because the `lstat` pre-check already refused it, and guards the new open path.
9. A partial clone whose promisor remote is an `ext::` command, with `protocol.ext.allow=always` in the repository's config, is inspected without running that command. Rename detection makes status fetch a missing blob. Added in review delta 2.

**Review delta 1.** The combined and security judges both found that a filter driver whose name contains `=` (`filter.a=b.clean`) was not neutralised, because `-c` splits at the first `=`. On head `6de2487` the test's `a=b` driver runs. The fixes:
- All overrides now go through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`. The driver listing is read with `-z`. A config read that fails for any reason except "no match" stops the inspection.
- Lazy fetch is closed with `protocol.allow=never`, `core.sshCommand=false` and `GIT_NO_LAZY_FETCH=1`.
- The hooks check in test 1 is now real: a `post-index-change` hook that plain `git status` runs.
- Local-source and mirror-object reads repeat their checks on the open handle (`readSingleLinkFile`: no-follow, non-blocking, regular, single link, bounded), as the Docling output read and the collaboration store already do.
- `disposeStaticMirror` removes only `mirror-<24 hex>` directories. Test 5 also checks that a `docling-*` job directory survives.

**Not changed.**
- Binding mirror promotion to the work root would need a new `proposalFromStaticMirror` parameter. The name shape plus hash verification stays, as recorded on #119.
- The evidence-store window between the check and the write remains. Closing it needs directory-fd writes.

**Review delta 2.** The delta re-review found that `protocol.allow=never` alone does not stop lazy fetch, because a repository's `protocol.ext.allow=always` outranks it. On Git 2.43 `GIT_NO_LAZY_FETCH` was the only thing stopping the `ext::` command, and that variable exists only where the security backport is present. Delta 2:
- sets `GIT_ALLOW_PROTOCOL=none`, which outranks every `protocol.*` setting;
- adds test 9. Test 9 fails on base and passes with `GIT_ALLOW_PROTOCOL` alone (`GIT_NO_LAZY_FETCH` removed).

It also applies the OCR rule group: the filter listing reuses `runGit` instead of repeating the `execFile` call, and the collaboration store's new `catch` no longer types the error as `any`.

FIFO cases use `mkfifo`. CI runs on Linux.

## Gate

Running `npm run check` as root in this container: every test passes except "a failed journal write poisons the store until reopen". That test depends on `chmod` being enforced, which root ignores. It passes as a non-root user and in CI.

## Residual

Browser-scan residuals for gate 5 remain open in #114: DNS rebinding, redirects and subresources during a scan.
