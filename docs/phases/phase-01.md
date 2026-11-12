# Phase 1: Foundation A

## Scope

Project setup, CI/CD and staging, multi-tenant schema with row-level security, party model, authentication, roles and permission matrix, audit trail, soft delete and recycle bin, notification service, app shell and design system.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 1, 2.1-2.4, 2.6-2.8, 2.12, 2.13, 6.1-6.3, 6.6
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] `docker compose up` starts web, api, PostgreSQL, Redis and MinIO; seed script creates one tenant, one company and a Super Admin.
- [ ] A second seeded tenant cannot read the first tenant's rows even with the application filter removed (RLS test).
- [ ] Super Admin can create roles and users and edit the permission matrix; a denied action is blocked on the API, not only hidden in the UI.
- [ ] Every create, update, delete and restore appears in the record History tab and the Activity Log with a field-level diff.
- [ ] Deleted records appear in the Recycle Bin and can be restored.
- [ ] In-app notification arrives in real time; email is sent through the queue.
- [ ] CI runs lint, type check and tests on every push.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-01.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
