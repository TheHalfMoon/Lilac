# Founder source authorization: 2026-10-08

On 2026-10-08 (session message at 15:23:51 UTC), the founder set the Ninerr independence program (N0) and gave this authorization. The excerpt below is verbatim; the message continues with instructions on reuse, which are not quoted here:

```text
FOUNDER SOURCE AUTHORIZATION — AUTHORITATIVE
The founder explicitly confirms:
I have full official permission from all donor/source projects previously authorized for this project to copy, use, modify, adapt, combine, redistribute, rebrand, rename, refactor, and incorporate their source code into Ninerr.
This permission is official.
It includes permission, where covered by those authorizations, to remove:

* donor branding;
* donor product names;
* donor-facing attribution;
* donor logos;
* donor-specific comments;
* donor-specific UI language;
* donor-specific naming;
* donor-specific examples;
* donor-specific product identity;
* donor-specific public-facing acknowledgements;
* inherited branding artifacts;
* visible “based on X” product positioning.
```

In the same message, the founder set the project license. This excerpt is also verbatim:

```text
PROJECT LICENSE
The founder's authorized-source permissions allow Ninerr to use the authorized donor material according to those permissions.
Target Ninerr license:
Apache-2.0
Before declaring it:
Perform a final dependency/source-rights audit specifically separating:
A. founder-authorized donor sources;
B. independent third-party dependencies that remain subject to their own licenses.
Do not retain donor notices from category A merely from unnecessary caution if the founder's authorization permits removal.
Do retain obligations in category B when they are actually required.
Then:

* add Ninerr LICENSE;
* update package metadata;
* update SBOM;
* update release evidence;
* update SECURITY;
* update documentation;
* update release bundle.
```

The same message also separates the Electron runtime's obligations from this authorization, verbatim:

```text
ELECTRON / LGPL
Electron-related LGPL obligations are separate from founder-authorized donor source permissions unless separately covered.
```

## Scope

"All donor/source projects previously authorized for this project" means the projects that earlier owner attestations record:
- `docs/provenance/PAPER_AUTHORIZATION.md`: Paper.design.
- `docs/provenance/AUTHORIZED_DONOR_EXPANSION_2026-10-03.md`:
  - `kunchenguid/firstmate`;
  - `kunchenguid/no-mistakes`;
  - `kgoedecke/doop`;
  - classifier.dev;
  - `caio0452/jev_search`;
  - `unreallabsai/unreal-agent`;
  - `AhmadIbrahiim/Website-downloader`;
  - `Appllama/appllama-skills`;
  - `docling-project/docling`;
  - `reinaldosimoes/design-resources`;
  - `firecrawl/firecrawl`;
  - `pbakaus/impeccable`;
  - `bytedance/UI-TARS-desktop`.

These projects are category A in `docs/provenance/LICENSE_REGISTER.json`.

One exception applies. A project's register entry can describe a runtime that Ninerr invokes rather than donor code. That is the case for `docling-project/docling`: the CLI the user installs, with its models. Such an entry is category B, because the runtime and its models stay under their own licenses, whoever authorized the upstream project. `impeccable` is the same: the npm package Ninerr ships is category B.

Every other entry is category B: an independent third party whose own license applies, whatever this authorization says. That covers:
- the npm dependencies Ninerr ships, including the `impeccable` package, which is published under Apache-2.0 and governed by that license as a dependency;
- the Electron runtime;
- optional runtimes Ninerr does not ship;
- development tooling;
- public repositories that were studied but are outside the authorized set.

The set includes the other public `paper-design/*` repositories, that is every one except `paper-design/paper`, the Paper product monorepo, which is category A. Each carries its own public license, and `docs/DONORS.md` does not treat them as the Paper product source. Reading the Paper.design authorization as covering them would claim a reach the attestation does not state. This reading is cautious, and only the founder can widen it. Today it changes nothing: they are reference-only, and nothing is copied from them.

The 2026-10-03 attestation also says it "does not replace upstream license/NOTICE preservation". The founder's 2026-10-08 permission to remove donor-facing material applies only "where covered by those authorizations". So a license or NOTICE file that ships with copied category A code is kept unless that rule is superseded explicitly. Today no category A source is vendored.

This record states only what the founder wrote. It does not extend the authorization to anything the founder did not name, and it removes no category B obligation.
