# N0-G9a1: the program record before the rename moves to dated evidence

Issue: #190 (N0 umbrella). This is a step toward N0-G9's narrow identity gate.

`docs/CURRENT.md` and `docs/MASTER_PLAN.md` carried both the current program and the full record of P00 to P07 and PC from before the rename. That record names Lilac and Paper as they were. A gate that exempted both whole files would let a new current claim slip in (raised by the N0-G9 review). So the record moves, unchanged, to dated evidence. The existing `dated-evidence` rule covers it.
- `docs/MASTER_PLAN.md` moves to `docs/evidence/MASTER_PLAN_2026-10-09.md`.
- `docs/CURRENT.md` moves to `docs/evidence/PROGRAM_STATE_2026-10-09.md`.

Git records both as pure renames. `tests/program-state.test.mjs` now checks the recorded P06, PC and P07 gates against the moved plan, and checks the record's cited paths.

N0-G9a2 restores `docs/CURRENT.md` and `docs/MASTER_PLAN.md` holding only the current program, with pointers to these records.
