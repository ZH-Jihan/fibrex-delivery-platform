# Phase 3: People and documents

## Scope

Employee master data, documents, custom documents, expiry alert engine, document OCR.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 3.2, 5.12, 2.8
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Create an employee with all standard documents plus a custom-named document, each with expiry date.
- [ ] Daily job emails the consolidated expiry list at the configured windows (7 days by default) and shows in-app alerts and the expiry calendar.
- [ ] OCR pre-fills number and dates with a confidence level; user confirms before save (use a stub adapter if no provider key is set).
- [ ] Bulk Excel import with validation preview and rollback.
- [ ] Sensitive identifiers are encrypted at rest and masked in lists.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-03.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
