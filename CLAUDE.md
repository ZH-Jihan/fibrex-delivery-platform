# Fibrex Platform — rules for Claude Code

This repository builds the platform described in `docs/SPEC.md`. That file is the source of truth.
Work one phase at a time from `docs/phases/`. Never start a later phase before the current one is accepted.

## Every session (token budget rules)

Usage is limited. Keep every session small and cheap.

1. One commit of the phase plan per session. When it is done and verified, stop and tell the user to run `/clear` before the next one.
2. Read only: this file, `docs/PROGRESS.md`, and the current commit's line in the phase plan (for example `docs/phases/phase-01-plan.md` section 7).
3. Never read `docs/SPEC.md` or `docs/PLAN.md` whole. Find the section you need with a search for its heading and read only that range. Same for `docs/DECISIONS.md`: read only the row you need.
4. Do not read `docs/progress-log/`, `pnpm-lock.yaml`, `node_modules`, build output or generated files. Search before reading; read line ranges, not whole large files.
5. Do not re-plan what the phase plan already decided. Ask only when something blocks you.
6. Run the narrowest test that proves the change while working (one file or one filter). Run the full suite once, at the end. Show only failures and the final summary line, not full logs.
7. Keep replies short: what changed, how it was verified, what is next. No long recaps, no restating the plan.
8. End of session: add at most 5 lines to `docs/PROGRESS.md` (status table row, what was built in one line, the test count, the next commit). Put any longer detail in `docs/progress-log/phase-NN-details.md`, which is never read back by default.
9. Record a design choice in `docs/DECISIONS.md` only when it changes something a later phase depends on, in one row.

## Which model to use

Say at the start of a session which tier this commit needs; if the active model is a different tier, ask the user to switch with `/model` before starting.

| Tier | Use for |
| --- | --- |
| Strongest model (Opus class) | Planning a new phase; row-level security and tenancy; authentication, permissions and encryption; audit integrity; the ledger and posting service; rules and formula engine; payroll calculation and posting; loan allocation; data import with reconciliation; database migrations on tables that hold data; debugging a failure that survived two attempts |
| Mid model (Sonnet class) | Ordinary modules and CRUD on the existing patterns; web screens and components; notifications; seeds; reports; tests for existing behaviour; CI and deployment files; adapters and stubs |
| Small model (Haiku class) | Updating `PROGRESS.md` and docs; renames and formatting; translations and i18n keys; simple config edits; summarising a log |

Phase 1 remaining commits: 5 kernel database layer, 6 audit, 7 IAM = strongest. 8 party and files, 9 notifications, 10 seed, 11 web shell and design system, 12 web screens and Playwright, 13 CI and docs = mid.

Later phases: plan each phase with the strongest model, then build with the mid model, switching up only for the items in the first row. Phases 2 (engines and ledger), 6 (loans and fund) and 7 (payroll) are mostly strongest-tier work; phases 3, 4, 5, 9 and 10 are mostly mid-tier.

## Non-negotiable rules

- Stack: React 18 + TypeScript + Vite, Node 24 LTS + Express + TypeScript, PostgreSQL 16 + Prisma, BullMQ + Redis, S3-compatible storage. Do not substitute.
- Anything the business may change is data or configuration, never code or schema (SPEC 2.6).
- Every business table has `tenant_id`, `company_id`, audit columns, `version`, soft-delete columns, and row-level security (SPEC 2.7, 2.12).
- People and organisations live once in `party`; modules reference `party_id` (SPEC 2.8).
- Money: no module stores its own balance. Post balanced journal entries through the posting service; posted entries are immutable; corrections are reversals; `NUMERIC(18,4)` with a currency code (SPEC 2.9).
- No physical deletes through the app. Audit logging and permission checks happen in shared layers so a module cannot skip them (SPEC 2.1-2.3).
- Modules talk through service interfaces and events only; no imports of another module's internals (SPEC 2.13).
- External services sit behind adapters with a stub implementation for development (SPEC 2.11).
- Formulas run in a sandboxed expression engine. Never use `eval`. Never let an LLM produce or run raw SQL.
- Migrations are additive (expand then contract). No destructive migration without an archived copy.

## Code quality

- TypeScript strict. Shared Zod schemas in `packages/shared`.
- Each service file starts with a header comment: purpose, what it depends on, what depends on it.
- Complex logic (payroll posting, ledger, allocation, sheet normalisation, permissions, workflow) has step-by-step comments explaining why. Business rules are commented where they are implemented.
- No placeholders or TODO stubs in delivered code, except adapter stubs that are clearly named and listed in `docs/PROGRESS.md`.
- Unit tests for all money and rule logic; integration tests for API flows; Playwright for the main journeys.

## Safety

- Never commit secrets, `.env` files, or anything in `reference/` (real personal and financial data).
- Use only masked or synthetic data in seeds and tests. Fixtures derived from `reference/` must be anonymised.
- If a requirement is unclear or two requirements conflict, stop and ask. Do not guess on money rules.
- Do not claim something works unless you ran it. Report failing tests plainly.

## Commands (fill in during Phase 1)

- First time: copy `.env.example` to `.env` and set passwords; `pnpm install`
- Start everything: `docker compose up -d --wait` (Postgres is on host port 5433)
- Tests: `pnpm test` (integration tests start their own Postgres container; Docker must be running) | Unit only: `pnpm test:unit`
- Lint: `pnpm lint` | Type check: `pnpm typecheck` (also regenerates the Prisma client) | Format: `pnpm format`
- Migrate: `pnpm db:migrate` | Status: `pnpm db:status` | Seed: `pnpm db:seed` (arrives in commit 10)
- Migrations are hand-written SQL in `apps/api/prisma/migrations/`; keep `apps/api/prisma/schema/*.prisma` in step (the drift test enforces it). Never author migrations with `prisma migrate dev`.
