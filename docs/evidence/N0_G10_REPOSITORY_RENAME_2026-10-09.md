# N0-G10: the repository rename

Issue: #190 (N0 umbrella). The founder directed that the repository be renamed from `TheHalfMoon/Lilac` to `TheHalfMoon/Ninerr` with GitHub's rename, once the tests were green, and that the redirects and CI be verified.

## Precondition
The rename was made after N0-G9 merged as `aabff884d402be7b22af3b66381a9f795ca4bb2a`, and after both post-merge runs on that exact SHA had succeeded:
- **Foundation:** 771 tests, 771 pass, 0 fail.
- **Desktop package:** darwin-arm64, linux-x64 and win32-x64 each succeeded, including the 18-step journey.

Before the rename, `GET /repos/TheHalfMoon/Ninerr` returned 404, so the name was free. The TheHalfMoon account had admin permission on the repository.

## The rename
The rename used GitHub's own repository rename: `PATCH /repos/TheHalfMoon/Lilac` with `name=Ninerr`. GitHub returned `full_name` `TheHalfMoon/Ninerr` with the unchanged repository id `1398590642`. No history was rewritten. Commits, pull requests, issues and their numbers are unchanged.

## Redirects, verified after the rename
- **API:** `GET /repos/TheHalfMoon/Lilac` resolves to `TheHalfMoon/Ninerr`, id `1398590642`.
- **Web:** on github.com, the old repository page `TheHalfMoon/Lilac` and its `pull/221` page answer `301 Moved Permanently`, to `https://github.com/TheHalfMoon/Ninerr` and `.../pull/221`.
- **Git:** `git ls-remote` on both the old and the new clone URL returns `main` at `aabff88`.
- **Issues:** #190 is served at `https://github.com/TheHalfMoon/Ninerr/issues/190`.
- **Private vulnerability reporting:** `GET /repos/TheHalfMoon/Ninerr/private-vulnerability-reporting` returns `{"enabled":true}`.

GitHub keeps the old name redirecting until a new repository takes the name `TheHalfMoon/Lilac`.

## What this grain changes
- **`docs/RELEASE.md`** uses the new clone URL and directory, and passes `TheHalfMoon/Ninerr` to `gh attestation verify` (`--repo` and `--signer-workflow`). No release has been made, so no attestation was signed under the old name.
- **`docs/CURRENT.md`** names the repository `TheHalfMoon/Ninerr`, and lists G9 and G10 as delivered.
- **`tests/license-register.test.mjs`** names this repository by its new name.
- **The identity gate.** The `repository-url` rule is removed, so the old repository URL is gated in every current file. The probes written for that rule now assert that the old forms are gated. Dated evidence keeps the old URL where it records what was true then.

No workflow or script names the repository; they use `github.repository`. The local clone's `origin` was set to the new URL.

## CI after the rename
This PR's exact-head CI is the first run under the new name. The PR's qualification record gives its results.
