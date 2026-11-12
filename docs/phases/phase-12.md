# Phase 12: Hardening and go-live

## Scope

Security review and penetration test fixes, load test, disaster recovery drill, full test suite, documentation, migration of live data and go-live.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 6.3-6.6
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Load test passes the performance budget with 5,000 workers and 5 years of data.
- [ ] Backup restore is rehearsed and timed against the targets.
- [ ] Security checklist (OWASP ASVS Level 2) is completed with findings fixed or logged.
- [ ] User guides per role, admin guide, runbooks and data dictionary are complete.
- [ ] Live data migrated and reconciled; rollback plan written.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-12.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
