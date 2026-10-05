# Paper Recovery Evidence Archive Index — 2026-10-04

## Purpose

This index preserves three point-in-time recovery evidence records that were previously stranded on stale pull-request branches. The records are retained as historical evidence only. They do **not** replace `docs/CURRENT.md`, and statements such as "current" inside those records must be interpreted relative to the date/pass named by each file.

No raw proprietary Paper source, production bundle, runtime function body, credential, or private design content is added by this archival migration.

## Preserved records

| Record | Original PR | Original head | Original blob | Scope |
|---|---:|---|---|---|
| `PAPER_LIVE_RUNTIME_RECOVERY_2026-10-02.md` | #9 | `bc14f0da5373ab4cd909b0ab48b676b68f95be33` | `98ffc54a03926ba1aea1131a0134008d0112dd44` | 36-tool live contract, public-playground runtime/AST census, reconstructed client contracts |
| `PAPER_LOCAL_RUNTIME_RECOVERY_2026-10-02.md` | #10 | `159d2597b902d1c68b0c1337c52b0186f021dbf8` | `6fa49e047a0f6036230ac02696dc6259629a7040` | deeper local runtime/class/method census, Chromium cache recovery, private corpus metadata |
| `PAPER_LOCAL_FORENSIC_CLOSURE_2026-10-03.md` | #13 | `ef4fdb0940fe3e9abe58710562a5511a92dfba37` | `f9ebf6a79f4f34c63b1a8ffde62b2c2ab2c7a157` | elevated VSS/USN/restore/recycle/storage closure and final local forensic boundary |

The three files are migrated by reusing their exact Git blob objects. Their bytes are not rewritten during this archive operation.

## Relationship to canonical evidence

`docs/evidence/PAPER_LIVE_RUNTIME_RECOVERY_2026-10-03.md` remains the later canonical compatibility/reconstruction summary. The archived records contain additional historical measurements and immutable hashes that are useful for auditability but should not be read as superseding later conclusions.

The canonical classification remains:

- shipped Desktop source: exact recovered source;
- shipped web implementation: recovered shipped bundle/runtime evidence;
- observable client contracts: compatibility reconstructed and validated;
- original unshipped Web TS/TSX, server/backend source, and private repository history: not recovered.

## Pull-request cleanup rule

Only after this archive migration itself is qualified and canonical may stale PRs #9, #10, and #13 be closed as superseded. Their stale `docs/CURRENT.md` edits and automated Cubic/CodeRabbit/Qodo text must not be migrated or used as qualification evidence.
