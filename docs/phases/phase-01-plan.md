# Phase 1 plan: Foundation A

Status: **waiting for approval**. Based on `docs/PLAN.md` (approved 2026-11-13) and `docs/phases/phase-01.md`.

## 1. Before building: three blockers on this computer

| # | Finding | Effect | Proposal |
| --- | --- | --- | --- |
| B1 | **Docker is not installed.** | `docker compose up` (a Done-when item) cannot run. Integration tests, including the RLS test, need a real PostgreSQL and Redis. | Install Docker Desktop for Windows (with WSL 2), then restart. I can write code without it, but I cannot claim the phase works until the tests run. |
| B2 | **pnpm is not installed.** Node and corepack are installed. | The monorepo uses pnpm workspaces. | With your OK, I run `corepack enable` and pin pnpm in `package.json`. This may need an administrator terminal. |
| B3 | **The Node version in the stack has expired.** Node 20 reached end of life on 30 April 2026. This computer has Node 22. | CLAUDE.md says "Node 20, do not substitute", but SPEC 6.6 says "supported LTS versions only". These two rules conflict. | Use **Node 24 LTS** (supported until April 2028) in Docker and CI, and install it locally. Node 22 also works, but its support ends in April 2027. This needs your decision, because it changes a non-negotiable rule. |

## 2. Scope (from `phase-01.md`)

Phase 1 covers:

- Project setup and CI
- A staging deploy definition (it stays disabled until hosting is chosen)
- The multi-tenant schema with row-level security (RLS)
- The party model
- Authentication
- Roles and the permission matrix
- Audit trail
- Soft delete and the recycle bin
- The notification service
- The app shell and design system

Not in Phase 1:

- Dynamic engines, templates, the ledger, outbox webhooks and import/export, which belong to Phase 2.
- WhatsApp, SMS, push notifications and broadcasts, which belong to Phase 9.

## 3. Tables created

These are the tables from PLAN sections 3.1–3.6. Every table follows the S, T, A or G column rules, with RLS policies, audit triggers and grants with no DELETE.

| Schema | Tables |
| --- | --- |
| `platform` | tenant, subscription_plan, tenant_subscription, usage_counter, company, branch, org_unit, company_module, setting, number_sequence, currency, inter_company_link |
| `iam` | user_account, credential, mfa_factor, mfa_recovery_code, otp_challenge, company_membership, membership_role, role, role_grantable, permission, role_permission, user_permission_override, data_scope, session, refresh_token, login_event (partitioned), password_reset_token, impersonation, api_client, api_key, ip_allowlist, sso_provider |
| `audit` | audit_log (partitioned), audit_seal, export_log |
| `notify` | event_type, notification_rule, notification (partitioned), notification_delivery (partitioned), notification_preference |
| `party` | party, party_role, party_identifier, party_contact, party_address, party_relationship, party_bank_account, party_duplicate_candidate, party_merge |
| `files` | file_object, file_attachment, raw_input |

Also written as SQL in the migrations:

- Database roles: `fibrex_owner` (migrations), `fibrex_app` (NOBYPASSRLS, no DELETE), `fibrex_bi`
- A `uuid_generate_v7()` function
- Generic triggers for audit, `updated_at`/`version`, and blocking writes to append-only tables
- A job that creates monthly partitions 3 months ahead
- `pg_trgm` and full-text indexes for party search

**Phase 1 simplification.** `notification_rule` stores its title and body as short Handlebars text with merge fields. In Phase 2 it switches to `template_key` from the template engine. This is additive: the text columns are kept as a fallback, and nothing is a stub.

## 4. Endpoints

Phase 1 delivers the endpoints in PLAN sections 5.2–5.8, apart from the [P9] items. In short:

- **System:** health, ready, OpenAPI, global search over parties, job monitor
- **Auth:** login, refresh, logout, password change/forgot/reset, TOTP setup/confirm/verify, re-authentication, `/me` (permissions, sessions, login history, switch company)
- **Administration:**
  - users (lock, unlock, reset, memberships, overrides, scopes)
  - roles (grantable roles) and the permission catalogue and matrix
  - impersonation
  - API clients and keys
- **Platform:** companies (settings, module flags), branches, org units (zones and teams), number sequences, settings, currencies
- **Audit:** audit log (filters, export, hash-chain verify), record history, recycle bin (list, restore)
- **Notifications:** list, unread count, mark read, preferences, notification rules (with a test send), Socket.IO `/realtime`
- **Party:** parties, roles, identifiers, contacts, addresses, relationships, bank accounts (verify, second approval), duplicates, merge preview and merge
- **Files:** upload URL, complete, download URL, attachments and versions

Phone OTP login is built and tested, but SMS delivery goes through a **stub SMS adapter** that writes the code to the dev log. The stub is listed in PROGRESS.md until Phase 9.

## 5. Screens (web)

| Area | Screens |
| --- | --- |
| Auth | Login (password or phone OTP), first-login password change, TOTP setup with QR and recovery codes, TOTP prompt, forgot and reset password |
| Shell | Collapsible sidebar grouped by area (menus come from module manifests and permissions), top bar with Ctrl+K search, notification bell, theme switch (light/dark), language switch, company switcher, user menu, impersonation banner |
| Administration | Users (list, form, sessions, login history), Roles, **Permission matrix** (tick boxes per role, plus per-user grant/deny overrides and data scopes), API clients |
| Organisation | Company settings (legal name, logo, currency, time zone, working week, financial year start, module flags), Branches, Zones and teams, Number sequences |
| Audit | **Activity Log** (filters, export), **Recycle Bin** (per module, restore), a reusable **History tab** on every record |
| People | Parties (list, detail with roles, identifiers, contacts, bank accounts, history), duplicate review, merge wizard |
| Me | Profile, my sessions (remote logout), login history, notification centre and preferences |

Shared components built once:

- `DataTable`: search, filters, sort, pagination, column chooser, export to Excel/PDF/CSV
- `EntityForm`: React Hook Form + Zod from `packages/shared`
- Others: `HistoryTab`, `ConfirmDialog`, skeletons and empty states, toasts, the `can()` guard

Languages: i18n with English, Bangla, Urdu, Hindi and Nepali string files, with RTL handled for Urdu. I can draft the non-English strings, but they **need review by a native speaker**. The status of each language file is listed in PROGRESS.md.

## 6. Tests mapped to "Done when"

| Done-when item | Test |
| --- | --- |
| Compose starts everything; the seed creates a tenant, a company and a Super Admin | CI job: `docker compose up -d`, wait for health, run the seed, call `/health` and log in |
| A second tenant cannot read the first tenant's rows even with the app filter removed | Integration test: connect as `fibrex_app`, set tenant B's context, run raw `SELECT * FROM party.party` with no WHERE, and expect 0 rows from tenant A. The same for company isolation. Also check that `DELETE` is refused by grants. |
| Roles, users and matrix edits work; a denied action is blocked on the API | Unit tests for `can()`: role grant, user deny beats role grant, user grant, scope own/zone. Integration test: remove a permission in the matrix and get 403 on the API. Playwright: the button is hidden. |
| Create, update, delete and restore appear in History and the Activity Log with a field diff | Integration test on a party: 4 actions give 4 audit rows with the correct diffs, both from the trigger and from a raw-SQL path. Version conflict gives 409 with a diff. |
| Deleted records appear in the Recycle Bin and can be restored | Integration and Playwright tests |
| In-app notification arrives in real time; email goes through the queue | Integration test: emit an event, the rule resolves, the Socket.IO client receives it, and the BullMQ email job is delivered to Mailpit (checked through the Mailpit API) |
| CI runs lint, type check and tests on every push | `.github/workflows/ci.yml`: lint, typecheck, unit, integration (service containers), Playwright, dependency and secret scan |
| Auth security | Account locks after 5 failures; refresh token reuse revokes the whole token family; forced password change; MFA is mandatory for super_admin, admin and owner; impersonation is logged with both identities |

## 7. Commit sequence (each one small and passing)

1. `git init`, workspace skeleton, TypeScript strict, ESLint (with module boundaries), Prettier, Vitest, `.env.example`
2. Docker Compose (postgres 16, redis, minio, mailpit, api, worker, web) and database roles
3. Prisma setup; platform and iam schema; RLS, triggers and partition SQL; the RLS test
4. Kernel: config, logging/OpenTelemetry, request context, error handling, idempotency, rate limiting, OpenAPI
5. Kernel: database tenant context, soft-delete extension, optimistic locking, CRUD factory
6. Audit: triggers, AuditService, sealing job, audit endpoints, recycle bin
7. IAM: auth, sessions, MFA, OTP (stub SMS), users, roles, permission matrix, `can()`, impersonation, API keys
8. Party and files modules (MinIO, signed URLs, versions), duplicate detection and merge
9. Notifications: rules, in-app with Socket.IO, email queue (Mailpit through the SMTP adapter)
10. Seed: tenant, company, branch, roles and permissions, Super Admin (password generated into the local `.env`, never committed), synthetic parties
11. Web: design system, shell, auth screens, shared components, i18n
12. Web: admin, organisation, audit, people and "me" screens; Playwright journeys
13. CI workflow; staging deploy workflow (disabled until hosting is chosen); docs (`ARCHITECTURE.md` first version, `ADDING_A_MODULE.md`); PROGRESS.md

## 8. Questions

1. **B3:** Node 24 LTS instead of the expired Node 20? Or Node 22?
2. **B1/B2:** Will you install Docker Desktop, and may I run `corepack enable` for pnpm?
3. **GitHub:** When you have created the private repository, send me its URL and I will add it as `origin`. I will push only when you say so. Until then CI is written but cannot run.
4. **Staging:** Hosting is "decide later", so the Done-when item "CI/CD and staging" can only be partly met in Phase 1: CI runs, and the staging deploy file exists but is disabled. Is that acceptable for accepting Phase 1?
