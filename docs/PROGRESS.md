# Progress

Keep this file short (see CLAUDE.md rule 8). Full verification detail: `docs/progress-log/phase-01-details.md` (do not read by default).

| Phase | Title | Status | Accepted on | Notes |
| --- | --- | --- | --- | --- |
| 1 | Foundation A | In progress (commits 1–7 of 13) | | Plan: `docs/phases/phase-01-plan.md` |
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

## Current state (2026-11-14)

`docs/PLAN.md` and `docs/phases/phase-01-plan.md` are approved. Phase 1 is built in the 13 commits of section 7 of the phase plan.

| Commit | What | Verified |
| --- | --- | --- |
| 1 | Workspace, TypeScript, ESLint module boundaries, shared money helpers | 25 unit tests pass |
| 2 | Docker Compose (Postgres on 5433, Redis, SeaweedFS S3, Mailpit), database roles | Stack healthy, role and password checks done |
| 3 | Hand-written SQL migrations: `app` helpers, 35 `platform` and `iam` tables with RLS; matching Prisma schema | 26 integration tests (RLS, integrity, drift) pass |
| 4 | API kernel: config, context, logging, errors, rate limit, idempotency, OpenAPI, health | 91 tests pass in total |
| 5 | Kernel database layer (`kernel/db`, `kernel/http/crud-router.ts`): Prisma on the shared pool, unit of work setting the RLS context, soft-delete extension, versioned repository (409 with diff), CRUD router factory | 120 tests pass in total |
| 6 | Audit (`audit` schema, `kernel/audit`): change trigger with field diff on every S and T table, AuditService, hash-chain sealing and verify, audit and recycle-bin endpoints | 151 tests pass in total |
| 7a | Auth and sessions (`kernel/auth`, mounted in `main.ts`): Argon2id passwords, signed access tokens, sign-in with lockout and login history, rotating refresh cookie with reuse detection and CSRF, forced password change, password policy, `/me`, sessions, remote sign-out | 174 tests pass in total |
| 7b | MFA and one-time codes (`kernel/auth/mfa.ts`, `totp.ts`, `kernel/crypto/secret-box.ts`, `adapters/messaging`): authenticator app (encrypted seed, replay protection, recovery codes, forced set-up for roles with `mfa_required`), second step at sign-in, phone sign-in codes, forgot/reset password, re-authentication. Not built: re-auth by phone code for users with neither password nor app | 197 tests pass in total |
| 7c | Permissions and administration (`packages/shared/src/permissions` = the one `can()`; `kernel/permissions`; `kernel/auth/user-admin-router.ts`): permission catalogue synced at start-up, access read from the database on every request, matrix, per-user overrides, data scopes, `/users`, `/roles`, memberships with anti-escalation rules, `/me/permissions`, `/me/companies`, switch company (new session). `main.ts` now mounts the user, access and audit routers. Deleting anything now needs a reason (400 without one) | 239 tests pass in total |
| 7d | Impersonation and API clients (`kernel/auth/impersonation.ts`, `api-keys.ts`, `api-client-router.ts`, migration `iam_api_keys`): separate impersonation token with both identities audited, `/api-clients` CRUD with scope rules, key issue/list/revoke, API-key sign-in with per-client rate limit. Not built: `POST /oauth/token` (kind `oauth_client`) | 253 tests pass in total |

## Next

Commit 8 (mid model): party and files modules. Still waiting: `sealAuditLog` gets its schedule from the job scheduler in commit 9; export of sealed batches to write-once storage (`audit_seal.worm_object_key`) waits for the storage adapter in commit 8; data-scope ids for client platforms are not checked until that table exists; the built-in roles and their matrix rows arrive with the seed in commit 10.

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

- `apps/api/src/adapters/messaging/stub.ts` (SMS and email): sign-in codes and password-reset links are written to the API log instead of being sent (text hidden in production). Email gets a real SMTP adapter in commit 9; SMS in Phase 9.

## Known issues

- Development only: the official Postgres image trusts connections made from *inside* its own container. Use `docker compose run --no-deps ... -h postgres` (a separate container) when testing passwords. The bootstrap `postgres` superuser can also log in over the local network. Neither applies to staging or production, which use managed PostgreSQL.
