# Authorized Paper Source Intake Runbook

The first source intake must be intentionally boring. Do not rebrand, refactor, update dependencies, format, or fix bugs in the intake commit.

## 1. Obtain the source artifact

Accepted forms include:
- an authorized Git repository/revision;
- an authorized source archive;
- an authorized local source directory.

Capture the exact upstream version/commit when available.

## 2. Verify authorization record

Confirm `docs/provenance/PAPER_AUTHORIZATION.md` accurately records the project's authorization basis. Attach stronger private/legal evidence outside the public repository when it contains confidential terms.

## 3. Stage an immutable snapshot

From the Lilac repository root:

```bash
node scripts/import-authorized-paper.mjs /path/to/paper-source imports/paper/source --revision <exact-revision>
```

The script:
- copies source files without rewriting content;
- excludes donor `.git` metadata;
- refuses to overwrite a non-empty destination unless `--force` is supplied;
- generates `imports/paper/MANIFEST.sha256`;
- generates `imports/paper/IMPORT.json`.

Review the manifest before commit.

## 4. Preserve legal/provenance files

Ensure the snapshot includes all donor license, NOTICE, AUTHORS, copyright, dependency notice, and attribution files that were present in the received source.

## 5. Commit intake separately

Suggested commit:

```text
chore(source-intake): import authorized Paper snapshot <revision>
```

The intake PR must contain no Lilac behavior/branding transformation.

## 6. Reproduce upstream

Create a new branch after intake and document:
- toolchain versions;
- package manager/version;
- install command;
- build command;
- test command;
- launch commands;
- external services/env vars;
- baseline failures.

Only after a reproducible baseline exists should Lilac transformations begin.

## 7. Transformation sequence

1. identifiers and branding;
2. external service isolation;
3. configuration namespace;
4. application/package topology cleanup;
5. subsystem boundary extraction;
6. parity repair;
7. Lilac differentiators.

## Never do this

- claim a binary/reconstructed bundle is the authorized source when it is not;
- silently remove license/NOTICE files;
- mix donor intake and dependency upgrades;
- mass-format the source intake;
- mark parity from screenshots/marketing only;
- infer a private Paper repository from similarly named public repositories.
