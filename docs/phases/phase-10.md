# Phase 10: Operations modules

## Scope

Dashboard, onboarding pipeline, agents and deposits, accommodation, leave and HR requests, exit clearance, workforce planning.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 5.1-5.4, 5.13, 5.16, 5.17
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] Every dashboard number opens the filtered list behind it and respects permissions.
- [ ] Candidate converts to employee with data and documents carried over.
- [ ] Accommodation cost is split by pro-rated occupancy and flows to payroll or company cost.
- [ ] Exit clearance gathers all outstanding items and produces a final settlement through an off-cycle run.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-10.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
