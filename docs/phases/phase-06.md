# Phase 6: Rates, loans and fund

## Scope

Rates and charges, loans with loan paper, loan fund with investors and cash book, import of the existing loan workbook.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 4.2, 4.3, 4.6
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Loan cannot be posted until the signed loan paper is attached (except Company and Imported entries).
- [ ] Payment allocation: chosen loan, or oldest first with split; overpayment and pre-dated payments are blocked.
- [ ] Importing reference/Loan_Management_System_v7.xlsx reproduces the workbook dashboard totals exactly on the reconciliation screen.
- [ ] Investor ledger, share % and cash in hand match the workbook.
- [ ] Statuses Paid, Overdue, Due soon, Open, Active are derived and tested.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-06.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
