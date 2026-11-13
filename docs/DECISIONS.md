# Decisions

## Open: the owner must answer these

Questions 11 onward come from `docs/PLAN.md` section 7 (the Q number there is shown in brackets).

| # | Question | Needed for | Answer |
| --- | --- | --- | --- |
| 1 | Salary columns: is `COD` an earning (as in the Excel formulas) or a deduction (as in the old app)? Are `Bills` and `Adjustments Minus` deducted? | Phase 7 | |
| 2 | Snoonu daily report sheet link and its column names | Phase 4 | |
| 3 | Company email list for document expiry alerts | Phase 3 | |
| 4 | Loan approval order: permitted admins, then owner, then manager. Confirm. | Phase 9 | |
| 5 | Should loans recorded under "Fibrex Delivery Service" stay as Company-type borrower entries or become company expenses? | Phase 6 | |
| 6 | Snoonu rate card and a sample payout statement | Phase 8 | |
| 7 | WPS salary file and bulk-transfer specification from the bank | Phase 7 | |
| 8 | WhatsApp Business and SMS provider accounts | Phase 9 | |
| 9 | Chart of accounts from the accountant, or approval to use a standard one. Also: which month does the financial year start? (PLAN Q12) | Phase 2 | |
| 11 | (Q3) Loan interest: (a) payment applied interest first, principal first, or proportionally? (b) interest income recognised when the loan is given or when collected? (c) investor profit share from interest charged or interest collected? | Phase 6 | |
| 12 | (Q4) Can a negative-salary advance be recorded without a signed loan paper? | Phase 6, 7 | |
| 13 | (Q5) Open-ended loans (term 0): after one month, is the status Open or Overdue? Proposal: copy the workbook's exact rule. | Phase 6 | |
| 14 | (Q6) A worker on two platforms in one month: one payslip or one per platform? | Phase 7 | |
| 15 | (Q7) Maximum deduction per month, minimum take-home, and order of deductions when earnings are not enough (confirm legal limits with the legal adviser) | Phase 7 | |
| 16 | (Q8) "Free" repayment plan loans: engine deducts nothing automatically (only file or manual)? | Phase 7 | |
| 17 | (Q14) COD outstanding at ID handover: owed by the ID owner or the operator? | Phase 4, 7 | |
| 18 | (Q15) Company-rented vehicle: is any rent deducted from the worker's salary? | Phase 5, 7 | |
| 19 | (Q16) Database dump or read-only access to the old payroll app's PostgreSQL for migration | Phase 7 | |
| 20 | (Q17) Currencies needed at launch besides QAR; are bKash amounts recorded in BDT or QAR? | Phase 2, 6 | |
| 21 | (Q18) Existing number formats to keep (payslip, invoice, handover slip) | Phase 2 | |
| 22 | (Q19) Retention period for ex-employee and unsuccessful-candidate records (legal adviser to confirm) | Phase 2, 12 | |
| 23 | (Q11) Hosting for staging and production | Before first deploy | Decide later (2026-11-13). Phase 1 builds CI and Docker; the deploy job is switched on once chosen. |
| 24 | (Q11) Email sending method: Gmail API or SMTP | Phase 3 | Decide later (2026-11-13). Development uses Mailpit through the email adapter. |

## Made

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-13 | PostgreSQL instead of MongoDB | Relational, financial data needs transactions and foreign keys |
| 2026-11-13 | Multi-tenant, party model and double-entry ledger from the first migration | Avoid a redesign in the next 5 to 10 years |
| 2026-11-13 | Default currency QAR, time zone Asia/Qatar, configurable per company | Company operates in Qatar |
| 2026-11-13 | Falcon ID, Falcon Flex ID and Snoonu ID are the same number: one `party_identifier` type for Snoonu, used by the sheet sync, salary file and loan workbook import (PLAN Q2) | Owner confirmed |
| 2026-11-13 | Two-factor login (TOTP) mandatory for Super Admin, Admin and Owner from the first release; stored as a per-role setting (PLAN Q9, conflict C10) | Owner chose the stricter SPEC 6.5 rule |
| 2026-11-13 | Product name in the interface: **Fibrex** (replaces the working name FleetForce) (DECISIONS #10) | Owner chose |
| 2026-11-13 | First-release interface languages: English, Bangla, Urdu, Hindi, Nepali. Arabic is not translated at launch, but RTL support stays in the i18n setup so it can be added without refactoring (SPEC 1) (DECISIONS #10) | Owner chose; the answer also ticked "English only", which was read as "English is included" |
| 2026-11-13 | Code stored in a private GitHub repository; CI on GitHub Actions. The owner creates the repository; nothing is pushed without asking (PLAN Q11) | Owner chose |
| 2026-11-13 | **Node 24 LTS replaces Node 20** in the stack (CLAUDE.md and SPEC 1 updated) | Node 20 reached end of life on 2026-04-30; SPEC 6.6 requires supported LTS versions only. Owner approved the substitution. |
| 2026-11-13 | Phase 1 plan approved (`docs/phases/phase-01-plan.md`). The staging deploy workflow is written but disabled until hosting is chosen; Phase 1 can be accepted on that basis | Hosting is "decide later" |
| 2026-11-13 | pnpm 11.28.9, pinned in `package.json` (`packageManager`), installed with npm into the user folder. Node 24 is pinned through `devEngines.runtime`, so pnpm downloads Node 24 for project scripts even where the machine has another Node | `corepack enable` needs administrator rights here, and corepack 0.31 cannot run pnpm 12 |
| 2026-11-13 | Package versions are chosen at least ~2 weeks after release (pnpm's `minimumReleaseAge` policy is left on). Pins: TypeScript 6.0 (typescript-eslint does not support TS 7 yet), Prisma 7.10 (latest stable), React 18.3 (SPEC), Zod 4, Express 5 | Supply-chain safety; stay on supported majors |
| 2026-11-13 | **Migrations are hand-written SQL, applied with `prisma migrate deploy`.** `prisma/schema/*.prisma` is maintained by hand to match, and an integration test (`schema-drift.test.ts`) fails if Prisma would generate any SQL against the migrated database. `prisma migrate dev` is not used to author migrations. | RLS policies, triggers, partitions, CHECK and exclusion constraints cannot be expressed in Prisma, and Prisma's generated diffs would try to drop objects it does not know. Reviewed SQL also makes expand-then-contract explicit. |
| 2026-11-13 | Prisma preview feature `partialIndexes` enabled | Unique keys must ignore soft-deleted rows (`WHERE deleted_at IS NULL`). The feature affects schema and migration tooling only, not runtime queries. |
| 2026-11-13 | Every table gets its triggers, grants and RLS policy from one SQL function, `app.setup_table(schema, table, kind)`, with kinds company / tenant / company_append / tenant_append / global / global_catalog | One definition of the rules, so no table is set up differently by mistake |
| 2026-11-13 | RLS is enabled but not FORCED, so the owner role (migrations and seeds only) bypasses it. The app role `fibrex_app` is NOBYPASSRLS and has no DELETE or TRUNCATE grant anywhere. A missing request context returns no rows (fail closed). | The owner must run data migrations across tenants; the app must never be able to |
| 2026-11-13 | Audit columns (`created_by`, `updated_by`, `deleted_by`) have no foreign key to `iam.user_account` | System jobs write NULL. A foreign key from every table to the user table would block archiving or partitioning users later. Validity is guaranteed by the request context, which comes from an authenticated session. |
| 2026-11-13 | `valid_to` is **inclusive** (the last day a row applies; NULL = open-ended). Overlaps are blocked with `EXCLUDE USING gist (..., daterange(valid_from, valid_to, '[]') WITH &&)` | Matches how staff read dates ("valid to 31 December") |
| 2026-11-13 | Monthly partitions are created by `app.maintain_partitions()` (security definer) for registered parents, 3 months ahead, in a separate `partitions` schema with no DEFAULT partition | Prisma ignores the `partitions` schema, so partitions never show up as drift. A row outside every partition fails loudly instead of hiding in a catch-all. |
| 2026-11-13 | Login names and e-mails are stored lower-case (CHECK constraint) instead of using `citext` | Case-insensitive unique keys that Prisma can describe |
| 2026-11-13 | The Fibrex database uses host port **5433** | This computer already runs a native PostgreSQL 17 service (`postgresql-x64-17`) on 5432. It was left untouched. |
| 2026-11-13 | **Idempotency records live in Redis** (24 h TTL, with an atomic SET NX claim and a 60 s in-progress lock), not in the `integration.idempotency_key` table listed in PLAN 3.8. That table is dropped from the plan. | They are short-lived and checked on every write. Redis gives an atomic claim and expiry for free; nothing about them needs to be kept or reported. |
| 2026-11-13 | Failure policy when Redis is down: **rate limiting fails open** (request allowed, warning logged); **idempotency fails closed** (writes get 503) | A limiter outage should not take the API down. Accepting writes without duplicate protection could post money twice. |
| 2026-11-13 | Rate limit: a fixed-window counter in Redis (one atomic Lua call), 120/min anonymous and 600/min per user or API client, configurable. Health probes are not limited. | One Redis round trip per request; boundary bursts are acceptable for abuse protection. Stricter limits for login/OTP come in commit 7. |
| 2026-11-13 | Errors use RFC 9457 problem details (`application/problem+json`) with a stable `code` (`urn:fibrex:problem:<code>`) and the request id. Unknown errors become a generic 500. | One error shape for the web app (i18n by code) and integrations; no internal detail leaks |
| 2026-11-13 | Idempotency-Key is required on POST/PUT/PATCH/DELETE under `/api/v1`, except `/api/v1/auth/*` (login, refresh and logout are protected differently). A missing key gets 400 `idempotency_key_required`. | SPEC 2.11 |
| 2026-11-13 | OpenAPI 3.1 is generated from Zod schemas with zod-to-openapi. Schemas are named with Zod 4's `.meta({ id })`; Zod is **not** patched with `extendZodWithOpenApi`. Served at `/api/v1/openapi.json`, with Swagger UI at `/api/docs`. | Docs come from the same schemas that validate requests; no global prototype patching |
| 2026-11-13 | The API runs with `tsx` in development (`pnpm --filter @fibrex/api dev`). The production build and Dockerfile come with the compose `api` service later in Phase 1. | Fast reload now; the production packaging decision is made once, with the container |
| 2026-11-13 | OpenTelemetry starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (HTTP, Express, pg; no SQL parameter values). Logs always carry the request id, and the trace and span ids when tracing is on. | No failed export attempts in development or tests; tracing is ready for staging |
| 2026-11-13 | pnpm build scripts: `esbuild` allowed (it installs the platform binary for tsx); `@scarf/scarf` denied (install-time analytics bundled with Swagger UI) | Least privilege at install time |
| 2026-11-13 | **Local object storage: SeaweedFS instead of MinIO** (SPEC 1 says "local MinIO in development") | MinIO no longer publishes free container images (the `minio/minio` Docker Hub repository is gone). The app uses only the S3 protocol through its storage adapter, so this affects local development only and is reversible. |
