# N0-G3c: the remaining packages move to @ninerr, ending the transition

Issue: #190 (N0 umbrella). This is the third and last scope batch.

**Packages:** `mcp-protocol`, `studio-host`, `intake`, `agent-events`, `studio-web`, `visual-git`, `desktop`, `design-components`, `agent-workspace`, `agent-supervisor`, `delivery-governance`, `decision-assurance` and `architecture`, with 103 references.

**Planned package names** in the architecture catalog, its test and the parity matrix move to `@ninerr/` as well.

**The transition ends.** The packaged app's resolver, the packaging dependency walk and the architecture catalog's owner validation accept only `@ninerr`.

**Result:**
- All 26 workspace packages install under `node_modules/@ninerr`.
- No `@lilac/` name remains, except in dated evidence, the frozen legacy corpus and one census test case that classifies a `@lilac/` line on purpose.

Local run (Windows 11, Node 24.19.0): 761 tests, 700 pass, 26 fail, 35 skipped. Every failure is in the pre-existing Windows set on #192.
