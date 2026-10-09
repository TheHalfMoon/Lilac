# N0-G9a2: the current program pages, and the living records named Ninerr

Issue: #190 (N0 umbrella). This follows N0-G9a1, which moved the program record before the rename to dated evidence.

- **`docs/CURRENT.md`** holds only the current program:
  - N0 and what it has delivered;
  - the canonical main, `679429f` (the merge of #220), whose post-merge run `gh` showed as 769/769 with Desktop green on all three platforms;
  - the prerequisites before the v1 tag;
  - the current facts;
  - a pointer to `docs/evidence/PROGRAM_STATE_2026-10-09.md`.
- **`docs/MASTER_PLAN.md`** holds the mission, the principles, the current program, the definition of complete and a pointer to `docs/evidence/MASTER_PLAN_2026-10-09.md`.
  - Principle 8, about an authorized-source intake that never received source, is left out.
  - The definition of complete asks for acceptance evidence for the implemented catalog in place of the retired parity rows.
- **`CLAUDE.md`** names the current program. It had said the next phase was P06.
- **The living records name Ninerr:** the license register's kinds and entries, `docs/DONORS.md` and `docs/DONOR_INTEGRATION_MAP.md`. Where they record the owner's attestation, they say "this project", the same project, rather than putting the new name in the owner's words.
- **`tests/program-state.test.mjs`** checks two things:
  - every path the current page cites exists;
  - both current pages point to the records they replaced.

All of this was raised by the N0-G9 review: #221's allowlist must not exempt living documents.
