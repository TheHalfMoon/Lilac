# P06 G4: accessibility audit of generated and imported output (#110)

Part of P06 gate 4 (#100).

## Delivered

`@lilac/design-assurance` adds `src/accessibility.mjs`, re-exported from the package index. `DesignAssuranceError` moved to `src/errors.mjs` to avoid a circular import; the export is unchanged. The audit is Lilac-owned, deterministic and adds no dependency.

- `auditAccessibility(tree)` runs over a neutral tree, where each node is `{ id?, tag, attributes, text?, style?, children }`. Findings carry `ruleId`, `wcag`, `severity`, `path`, `nodeId` (when known) and a fixed-text `message`. They are sorted by path, then rule, then message, in code-unit order.
- Bounds: depth 256 and 100,000 nodes. Both adapters count converted nodes, so shared references (a child id or object reused) cannot expand a small input into an exponentially large tree.
- Names never leave the module, so they are not truncated. Hidden subtrees (`aria-hidden="true"`, `hidden`) and nested form controls contribute no name content, so option text is not a label. `aria-labelledby` labels a control only when it resolves to text.
- `DesignAssuranceError` and `compareCodeUnits` are shared internal modules (`errors.mjs`, `order.mjs`).

| Rule | WCAG | Checks |
|---|---|---|
| `a11y/image-alt` | 1.1.1 | `img` without `alt`. An empty alt is decorative and allowed. `input[type=image]` with no alt text. An empty alt does **not** pass on an image button: the button needs a name under WCAG 4.1.2, which deviates from the spec's general "empty alt is allowed" wording. |
| `a11y/control-label` | 1.3.1, 4.1.2 | Inputs (except hidden, submit, reset, button and image), `select` and `textarea` with no `aria-label`, resolvable `aria-labelledby`, non-empty `label for/htmlFor`, ancestor `label` with text, or `title`. |
| `a11y/button-name` | 4.1.2 | `button`, `role=button` and button-type inputs with an empty accessible name. |
| `a11y/link-name` | 2.4.4 | `a[href]` with an empty accessible name. |
| `a11y/heading-order` | 1.3.1 | A heading level more than 1 above the previous heading. Covers `h1`–`h6` and `role=heading` with `aria-level` (default 2). |
| `a11y/text-contrast` | 1.4.3 | Text whose foreground and background resolve to opaque colours with a contrast ratio below 4.5:1, or below 3:1 for large text (24px and up, or 18.66px and up at weight 700 or more). `color`, `font-size` and `font-weight` inherit from ancestors. The background comes from the node or its nearest ancestor. Translucent and unresolvable colours (`url()`, `var()`, unknown names) are skipped, never guessed. |

The contrast message floors the ratio to two decimals, so a true 4.4995 reads "4.49:1 is below 4.5:1".

Adapters:
- `accessibilityTreeFromDesignDoc` reads code-ir's `DesignDoc`. The `style` prop is read as CSS.
- `accessibilityTreeFromImportProposal` reads import proposals: text nodes, `style.cssText`, and link and image resources restored as `href`/`src` presence.

**Through intake.** `reviewImport` (`@lilac/intake`) now carries an advisory `accessibility` summary for each proposal: the finding count, `byRule`, the first 200 items with `ruleId`, `wcag`, `severity`, `message` and `nodeId`, and the truncated count. It does not block `commitReady`. Intake gains the `@lilac/design-assurance` workspace dependency. The architecture catalog adds `design-assurance` to intake's `dependsOn`, and the intake dependency pin test and provenance are updated.

## Evidence

`tests/accessibility-audit.test.mjs` has 14 tests:
- Contrast against WCAG reference values: black on white 21.00, `#777` on white 4.48, `#767676` on white 4.54.
- A positive and a negative case for every rule.
- Large-text thresholds.
- Inheritance.
- Identical findings for a `DesignDoc` before emission and after `designToCode` → `buildCodeIr` → `codeToDesign`.
- Imported HTML through `importHtmlSnapshot`, with findings naming proposal nodes.
- Deterministic ordering.
- Bounds and malformed input, including adapter expansion through reused ids or objects.
- Hidden content and nested controls.
- The 4.4995 boundary.
- Intake review surfacing.

## Disposition

No editor UI exists to audit. Editor accessibility checks belong to the canvas and editor grains (`canvas-viewport` and `selection-transform` are `planned` in the architecture catalog). Contrast for `decision-assurance` candidate snapshots stays planned until snapshots carry colour data, as its catalog boundary states.
