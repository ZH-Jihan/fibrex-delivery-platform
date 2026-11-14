# Progress

Keep this file short (see CLAUDE.md rule 8). Full verification detail: `docs/progress-log/phase-01-details.md` (do not read by default).

| Phase | Title | Status | Accepted on | Notes |
| --- | --- | --- | --- | --- |
| 1 | Foundation A | In progress (commits 1–12c of 13) | | Plan: `docs/phases/phase-01-plan.md` |
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
| 8 | Party and files (`modules/party`, `modules/files`, `adapters/storage`, migration `party_files`): parties with roles, identifiers (encrypted, hashed, one holder at a time), contacts, addresses, relationships, bank accounts (second-person approval), duplicate detection and review, merge with preview and history; signed uploads verified by size, SHA-256 and type, downloads (audited), attachments with versions, raw inputs | 271 tests pass in total |
| 9 | Notifications and jobs (`modules/notify`, `kernel/jobs`, `adapters/messaging/smtp.ts`, migration `notify`): rules with Handlebars text, recipients by user, role or payload field, per-user channel preferences, insert-only notifications/read marks/delivery steps, Socket.IO `/realtime` push, BullMQ email queue with retries into SMTP (Mailpit), job scheduler (audit sealing every minute, partition maintenance daily), `/jobs` monitor. Not built: Redis adapter for several API instances; rule limited to one company through the API | 282 tests pass in total (11 new, incl. Mailpit) |
| 10 | Seed (`apps/api/src/seed`, `pnpm db:seed`, owner role, dev/CI only, refuses production): idempotent demo tenant, company, branch HQ, roles super_admin/admin/manager/viewer with matrix rows and grantable links, Super Admin (password generated into `.env` as `SEED_SUPERADMIN_PASSWORD`), 6 synthetic parties | 283 tests pass in total |
| 11 | Web (`apps/web`, Vite + React 18): CSS-token design system (light/dark, RTL-safe), API client (in-memory token, refresh on 401, idempotency keys), auth state with shared `can()`, screens for sign-in (password or phone code), second step, forced password change, TOTP set-up with QR and recovery codes, forgot/reset; shell with permission-filtered menu (`shell/nav.ts`, empty until commit 12), company switcher, impersonation banner; Button/Field/ConfirmDialog/toasts/skeleton; i18n en/bn/ur/hi/ne. **bn, ur, hi, ne are drafts (only core keys) and need native-speaker review.** Not built yet: Ctrl+K search, notification bell, DataTable, EntityForm, HistoryTab (commit 12) | 296 tests pass in total (13 new) |
| 12a | Web shared components and admin (`ui/DataTable`, `EntityForm`, `HistoryTab`, `useReauth`, `shell/NotificationBell`, `CommandPalette`, `admin/*`, `packages/shared/src/admin`): list with search, sort, paging, column chooser, CSV export; forms checked by shared Zod schemas; users (list, create, profile, sessions, sign-in history, History, lock, sign out, reset, delete), roles, permission matrix with re-authentication; bell polls every 30 s; Ctrl+K lists menu screens. Not built: Excel/PDF export, React Hook Form (plain state used), user memberships/overrides/scopes and API clients screens | 303 tests pass in total (7 new) |

| 12b | Web: user memberships tab (companies, roles, default; re-auth), audit log with integrity check, recycle bin with restore, people list/create, My account (sessions, sign-in history) | 306 tests pass in total (3 new) |

| 12c | Organisation API (`kernel/platform/organisation-router.ts`): `/companies` (only your own; settings change; base currency fixed), `/branches` CRUD with one head office, recycle-bin entry; screens Company and Branches. Playwright (`apps/web/e2e`, `pnpm --filter @fibrex/web test:e2e`; users from `pnpm db:seed:e2e`, no MFA): sign-in, read-only user sees no create/edit buttons, branch create/edit/delete/recycle-bin/restore. The API sign-in limit (20/min) can block back-to-back runs against a long-running API; a fresh start raises it | 314 tests pass in total (8 new) + 3 Playwright |

| 12d | Web: readable permission labels. Matrix shows the description as the main label with the key below in small muted text; module and permission text through `tOr()` (en, draft bn; falls back to the database text). bn is a draft for native-speaker review; a few long descriptions have no bn text yet and show English | 28 web tests pass (1 new); lint and typecheck clean; API suite not re-run (no API change) |

| 12e | Web: responsive modern redesign. lucide-react icons on every menu entry, button and status; self-hosted Inter and Hind Siliguri (@fontsource); three layouts from `theme/useBreakpoint.ts` (desktop sidebar collapsible, tablet icon rail with hover/pin, mobile top bar + drawer + bottom tab bar); avatar menu (language, theme, sign out on mobile); DataTable rows as cards with an actions menu, filters sheet and short pager on phones; `ui/Modal`, `ui/Menu`, PageHeader, Pill, Select, Checkbox, SearchInput; Vite `strictPort`. Playwright `e2e/responsive.spec.ts` checks Users, Roles, Permission matrix and Branches at 375/768/1280 px for horizontal scroll and saves screenshots to `apps/web/e2e/screenshots/` (git-ignored) | 32 web tests pass (4 new); lint and typecheck clean; Playwright 3 journeys + 3 responsive pass |

## Deferred (from 12c, to schedule later)

- Ctrl+K party search (Ctrl+K still lists menu screens only).
- Socket.IO push for the notification bell (the bell polls every 30 s).
- User permission overrides and data-scope screens (the API exists).
- API clients screens (the API exists).
- Organisation: zones and teams, number sequences and company module flags (no API yet); company create and logo.

## Next

Commit 13 (mid model): CI (`.github/workflows/ci.yml`, including Playwright) and docs. Still waiting: export of sealed audit batches to write-once storage (`audit_seal.worm_object_key`); data-scope ids for client platforms; virus scanning of uploads (files stay `not_scanned`).

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

- `apps/api/src/adapters/messaging/stub.ts` (SMS and email): sign-in codes and password-reset links are written to the API log instead of being sent (text hidden in production). Email uses the SMTP adapter (`smtp.ts`) whenever `SMTP_HOST` is set; SMS gets a real provider in Phase 9.

- `apps/api/src/adapters/storage/memory.ts` (in-memory object store): used by tests only; development and production use the S3 adapter (`S3_*` variables, the API will not start without them).

## Known issues

- Development only: the official Postgres image trusts connections made from *inside* its own container. Use `docker compose run --no-deps ... -h postgres` (a separate container) when testing passwords. The bootstrap `postgres` superuser can also log in over the local network. Neither applies to staging or production, which use managed PostgreSQL.
