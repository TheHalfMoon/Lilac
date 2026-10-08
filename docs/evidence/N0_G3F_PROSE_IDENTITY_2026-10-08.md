# N0-G3f: the product name in code comments, messages and test titles

Issue: #190 (N0 umbrella). The product name `Lilac` becomes `Ninerr` throughout:
- the packages' source, and their READMEs;
- code comments and user-visible messages;
- test titles and names, temporary-directory prefixes, and helpers such as `NINERR_CORE_RULE_PACK`.

## Not renamed
- **Deliberate legacy references.**
  - Every `legacy.ts` module and its tests.
  - The packaged resolver's refusal of the `@lilac` scope.
  - The history view's recognition of `lilac:` tools.
  - Test values that stand for the legacy format (`lilac-project`, `lilac-journal-genesis`).
- **Elsewhere:**
  - fixtures;
  - dated evidence;
  - the repository URL, until N0-G10;
  - the Paper recovery tooling, which N0-G5 removes.

## Found while qualifying
The first run of the rename also rewrote five deliberate legacy references. Among them was `(?:ninerr|lilac)` in the packaged resolver's refusal pattern, which would have re-opened the gap N0-G3a closed. The suite caught every one: `tests/desktop-package.test.mjs` and `tests/migration-compatibility.test.mjs`. All five are restored, and both suites pass.
