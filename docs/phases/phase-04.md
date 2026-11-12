# Phase 4: Performance and tracking

## Scope

Google Sheets sync at 04:00 Asia/Qatar, daily and monthly performance reports, daily tracking page.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 3.1, 3.3, 5.5
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Importer passes fixture tests, including a renamed-column case; raw snapshot is stored for every run.
- [ ] Re-running a date is idempotent; failures alert admins; Run now and Re-import range work.
- [ ] Daily and monthly reports match hand-calculated figures from the fixture.
- [ ] Tracking page saves status, reason, date, and ID-operator details inline and keeps dated history.
- [ ] Cross-check flags Active with no orders and Inactive with orders.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-04.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
