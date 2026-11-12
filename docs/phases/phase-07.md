# Phase 7: Payroll and payments

## Scope

Pay components, automatic payroll engine, Excel verification, pay slips, payment batches, WPS and bank files, profit and loss.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 4.4, 4.7, 5.8, 5.9
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] STOP FIRST: ask the owner to decide the treatment of COD, Bills and Adjustments Minus (see docs/DECISIONS.md) before coding the rules.
- [ ] Uploading reference/Book1.xlsx produces pay slips whose totals equal the Excel formulas for every row.
- [ ] Engine result versus Excel shows per-component differences; approval is blocked above tolerance.
- [ ] Advance cut reduces the loan balance with the note of the salary month; negative net pay becomes a new advance; the whole run posts in one transaction and can be reversed as a whole.
- [ ] Pay periods are kept separately; a second upload for the same period is refused unless the first is reversed.
- [ ] Bank and WPS files come from configurable templates and validate QID and IBAN (use a placeholder layout until the bank specification is supplied).
- [ ] Profit and loss is period-based and agrees with the ledger.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-07.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
