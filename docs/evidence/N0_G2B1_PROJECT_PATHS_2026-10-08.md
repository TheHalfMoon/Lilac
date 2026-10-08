# N0-G2b1: project files addressed through PROJECT_FILES

Issue: #190 (N0 umbrella). Split out of N0-G2b (#194), whose candidate exceeded the exact-head Jev reviewer's context (HTTP 400 `max_tokens_exceeded`).

The studio host, the smoke script, the desktop smoke and journey scripts, and eight test files named the project directory `.lilac` directly. They now use `PROJECT_FILES.directory`, so they stay correct when N0-G2b changes the directory. Only the directory is abstracted at these call sites, because only the directory changes; file names inside it such as `lock` and `journal.log` stay literal there. On `main` nothing changes: the directory is still `.lilac`, and the smoke report is byte-identical.

One of these fixes matters beyond the rename. The studio host's stale-lock liveness check read `${root}/.lilac/lock`. Once the directory changes, that path would not exist, and an override could break a lock held by a live process. N0-G2b's `tests/studio-host.test.mjs` caught this.

The light ps-review panel found no must-fix. It found one missed site: a child-process script in `tests/sandbox-persistence.test.mjs` that builds `/out/.lilac/lock`. That site now uses `PROJECT_FILES` too.
