# Progress

Keep this file short (see CLAUDE.md rule 8). Full verification detail: `docs/progress-log/phase-01-details.md` (do not read by default).

| Phase | Title | Status | Accepted on | Notes |
| --- | --- | --- | --- | --- |
| 1 | Foundation A | In progress (commits 1–4 of 13) | | Plan: `docs/phases/phase-01-plan.md` |
| 2 | Foundation B | Not started | | |
| 3 | People and documents | Not started | | |
| 4 | Performance and tracking | Not started | | |
| 5 | Inventory and fleet | Not started | | |
| 6 | Rates, loans and fund | Not started | | |
| 7 | Payroll and payments | Not started | | |
| 8 | Revenue and accounting | Not started | | |
| 9 | Worker app and requests | Not started | | |
| 10 | Operations modules | Not started | | |
| 11 | Intelligence | Not started | | |
| 12 | Hardening and go-live | Not started | | |

## Current state (2026-11-13)

`docs/PLAN.md` and `docs/phases/phase-01-plan.md` are approved. Phase 1 is built in the 13 commits of section 7 of the phase plan.

| Commit | What | Verified |
| --- | --- | --- |
| 1 | Workspace, TypeScript, ESLint module boundaries, shared money helpers | 25 unit tests pass |
| 2 | Docker Compose (Postgres on 5433, Redis, SeaweedFS S3, Mailpit), database roles | Stack healthy, role and password checks done |
| 3 | Hand-written SQL migrations: `app` helpers, 35 `platform` and `iam` tables with RLS; matching Prisma schema | 26 integration tests (RLS, integrity, drift) pass |
| 4 | API kernel: config, context, logging, errors, rate limit, idempotency, OpenAPI, health | 91 tests pass in total |

## Next

Commit 5 (strongest model): kernel database layer. Prisma client on the shared pool, unit of work that sets the RLS context (`SET LOCAL`) per request, soft-delete extension, optimistic locking with 409 and a diff, generic CRUD controller factory.

## How to run

```
pnpm install
copy .env.example .env      (then set passwords)
docker compose up -d --wait
pnpm db:migrate
pnpm --filter @fibrex/api dev     (API on http://localhost:3000; docs at /api/docs)
pnpm test
```

## Setup on this computer

- pnpm 11.28.9 is installed in the user npm folder. pnpm runs project scripts with Node 24.22.3, which it downloaded itself; the system Node is still 22.14.
- Docker Desktop 29.9 is installed. The local `.env` was generated with random passwords (git-ignored).
- A separate native PostgreSQL 17 service (`postgresql-x64-17`) uses port 5432 on this computer, so Fibrex's database is on **5433**.
- pnpm build scripts are allowed only for `prisma`, `@prisma/engines` and `esbuild` (`allowBuilds` in `pnpm-workspace.yaml`).
- To use Node 24 outside pnpm, install Node 24 LTS from nodejs.org.

## Adapter stubs still to replace

(none yet; the SMS stub for phone OTP arrives in commit 7)

## Known issues

- Development only: the official Postgres image trusts connections made from *inside* its own container. Use `docker compose run --no-deps ... -h postgres` (a separate container) when testing passwords. The bootstrap `postgres` superuser can also log in over the local network. Neither applies to staging or production, which use managed PostgreSQL.
