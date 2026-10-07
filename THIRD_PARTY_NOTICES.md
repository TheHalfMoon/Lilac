# Third-Party Notices

Lilac uses or interoperates with third-party software under its respective licenses. This file records direct runtime integrations introduced into the repository; transitive package notices remain governed by their own distributions.

## Parse5

- npm runtime: `parse5@8.0.1`
- Copyright: 2013-2019 Ivan Nikulin
- License: MIT
- Upstream project: https://github.com/inikulin/parse5
- Transitive runtime: `entities@8.0.0` (Copyright Felix Bohm, BSD-2-Clause)

Lilac's `@lilac/import-stack` package uses the published local Parse5 HTML parser as a bounded parser only. Lilac owns sanitization, authority limits, deterministic identifiers, source provenance, proposal validation, and history commit boundaries. The MIT and BSD-2-Clause license texts are included by the upstream npm distributions. Any Lilac release that redistributes Parse5 or entities source or object code must preserve the applicable licenses and attribution notices.

## Impeccable

- Project: `pbakaus/impeccable`
- Source revision studied and pinned by Lilac: `e103efe779e2dd01274dabae83531fef00bf2563`
- npm runtime: `impeccable@4.1.0`
- Platform engine binaries (optional dependencies; npm installs the one for the host): `@impeccable/cli-darwin-arm64@0.1.5`, `@impeccable/cli-darwin-x64@0.1.5`, `@impeccable/cli-linux-arm64@0.1.5`, `@impeccable/cli-linux-x64@0.1.5`, `@impeccable/cli-windows-x64@0.1.5`. Each declares `SEE LICENSE IN LICENSE`; the shipped LICENSE is the Apache License 2.0 text, byte-identical to `impeccable@4.1.0`'s (recorded in `scripts/license-policy.json`).
- source snapshot engine version: `0.1.11`
- published runtime detector engine version: `0.1.5`
- Copyright: 2025 Paul Bakaus
- License: Apache License 2.0
- Upstream project: https://github.com/pbakaus/impeccable

Lilac's `@lilac/design-assurance` package invokes the published local Impeccable detector and normalizes its findings. Lilac-specific rule packs and policy logic are project-owned code and are not represented as original Impeccable source.

The Apache License 2.0 text is included by the upstream npm distribution. Any Lilac release that redistributes Impeccable source or object code must preserve the applicable license and attribution notices.

Impeccable's upstream `NOTICE.md` at the pinned revision is reproduced verbatim below. The reference files it describes are not part of the npm package Lilac installs, which ships only `cli/bin/` and `LICENSE`.

> # Third-Party Notices
>
> This project includes content derived from third-party work, used under the terms of its original license.
>
> ## Platform Design Skills
>
> The `skill/reference/ios.md` and `skill/reference/android.md` platform reference files are distilled from ehmo's `platform-design-skills` (Apple Human Interface Guidelines and Material Design 3 rules), rewritten in Impeccable's voice.
>
> **Original work:** https://github.com/ehmo/platform-design-skills
> **Original license:** MIT
> **Author:** ehmo

## Playwright (development only)

- npm package: `playwright-core@1.56.1`, a devDependency with no dependencies of its own
- Copyright: Microsoft Corporation (see its `NOTICE`)
- License: Apache License 2.0
- Upstream project: https://github.com/microsoft/playwright

Lilac's test suite uses `playwright-core` to drive a locally installed Chromium for renderer and editor end-to-end tests. It is not part of the product. Its `LICENSE` and `NOTICE` are carried in the release bundle's license texts.

## Unreal Agent

- Project: `unreallabsai/unreal-agent`
- Source revision studied and pinned by Lilac: `1b9f778453f411c029b39b85102aaefb95e7e48d`
- License: MIT
- Copyright: Copyright (c) 2026 Unreal Labs (upstream LICENSE at the pinned revision)
- Upstream project: https://github.com/unreallabsai/unreal-agent

Lilac's `@lilac/agent-runtime` is a TypeScript semantic port of bounded durability concepts observed at the pinned revision: append-only session history, caller-supplied idempotency identities, replay/resume, immutable-parent forks, versioned operation envelopes, validated operation transitions, atomic tool-call/operation registration, synchronous tool translation, and recovery semantics.

Lilac does not vendor the Unreal Agent Go harness, provider clients, remote runner, process primitives, branding, or telemetry. Lilac-specific authority fields and document-transaction binding are project-owned extensions. Any future direct redistribution of upstream Unreal Agent source must preserve the MIT license and copyright notice. The upstream license at the pinned revision:

> MIT License
>
> Copyright (c) 2026 Unreal Labs
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## UI-TARS Desktop / Tarko

- Project: `bytedance/UI-TARS-desktop`
- Source revision studied and pinned by Lilac: `2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a`
- License at the pinned revision: Apache License 2.0
- Copyright notices in studied source: 2025 Bytedance, Inc. and its affiliates
- Upstream project: https://github.com/bytedance/UI-TARS-desktop

Lilac's `@lilac/agent-events` package is a bounded adaptation of event-stream concepts studied from the pinned Tarko surfaces. The adapted concepts include typed event categories, streaming assistant/tool-call deltas, environment-input events, plan events, event subscribers, handler registries, and handler-failure isolation.

Lilac does not vendor the UI-TARS model runtime, desktop application, remote operator, browser-automation stack, provider bindings, branding, or telemetry. Lilac-specific sequence validation, caller-owned identity/timestamp rules, operation/transaction correlation, bounded reference-only environment inputs, deterministic replay, and closed-world validation are project-owned extensions. Any future direct redistribution of upstream UI-TARS source or object code must preserve the applicable Apache-2.0 license and notices.

## Firstmate

- Project: `kunchenguid/firstmate`
- Source revision studied and pinned by Lilac: `1f3e769616fdf9f31f85f4c3e6a9f71606634238`
- License: MIT
- Copyright: Copyright (c) 2026 Kun Chen
- Upstream project: https://github.com/kunchenguid/firstmate

Lilac's `@lilac/agent-supervisor` package ports and adapts bounded supervision semantics. The full MIT notice is kept in `packages/agent-supervisor/NOTICE.md`, which also ships in the release bundle.

## Website-downloader

- Project: `AhmadIbrahiim/Website-downloader`
- Source revision studied and pinned by Lilac: `130ad63d7163c19df64322556ca9c260eef353be`
- License: MIT

`@lilac/import-stack`'s bounded static mirror fallback adapts lifecycle ideas from this project, reimplemented on `node:http`. No donor files are included.

## Guidance-only donors

These projects were studied for design guidance. No code, text, or assets were copied from them. Each is recorded in the named package's provenance.

- `mrmps/classifier-dev` at `a17bf2b6353f6234af6e977a463da7cd1975b68e`, MIT: `@lilac/decision-router`.
- `kunchenguid/no-mistakes` at `0616eb4911845e2ba04faa17186ecd2686d7d579`, MIT: `@lilac/delivery-governance`.
- `Appllama/appllama-skills` at `dd5caaec3d5d50ad7fc0324da238119c6b7c3707`, MIT: `@lilac/design-method`.
- `reinaldosimoes/design-resources` at `43fe2b5d801e34c21e22b5639711f7e250a798e5`, CC0-1.0: `@lilac/design-method`.

## Reference-only projects

These projects were studied only. No code from them is in Lilac, and none may be copied.

- `kgoedecke/doop` at `d99c8b157d5afd4192b356f89a2b19adc28c75a5`, AGPL-3.0-only (studied for `@lilac/collaboration`).
- `firecrawl/firecrawl` at `4244638a7041bae8b99bdd42e3c44520f9e62da1`, AGPL-3.0 (an external connector interface only, in `@lilac/import-stack`).
- `caio0452/jev_search` at `ea073f6db48f5bff73ae4b9f2240d2d302fb9dc1`, no license observed.
- `vcashwin/paper-snapshot` at `12920e03e5bd6758a5e5d20db92b68e0410b0fb0`, MIT.
- Public Paper repositories, none incorporated:
  - `paper-design/shaders` (Apache-2.0);
  - `paper-design/paper-mono` (OFL-1.1);
  - `paper-design/opentype.js` (MIT);
  - `paper-design/liquid-logo` (PolyForm Shield 1.0.0, not open source);
  - `paper-design/agent-plugins`, `paper-design/google-fonts-scripts` and `paper-design/webmcp-agent-example` (no license observed).

## Paper.design

- Products: `paper.design` (the Paper editor and Paper Desktop) and its private monorepo `paper-design/paper`.
- License: proprietary.
- Basis: the Lilac project owner attests full permission to use, copy and modify the Paper.design source for Lilac (`docs/provenance/PAPER_AUTHORIZATION.md`).

No Paper source code is included in this repository. Lilac contains its own code that is compatible with Paper's public interfaces: the public names and classifications of Paper's MCP tools (`@lilac/mcp-protocol`), and behaviour compatibility in `@lilac/collaboration` and `@lilac/import-stack`.

Paper, Paper.design and related names, logos and marks belong to their owner. They are not licensed by Lilac, and their use here identifies compatibility only.

## Optional runtime components

Lilac can invoke these when the user has installed them. Lilac does not ship them.

- `docling-project/docling` (MIT, models under their own licenses): `@lilac/import-stack` local document adapter.
- `playwright` (Apache-2.0): `@lilac/import-stack` dynamic capture.
- System Chrome, Chromium, Edge or Brave (`system-browsers`): `@lilac/design-assurance` browser scans.

## Development tooling

These are used to build and review Lilac, and are not part of the product.

- `okooo5km/jev` (Apache-2.0, Copyright 2026 okooo5km): vendored in `.claude/skills/jev` with its `LICENSE.txt` and `NOTICE`.
- `phthomas/pstack` at `faa4e9f` (MIT, Copyright (c) 2026 Philip (@phthomas)): vendored skills in `.claude/skills/ps-*`, with the license in `.claude/skills/PSTACK-LICENSE`.
- `@alibaba-group/open-code-review` (Apache-2.0) and GitHub Actions (`github-actions`, MIT) run in CI only and are not vendored.

The complete audited register, with evidence for each entry, is `docs/provenance/LICENSE_REGISTER.json`.
