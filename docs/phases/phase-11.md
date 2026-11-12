# Phase 11: Intelligence

## Scope

Risk engine, analytics and BI, report and dashboard builder, automation builder, AI layer, telematics ingestion API.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 5.6, 5.14, 5.18-5.20, 2.10
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Seed risk rules raise cases with contributing factors.
- [ ] A permitted user builds, saves and schedules a report from the semantic layer.
- [ ] The assistant answers only through read-only tool functions with the asker's permissions; no raw SQL; all calls audited.
- [ ] Automation rule: event, condition, action works end to end.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-11.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
