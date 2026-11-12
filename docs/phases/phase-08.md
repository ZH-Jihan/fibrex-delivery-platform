# Phase 8: Revenue and accounting

## Scope

Client contracts, invoicing, statement reconciliation and receivables; accounting reports, payables, budgets and accounting-software sync.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 5.7, 5.15
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Expected revenue is computed from performance data and the rate card and compared line by line with an imported client statement.
- [ ] Invoices are numbered per company and rendered from a template; receivables ageing is correct.
- [ ] Trial balance, P&L, balance sheet and cash flow drill down to source documents.
- [ ] Accounting-software sync works through the adapter interface (one implementation or a documented stub).
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-08.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
