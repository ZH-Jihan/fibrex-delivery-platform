# Architecture (Phase 1 version)

Short map of the platform. The rules and reasons are in `docs/SPEC.md` (section numbers in brackets); this file says where things are.

## 1. Shape

A pnpm monorepo. One API process (Express, TypeScript), one web app (React 18 + Vite), PostgreSQL 16 with row-level security, Redis (BullMQ queues, rate limits, idempotency), S3-compatible storage.

| Path | What |
| --- | --- |
| `apps/api` | API and background jobs |
| `apps/web` | Web app and Playwright journeys (`e2e/`) |
| `packages/shared` | Zod schemas, money helpers, the one `can()` permission function (used by API and web) |
| `packages/eslint-config`, `packages/tsconfig` | Shared lint and TypeScript settings |
| `infra/docker` | Postgres role script, SeaweedFS entrypoint |
| `docs` | SPEC, PLAN, DECISIONS, PROGRESS, phase plans |

## 2. API layers

```
apps/api/src
  main.ts          wires everything: config, pool, services, routers, permission catalogue sync, jobs
  app.ts           Express app: middleware order and error handling
  kernel/          shared layers no module can skip
    config  context  db  http  auth  permissions  audit  platform  jobs  redis  crypto  observability
  modules/         business modules: party, files, notify (each exposes only its index.ts)
  adapters/        external services behind an interface: messaging (stub, SMTP), storage (S3, memory)
  seed/            demo tenant, e2e users, e2e database helpers (dev and CI only)
```

Rules (SPEC 2.13): modules talk through each other's `index.ts` interface and events, never internals; ESLint enforces the boundaries. External services are reached only through `adapters/`, each with a stub for development.

## 3. Request flow

1. `requestContextMiddleware` assigns a request id and context.
2. Security headers, CORS (exact origins), health endpoints (`GET /health`, readiness).
3. Under `/api/v1`: rate limit, JSON body (size limited), `authenticate` (access token, API key or impersonation token).
4. Router handler. CRUD resources use `kernel/http/crud-router.ts`, which checks the permission (`permissions.authorize`), validates with Zod, and runs inside a **unit of work**.
5. `kernel/db/unit-of-work.ts` opens one transaction and sets the row-level-security context (tenant, company, user, scopes) on it. Repositories (`kernel/db/repository.ts`) add soft delete, `version` checks (409 with a field diff on conflict) and audit columns.
6. A database trigger writes the change to `audit` with a field diff. Errors leave as RFC 9457 problem responses (`kernel/http/error-handler.ts`). Mutations accept an `Idempotency-Key`.

## 4. Data and security model

- Every business table has `tenant_id`, usually `company_id`, audit columns, `version`, soft-delete columns. `app.setup_table(schema, table, kind)` (migration `foundation_helpers`) installs triggers, grants and the RLS policy. Kinds: `company`, `tenant`, `company_append`, `tenant_append`, `global`, `global_catalog`.
- Two database roles: `fibrex_owner` runs migrations and seeds; `fibrex_app` (NOBYPASSRLS, no DELETE or TRUNCATE) runs the API. So there are no physical deletes and no bypassing RLS from the app.
- Migrations are hand-written SQL in `apps/api/prisma/migrations/`; `apps/api/prisma/schema/*.prisma` mirrors them (a drift test enforces it). Never use `prisma migrate dev`.
- People and organisations live once in `party`; modules store `party_id`. Money is never stored as a balance on a module: it is journal entries through the posting service (Phase 2).
- Permissions: keys `<module>.<thing>.<action>` are declared in code (`kernel/permissions/catalogue.ts`, `crudPermissions`) and synced to `iam.permission` at start-up. Who holds a key is data (roles, matrix, per-user overrides, data scopes). Access is read from the database on every request. `packages/shared/src/permissions` is the single `can()`.
- Auth (`kernel/auth`): Argon2id passwords, signed access tokens, rotating refresh cookie with reuse detection, TOTP and phone codes, lockout, impersonation (both identities audited), API clients and keys.
- Audit (`kernel/audit`): change trigger, hash-chained sealing every minute, verify endpoint, recycle bin and restore.
- Secrets in the database (TOTP seeds, identifiers) use `kernel/crypto/secret-box.ts` with `DATA_ENCRYPTION_KEY`.

## 5. Web app

`apps/web/src`: `api/` client (token in memory, refresh on 401, idempotency keys), `auth/`, `shell/` (layouts, `nav.ts` menu manifest, command palette, bell), `ui/` (DataTable, EntityForm, HistoryTab, Modal, Menu, ConfirmDialog, toasts), `admin/ org/ people/ audit/ me/` (screens), `i18n/` (en plus draft bn, ur, hi, ne), `theme/` (CSS tokens, light and dark, three breakpoints). Menu entries and buttons are filtered by `can()`; the API still enforces everything.

## 6. Tests and CI

| Command | What |
| --- | --- |
| `pnpm test:unit` | unit tests, no services |
| `pnpm test` | unit + integration (API integration tests start their own Postgres, Redis and Mailpit containers; Docker must run) + web tests |
| `pnpm --filter @fibrex/web test:e2e` | Playwright on its own database `fibrex_e2e`, API on 3100, web on 5174 |

`.github/workflows/ci.yml` runs lint, typecheck, `pnpm test`, then Playwright on every push and pull request to main, with a throwaway `.env` of random secrets. Playwright screenshots and traces upload only on failure. `deploy-staging.yml` is manual and disabled until hosting is chosen.

## 7. Where to find things

| Looking for | Go to |
| --- | --- |
| Environment variables | `.env.example`, `kernel/config/env.ts` |
| Table definitions | `apps/api/prisma/migrations/*`, `apps/api/prisma/schema/*.prisma` |
| A route's contract | `/api/docs` on a running API (OpenAPI built from the Zod schemas) |
| Permission keys | `kernel/permissions/catalogue.ts` and each module's `*_PERMISSIONS` |
| Background jobs | `kernel/jobs/scheduler.ts`, `/jobs` monitor |
| Demo data | `apps/api/src/seed`, `pnpm db:seed` |
| Decisions and progress | `docs/DECISIONS.md`, `docs/PROGRESS.md` |
