# Fibrex Platform — rules for Claude Code

This repository builds the platform described in `docs/SPEC.md`. That file is the source of truth.
Work one phase at a time from `docs/phases/`. Never start a later phase before the current one is accepted.

## Every session

1. Read this file, `docs/PROGRESS.md`, `docs/DECISIONS.md`, and the current phase file.
2. Read the SPEC sections the phase file lists. Do not rely on memory of earlier sessions.
3. Plan first, wait for approval, then build in small commits.
4. End by updating `docs/PROGRESS.md`. Record any design choice in `docs/DECISIONS.md`.

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

- Start everything: `docker compose up`
- Tests: `pnpm test` | Lint: `pnpm lint` | Type check: `pnpm typecheck`
- Migrate: `pnpm db:migrate` | Seed: `pnpm db:seed`
