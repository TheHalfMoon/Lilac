# P06 G7a: code-ir design/code differential (#123)

Part of P06 gate 7 (#100): import/export differential tests. This grain is the code-ir half, `designToCode` against `codeToDesign`. The import half is a separate grain.

## Findings on base `15c6158`

An exploratory seeded differential over 3000 generated design documents found that most did not round-trip through `codeToDesign(buildCodeIr(designToCode(doc)))`.

1. **Text escaping.** The emitter escaped `& < >` as entities, but the parser never decoded entities. Raw `{` and `}` in text became expressions.
2. **Attribute strings.** The emitter wrote `&quot;` and `&amp;` in attributes, which the parser did not decode. The parser also applied JS backslash escapes, which JSX attribute strings do not have.
3. **Whitespace.** The emitter placed sibling elements on one line, so the spaces between them were JSX text. It also placed text before a line break. The parser kept raw text, indentation included, instead of applying JSX line trimming.
4. **Numbers.** `1e+21` was emitted but refused by the parser.
5. **Dead literal path.** The tokenizer never produced `string` tokens, and the `parseStringLiteral` it would have called did not exist. So `{"x"}` and `{'x'}` were refused.
6. **Silent wrong tree.** A failed top-level element was recovered one token later, so its descendants became roots. `rootIds[0]` could name a nested element, and `codeToDesign` then returned a different design without any error.
7. **Hyphenated names.** Attribute names with a hyphen (`aria-label`, `data-x`) were split by the tokenizer, so they were refused.
8. **Empty text.** Found by the shrinker: `text: ""` and `children: []` did not survive a round trip, because the emitter treats them as absent.

## Changes

- **`packages/code-ir/src/jsx.ts`**
  - **Text.** JSX text is entity-decoded (`&amp; &lt; &gt; &quot; &apos; &nbsp;` and numeric references; any other named entity is refused, as are invalid code points) and then trimmed with Babel's JSX line rule. It is read from the source span rather than rebuilt from tokens.
  - **Attribute strings.** JSX semantics: no escapes, entities decoded, newlines refused.
  - **Expression literals.** Expression containers are read from source as one literal: `true`, `false`, a number with an optional exponent, or a quoted JS string with standard escapes. Line continuations and octal escapes are refused.
  - **Children.** A string-literal child is exact text, and any other literal child is refused.
  - **Tokens.** Identifiers may contain `-`, and the unused `string` token type is removed.
  - **Recovery.** A failed top-level element is skipped to its balanced end (quoted attribute values and braces are skipped, and an unbalanced element ends the scan), so no descendant becomes a root.
- **`packages/code-ir/src/roundtrip.ts`**
  - **Text.** Text is written raw only when raw JSX carries it exactly (no tabs or line breaks, no edge spaces), with `& < > { }` as entities. Anything else is written as a string-literal child.
  - **Attributes.** An attribute string containing `"` or `&` is written as a string-literal expression.
  - **Children.** One child per line.
- **`packages/code-ir/src/validation.ts`.** The design normal form omits empty text and empty child lists.

**Behaviour change.** Previously, a file whose only element failed to parse could still yield a nested element as a root. It now fails with "no supported elements". `tests/code-ir.test.mjs` asserts this for the 40-deep case.

## Tests

`tests/code-ir-differential.test.mjs` has 8 tests. On base (code-ir changes stashed), 7 fail; the shrinker self-test passes there because it tests only the shrinker.

1. **design to code to design.** Over 400 seeded generated documents, the round trip is the identity. The alphabet includes entity starters, braces, quotes, backslashes, tabs, CRLF, no-break and non-ASCII characters, U+2028 and entity-like text. A failure reports its seed, the shrunk minimal input and a `LILAC_PROPERTY_SEED` replay line.
2. **Emitted code is a fixpoint.** For 200 seeds, code to design to code returns the same code.
3. **Hand-written JSX.** Eight snippets: multi-line text, entities, both quote kinds, literal expressions and string-literal children. Each lifts to a design that re-emits stably.
4. **JSX semantics** for text, attribute strings, JS string escapes (including `\u{...}`) and exponent numbers. It also checks refusals: an unknown entity, a lone surrogate reference, a line continuation, an octal escape and a numeric child.
5. **Recovery.** A failed element yields no roots. A following sibling is the only root, and braces or quoted `>` / `</div>` inside the failed element do not end it early.
6. **Regressions.** Each original divergence, including empty text and children, round-trips.
7. **Shrinker.** A deliberately lossy round trip is reduced to the minimal `{"tag":"span","props":{},"text":"{"}`.
8. **Golden fixtures.** Three files in `tests/fixtures/code-ir/` (`card.jsx`, `form.jsx`, `pricing.jsx`) lift to the designs pinned in `manifest.json`, with pinned fingerprints, and survive a round trip.

## Gate

`npm run check` was run as root here. Everything passes except "a failed journal write poisons the store until reopen", which depends on `chmod` being enforced, so it fails under root and passes as non-root and in CI. The real-browser test was skipped, because `LILAC_TEST_BROWSER` was not set.
