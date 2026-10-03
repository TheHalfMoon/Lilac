# Third-Party Notices

Lilac uses or interoperates with third-party software under its respective licenses. This file records direct runtime integrations introduced into the repository; transitive package notices remain governed by their own distributions.

## Impeccable

- Project: `pbakaus/impeccable`
- Source revision studied and pinned by Lilac: `e103efe779e2dd01274dabae83531fef00bf2563`
- npm runtime: `impeccable@4.1.0`
- source snapshot engine version: `0.1.11`
- published runtime detector engine version: `0.1.5`
- Copyright: 2025 Paul Bakaus
- License: Apache License 2.0
- Upstream project: https://github.com/pbakaus/impeccable

Lilac's `@lilac/design-assurance` package invokes the published local Impeccable detector and normalizes its findings. Lilac-specific rule packs and policy logic are project-owned code and are not represented as original Impeccable source.

The Apache License 2.0 text is included by the upstream npm distribution. Any Lilac release that redistributes Impeccable source or object code must preserve the applicable license and attribution notices.
