# P08-G3d: hostile names and paths

Issue: #230 (P08 umbrella), founder section P08.3: hostile paths, links, device names and Unicode in names; fail closed.

## What runs
`tests/names-paths.test.mjs` runs two table-driven tests through the studio host.

**Project names.** Five valid names are tried, up to the 64-character limit. Forty hostile ones are tried as well:
- empty, `.`, `..`, `a..b`;
- traversal with either separator, `a/b`, `a\b`, `C:`, `C:x`, a UNC path, an absolute path;
- Windows device names, with and without an extension and in either case;
- a trailing dot or space, a leading space, dash, dot or underscore;
- 65 characters;
- letters outside ASCII (`é`, `名前`, an emoji);
- NUL, a tab, a newline;
- the characters Windows forbids (`: * ? | " < >`), `%2e%2e`, `~`.

Last, case variants of existing projects.

**Codebase folders and source files.**
- **Folders that are refused:** the projects folder itself, a folder above it, a folder inside it, relative paths, an empty path, a file, and a missing folder. Each gets its own code: `folder-overlaps-projects`, `invalid-folder`, `not-a-folder` or `folder-not-found`.
- **A folder that works:** one with a long, non-ASCII path, past the 260 characters Windows once allowed. It is connected as is, with a trailing separator, and through a real `..` segment.
- **The files in it:**
  - files to be listed: plain, non-ASCII, with a space, with a 150-character name, nested, and exactly at the scan's depth limit of 8 folders;
  - files that must not be listed: hidden, under `node_modules` or `dist`, an uppercase extension, not a source file, no component, over the 256 KiB limit, nested one folder past the scan's limit.
- **Source file paths:** paths that leave the folder, use a backslash, a drive, an alternate data stream, `./` or NUL, or name a file that is not a source file. Each is refused as `invalid-file`. A missing file is `file-not-found`.

## What must hold
- **The host never answers 500.** Every refusal names a typed error.
- **Valid names:** each is created as a folder of exactly that name inside the projects folder, and opens by that exact name.
- **Hostile names:** every one is refused as `invalid-project-name`, both to create and to open.
- **A name that differs from an existing project's only by case** is neither created (`project-exists`) nor opened (`project-not-found`), on any disk (#247).
- **After it all,** the projects folder holds exactly the valid projects, beside only the host's own `.ninerr-*` files, and the project list matches. Nothing appeared outside it, including any sibling named like it.
- **Folders:** each refused folder is refused by name (`folder-overlaps-projects`, `invalid-folder`, `not-a-folder`). The long, non-ASCII folder connects in all three spellings, and a scan lists exactly the expected components.
- **Hostile source file paths** are refused with exactly the code each must get.
- **Every listed component comes in.** A write-back to the non-ASCII file changes exactly that file, by exactly the edit, and every other file in the folder stays byte for byte as it was.

## Results
**Locally (Windows 11, Node 24):** both tests pass in 3 s.

## Found
- **#247, fixed in #248:** on a case-insensitive disk, a project opened under another case ran under that name, and the state kept by name, such as its codebase link, did not follow. The first probe of this grain found it.

## Not covered here
- **Symbolic links and junctions** in the projects folder and the codebase: P06 tests cover them (`studio-host.test.mjs`, `codebase.test.mjs`, `persistence.test.mjs`). They are on the Windows baseline list (#192), where creating links needs privileges, and run on Linux CI.
