# N0-G2d: host files and settings from before the rename

Issue: #190 (N0 umbrella). Builds on N0-G2c.

## Files in the projects folder

| File | Before | Now | Legacy handling |
|---|---|---|---|
| Agent registry | `.lilac-agents.json` | `.ninerr-agents.json` | Read when no Ninerr registry exists, saved under the Ninerr name at once, and never changed. A damaged legacy registry fails closed: no agents. It is not moved aside, because it is not Ninerr's file. |
| Agent credentials | `lilac_agent_…` | `ninerr_agent_…` | Earlier credentials keep authenticating, because only their SHA-256 is stored. Revoking one applies to the Ninerr registry. Once that registry exists, the legacy registry is not read again. |
| Codebase links | `.lilac-codebases.json` | `.ninerr-codebases.json` | Read until the first change, which saves the Ninerr file. The legacy file is left as it was. |
| Relay discovery | `.lilac-studio.json` | `.ninerr-studio.json` | None. It is rewritten on every start and removed on close. |
| Temporary files | `.lilac-tmp`, `.lilac-open-*.html` | `.ninerr-tmp`, `.ninerr-open-*.html` | None. They are short-lived. |

## The projects folder

`resolveProjectsFolder` picks the folder in this order:

1. the chosen folder;
2. `NINERR_PROJECTS`;
3. `LILAC_PROJECTS`, with a note to rename it;
4. `~/Ninerr Projects`, unless it does not exist and `~/Lilac Projects` does. In that case the legacy folder is used, with a note.

Nothing is moved. The note is printed by local web mode, the desktop app and the MCP relay.

The MCP relay now finds the folder the same way the app does when neither `--projects` nor `--url` is given. Previously it refused to start without one of them.

All legacy names live in `packages/studio-host/src/legacy.ts`.

## Tests

- **`tests/legacy-host.test.mjs`:**
  - The agent registry carries over, and legacy credentials and revocation behave as described.
  - A damaged legacy registry fails closed and is not moved.
  - Legacy codebase links carry over the same way.
  - The projects-folder order is checked under a temporary home directory.
  - The studio host still migrates and opens a legacy project.
- **Existing suites updated to the Ninerr names:** MCP server, MCP relay, codebase, web mode, desktop shell and desktop smoke tests.

Local run (Windows 11, Node 24.19.0): 747 tests, 687 pass, 26 fail, 34 skipped. Every failure is in the pre-existing Windows set on #192.

## Residual

The legacy agent registry keeps its records. If the earlier release is started again, it honours credentials there, including any revoked since in Ninerr. Deleting the file would end that, but it would also break a downgrade, so the file is left in place and this behaviour is stated here.
