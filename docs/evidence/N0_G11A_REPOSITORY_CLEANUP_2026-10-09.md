# N0-G11a: the repository cleanup, part one

Issue: #190 (N0 umbrella). The founder asked for a professional repository cleanup. That meant auditing:
- the README, the repository description, the topics and the docs navigation;
- screenshots and examples;
- the security policy, contributing guide, and issue and PR templates;
- the release, build and local-development instructions.

It also meant removing filler, internal language, stale planning, unnecessary donor references, duplicated docs, marketing language and unproven claims.

## The audit
A read-only audit covered the README, SECURITY, the docs in `docs/` other than the dated records, and the package READMEs. It found no contributing guide and no GitHub templates. Its findings were ranked must-fix (false or broken facts), should-fix (internal language, stale wording, donor names) and optional. Most of them are listed below as fixes; the audit itself is not kept as a file. It also checked a sample of concrete claims against the code and found them true:
- the commands, environment variables and test files the docs cite;
- the MCP tool counts and waiting times;
- the schema versions;
- the desktop facts;
- the release jobs.

This grain applies the fixes to the public entry points. N0-G11b covers the donor records, the architecture overview and the MCP rename table.

## What changed
- **Repository settings.** The description is set to a one-line summary of the README. The topics are `design-tool`, `local-first`, `mcp`, `html`, `css`, `electron`, `design-systems` and `nodejs`. Both were empty before.
- **`CONTRIBUTING.md` (new).** It covers setup, the test commands, browser and desktop test requirements, the identity gate, registering sources, pull requests and the inbound license (Apache-2.0, section 5).
- **Issue and PR templates (new).** There is a bug report form, a feature request form, and a PR template with a checklist. A contact link sends vulnerability reports to private vulnerability reporting.
- **`README.md`.**
  - The documentation list now names ARCHITECTURE, CONTRIBUTING, the program pages and the donor record.
  - The install command is `npm ci --ignore-scripts`, matching CI, the desktop guide and the release guide.
  - "Before the rename" becomes "earlier versions".
- **`SECURITY.md`.** The internal gate labels (such as "P06 gate 6" and "PC11") are removed from the boundary table, since the test files are the evidence. "Reference-only donors" becomes "third-party services".
- **`docs/RELEASE.md`.**
  - The release job uploads seven files and `SHA256SUMS`, not seven files.
  - The rebuild needs Node 22.18 or later.
  - The LGPL source paragraph says plainly that no binary release is published yet, and that the owner decides the route before the first one.
- **`docs/MIGRATION.md` and `docs/DESKTOP.md`.** Internal grain and phase labels are removed. In `docs/MIGRATION.md` the tests were already named. In `docs/DESKTOP.md` the label is replaced with the test it stood for.
- **`packages/agent-supervisor/README.md`.** Em dashes lost to `?` in an ASCII conversion are restored as colons. The internal names "Grain 4" and "Grain 3" become the package names.
- **`docs/CURRENT.md`.** Canonical main is updated to `e320c10` (#225), with its post-merge results, and the remaining N0 work is named.

## Not changed, and why
- **The founder's wording** in `docs/MASTER_PLAN.md` (mission, principles and the definition of complete) is kept verbatim.
- **The program pages** (`docs/CURRENT.md`, `docs/MASTER_PLAN.md`) remain the project's program record, and the README now names them as such.
- **Screenshots.** The repository has none. P09 redesigns the editor's UI and UX, so screenshots taken now would be out of date when it lands. They belong to P09's evidence.
- **Examples.** The fixture projects under `tests/fixtures/projects` are the only example projects. A separate examples directory would repeat them.
