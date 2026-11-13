# Progress

Update this file at the end of every session.

| Phase | Title | Status | Accepted on | Notes |
| --- | --- | --- | --- | --- |
| 1 | Foundation A | In progress (commits 1–2 of 13) | | Plan: `docs/phases/phase-01-plan.md` |
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

### How to run what exists

```
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Once Docker Desktop is installed:

```
copy .env.example .env
docker compose up -d
```

### Next

Commit 3: Prisma setup; `platform` and `iam` schemas; RLS policies, triggers and partitions; the RLS isolation test. This needs Docker to run its tests.

## Setup on this computer

- pnpm 11.28.9 is installed in the user npm folder. pnpm runs project scripts with Node 24.22.3, which it downloaded itself; the system Node is still 22.14.
- Docker Desktop 29.9 is installed. The local `.env` was generated with random passwords (git-ignored).
- To use Node 24 outside pnpm, install Node 24 LTS from nodejs.org.

## Adapter stubs still to replace

(none yet; the SMS stub for phone OTP arrives in commit 7)

## Known issues

- Development only: the official Postgres image trusts connections made from *inside* its own container. Use `docker compose run --no-deps ... -h postgres` (a separate container) when testing passwords. The bootstrap `postgres` superuser can also log in over the local network. Neither applies to staging or production, which use managed PostgreSQL.
