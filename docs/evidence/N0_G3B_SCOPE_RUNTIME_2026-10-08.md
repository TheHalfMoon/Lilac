# N0-G3b: runtime and import packages move to the @ninerr scope

Issue: #190 (N0 umbrella). This is the second scope batch, done with the same script and the same exclusions as N0-G3a.

**Packages:** `agent-runtime`, `import-stack`, `design-assurance`, `design-method`, `collaboration` and `decision-router`, with 122 references.

**Expected changes:**
- The smoke report's `journal.log` digest changes, because the smoke project's import transaction records the import stack's package name (`@ninerr/import-stack`) as its tool.
- No other digest in the report changes. The document digest is unchanged.
