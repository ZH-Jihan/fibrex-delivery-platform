# Progress

Update this file at the end of every session.

| Phase | Title | Status | Accepted on | Notes |
| --- | --- | --- | --- | --- |
| 1 | Foundation A | In progress (commits 1–3 of 13) | | Plan: `docs/phases/phase-01-plan.md` |
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

`docs/PLAN.md` (the overall plan) and `docs/phases/phase-01-plan.md` are approved. Phase 1 is being built in the 13 commits listed in section 7 of the phase plan.

### Done

| Commit | What | Verified |
| --- | --- | --- |
| 1 | pnpm workspace; shared TypeScript configs; ESLint with the `fibrex/module-boundaries` rule; `@fibrex/shared` money helpers | Yes. `pnpm test` (25 tests), `pnpm typecheck`, `pnpm lint` and `pnpm format:check` all pass. |
| 2 | `docker-compose.yml` with PostgreSQL 16.16, Redis 7.4, SeaweedFS (S3) and Mailpit; database roles script; `.env.example` | Yes (2026-11-13, Docker 29.9). See the checks below. |

Commit 2 checks:

- All 4 services become healthy with `docker compose up -d --wait`.
- Roles: `fibrex_app` and `fibrex_bi` have no superuser rights and cannot bypass RLS. `fibrex_owner` owns the database.
- `fibrex_app` gets "permission denied" when creating tables in `public`.
- A wrong password is refused over the network.
- Extensions `pg_trgm`, `btree_gist` and `pgcrypto` are installed.
- Redis refuses commands without its password.
- S3 create, put, get and delete work with the keys. Anonymous requests and a wrong secret get 403.
- The Mailpit UI answers on port 8025.

| Commit | What | Verified |
| --- | --- | --- |
| 3 | Prisma 7 in `apps/api`. Two hand-written SQL migrations: (1) `app` helpers: UUIDv7, request context, row stamping and versions, fixed tenancy, append-only trigger, `app.setup_table`, monthly partition maintenance; (2) the 35 `platform` and `iam` tables with RLS, grants and partial unique keys. A Prisma schema that matches them. Integration tests on a throwaway Postgres container. | Yes. All 26 integration tests pass, plus 25 unit tests. Typecheck, lint and format pass. The migrations are also applied to the local dev database. |

Commit 3 tests (`apps/api/test/integration`):

- **RLS (`rls.test.ts`):**
  - With raw SQL and no tenant filter, tenant B sees none of tenant A's rows.
  - A session limited to company A1 does not see A2; a consolidated session sees both.
  - With no context, no rows are returned.
  - Inserts into another tenant or company are refused.
  - The app role cannot DELETE or TRUNCATE.
  - Every non-global table has RLS and `tenant_id`.
  - Mutation check: running the same tests as the owner role makes 11 of them fail, which proves they detect missing isolation.
- **Integrity (`integrity.test.ts`):**
  - Version starts at 1 and goes up by one on each update; a stale-version update changes nothing; `created_at` cannot be changed.
  - A row's company cannot be changed, even by the owner.
  - Soft delete requires a reason and frees the unique code for reuse.
  - `login_event` is append-only (app role and owner both refused).
  - Partitions exist for this month and 3 ahead, and maintenance is idempotent. Rows near a UTC month boundary go to the right partition, and a row with no partition is rejected.
  - Overlapping subscription periods are refused.
  - UUIDv7 ids have the right format and are time-ordered.
- **Drift (`schema-drift.test.ts`):** Prisma reports an empty diff between `prisma/schema` and the migrated database.

### How to run what exists

```
pnpm install
copy .env.example .env      (then set passwords)
docker compose up -d --wait
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
```

### Next

Commit 4: API kernel. This covers config (env schema), structured logging with OpenTelemetry, request context, error handling, idempotency keys, rate limiting, and the OpenAPI registry.

## Setup on this computer

- pnpm 11.28.9 is installed in the user npm folder. pnpm runs project scripts with Node 24.22.3, which it downloaded itself; the system Node is still 22.14.
- Docker Desktop 29.9 is installed. The local `.env` was generated with random passwords (git-ignored).
- A separate native PostgreSQL 17 service (`postgresql-x64-17`) uses port 5432 on this computer, so Fibrex's database is on **5433**.
- pnpm build scripts are allowed only for `prisma` and `@prisma/engines` (`allowBuilds` in `pnpm-workspace.yaml`).
- To use Node 24 outside pnpm, install Node 24 LTS from nodejs.org.

## Adapter stubs still to replace

(none yet; the SMS stub for phone OTP arrives in commit 7)

## Known issues

- Development only: the official Postgres image trusts connections made from *inside* its own container. Use `docker compose run --no-deps ... -h postgres` (a separate container) when testing passwords. The bootstrap `postgres` superuser can also log in over the local network. Neither applies to staging or production, which use managed PostgreSQL.
