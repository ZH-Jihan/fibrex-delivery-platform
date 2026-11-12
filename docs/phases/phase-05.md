# Phase 5: Inventory and fleet

## Scope

Merchandise and inventory with reconciliation; fleet register, assignments, rent ledger, violations and incidents.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 3.4, 4.1, 5.16 (incidents and violations only)
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Stock is derived from the movement ledger; issue produces a printable handover slip.
- [ ] Reconciliation summary shows received-from-client versus accounted-for per item with differences.
- [ ] Reassigning a vehicle closes the previous assignment; Generate this month's dues creates rent entries with payee.
- [ ] A traffic violation is attributed to the person holding the vehicle on that date.
- [ ] Rent payments and fines post to the ledger.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-05.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
