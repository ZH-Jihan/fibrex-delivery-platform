# Progress

Update this file at the end of every session.

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

| Commit | What | Verified |
| --- | --- | --- |
| 4 | API kernel in `apps/api/src`: validated env config, request context (AsyncLocalStorage), pino JSON logs with redaction and request/trace ids, RFC 9457 error handling, Redis rate limiting, Idempotency-Key handling, Helmet and strict CORS, `/health` and `/ready`, an OpenAPI 3.1 registry with `/api/v1/openapi.json` and Swagger UI at `/api/docs`, optional OpenTelemetry tracing, graceful shutdown | Yes. 91 tests pass (66 in the API: 20 unit, 46 integration with throwaway Postgres and Redis containers). Typecheck, lint and format pass. A manual run against the local Docker stack reports `ready` with database and Redis `ok`, and a bad config refuses to start with a list of problems. |

Commit 4 tests:

- **Unit:**
  - Env parsing: defaults, origin rules, https required in production, and errors listed without echoing secret values.
  - Problem document shape; Zod and body-parser error mapping; unknown errors hidden.
  - Request fingerprint canonicalisation.
  - Context isolation across concurrent requests.
- **Integration (`http-kernel.test.ts`):**
  - Request ids are generated, a well-formed incoming id is kept, and junk is replaced.
  - 404, validation, malformed JSON, 413 and 500 return problem documents, with no internal details in the 500.
  - Readiness returns 503 naming the failed check without its error message.
  - Idempotency:
    - a key is required except on `/auth/*`;
    - a repeat runs the handler once and replays the response;
    - a different body with the same key gets 422;
    - keys are scoped per caller;
    - a duplicate sent while the first is still running gets 409;
    - after a 5xx the key is released so the client can retry.
  - Rate limit: 429 with Retry-After and RateLimit-* headers, counted per caller, and probes are not limited.
  - With Redis down, reads still work (fail open) and writes get 503 without running (fail closed).
  - Helmet headers are present; CORS allows only configured origins.
  - The OpenAPI document includes routes, the Problem schema and the required Idempotency-Key header; Swagger UI loads.

### How to run what exists

```
pnpm install
copy .env.example .env      (then set passwords)
docker compose up -d --wait
pnpm db:migrate
pnpm --filter @fibrex/api dev     (API on http://localhost:3000; docs at /api/docs)
pnpm test
pnpm typecheck
pnpm lint
```

### Next

Commit 5: kernel database layer. This covers the Prisma client on the shared pool, a unit of work that sets the RLS context (`SET LOCAL`) for each request, the soft-delete extension, optimistic locking with 409 and a diff, and the generic CRUD controller factory.

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

## Commit 6: audit (2026-11-14)

- Migration `20261114000000_audit`: `audit.audit_log` (monthly partitions), `audit_seal`, `export_log`; trigger `zz_audit` on every S/T table and `platform.tenant`; `app.setup_table` now attaches it to new tables.
- Sealing numbers rows at seal time (no writer lock), sha256 chain per tenant; `audit.verify_chain()` detects changed or removed rows. Cutting off the newest seals with their rows is only detectable through the WORM export (commit 8).
- Note for commit 7: the trigger audits every S/T table, including `iam.session` and `iam.refresh_token`; throttle "last seen" style updates or they flood the log.
- Tests: 31 new (8 unit, 23 integration in `test/integration/audit.test.ts`). Full suite 151.

## Commit 8 (party and files)

- Migration `20261114000300_party_files`: schemas `files` (file_object, file_attachment, raw_input) and `party` (9 tables); GiST exclusions for one identifier holder at a time and non-overlapping roles; check constraint for the two-person bank rule; `iam.user_account.party_id` foreign key added.
- Not built: malware scan, photo type check, party search on sensitive ids by substring (by design), `/party-merges` history listing endpoint (data is in `party.party_merge`).
- Tests: 18 new integration tests in `test/integration/party-files.test.ts`. Full suite 271 (32 shared, 10 eslint-config, 229 api).
