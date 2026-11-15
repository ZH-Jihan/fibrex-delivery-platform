# Phase 2 plan: Foundation B

Status: **waiting for approval**. Based on `docs/PLAN.md` sections 3.7 to 3.9 and 5.9 to 5.11, `docs/phases/phase-02.md` and SPEC 2.5, 2.9 to 2.13. Written 2026-11-15.

## 1. How to use this plan

Each row in section 7 is one Claude Code session and one commit. For every row:

1. `/clear`
2. `/model` set to the tier in the row (**S** = strongest: Fable or Opus; **M** = mid: Sonnet; **H** = small: Haiku).
3. Paste, replacing `2.N`:

```
Read CLAUDE.md and docs/PROGRESS.md, then build row 2.N of docs/phases/phase-02-plan.md section 7, following the token budget rules exactly. Read only the PLAN/SPEC sections that row names. Run lint, typecheck and the tests for this row, then the full suite once. Commit as "Phase 2.N: <title>", update PROGRESS.md in one line, and stop.
```

A row marked **split** may be done as `2.Na` and `2.Nb` in two sessions if the first session runs long.

## 2. Scope

From `phase-02.md`: dynamic engines (entity and form builder, lookups, rules and formulas, workflow, state machines, templates, numbering), event outbox and webhooks, public API v1, generic import and export, general ledger and posting service.

Also in this phase, because later phases depend on them:

- The **module registry** promised in `kernel/permissions/catalogue.ts` (SPEC 2.13).
- The **report engine base**, needed for the trial balance (PLAN 5.9 Reports).
- **Rate tables** next to formulas (PLAN 3.7).
- Tables only, no engine yet: automation, semantic layer, service catalogue, dashboards (used in P9 and P11), so later phases add no schema for them.

Not in Phase 2:

- Budgets, fixed assets, close checklist, accounting-software sync (P8).
- Automation engine and semantic-layer report builder UI (P11).
- Service request catalogue screens (P9).
- WhatsApp, SMS, OCR, e-signature adapters (P3, P9).

## 3. Tables created

PLAN 3.7 (`cfg`), 3.8 (`integration`) and 3.9 (`gl`, except the P8 tables). Every table uses `app.setup_table(...)` (RLS, audit trigger, grants without DELETE). Partitioned by month: `integration.outbox_event`, `integration.webhook_delivery`, `gl.journal_line`.

Ledger integrity is enforced in the database, not only in code:

- `journal_line`: CHECK that each line has exactly one of debit or credit, both >= 0.
- Deferred constraint trigger: each journal balances in base currency at commit.
- `journal` and `journal_line` are append-only (no UPDATE, no DELETE for any role).
- Posting into a period whose status is not `open` is refused by a trigger.

## 4. Endpoints

PLAN 5.9 (Engines), 5.10 (Integration) and 5.11 (Ledger), all under `/api/v1`, all through the CRUD factory or the same kernel layers, all in the OpenAPI document. Reports exposed in this phase: `ledger.trial_balance`, `ledger.general_ledger`, `ledger.party_statement`.

## 5. Screens (web)

| Area | Screens |
| --- | --- |
| Settings | Lookups (types and values), Numbering sequences |
| Builder | Entity types (list, fields with drag-to-order, form layout, list columns, publish), generated list/form/detail pages for every published entity |
| Rules | Formulas (versions, test cases, "how was this calculated"), Rate tables |
| Process | State machines (states, transitions), Workflows (steps, bindings), My tasks inbox, workflow timeline on records |
| Documents | Templates (versions, preview PDF) |
| Data | Import wizard (upload, map, preview, commit, rollback), Exports |
| Integration | Webhook subscriptions and delivery log, Event browser, Adapters |
| Finance | Chart of accounts (tree), Cost centres, Tax codes, Exchange rates, Fiscal years and periods, Posting rules (simulate), Journals, Manual journals, Trial balance, General ledger, Party statement, Cash locations, Bank accounts, Bank statements and reconciliation |

All screens follow the responsive patterns from "Web: responsive modern redesign" (cards below 768px).

## 6. "Done when" mapped to tests

| Done when (phase-02.md) | Test |
| --- | --- |
| Admin defines a new record type in the UI and gets list, form, history, import, export and API without code | Playwright: create "Vehicle inspection" type with 5 fields, publish, create/edit/delete/restore a record, see History, import 3 rows from CSV, export, call `/records/vehicle_inspection` |
| Formula created, versioned with an effective date, tested, explains its result | Integration: two versions with different `valid_from`; evaluation by date picks the right one; test cases stored and run; trace lists inputs and steps |
| Three-step approval workflow attached to a custom record type | Integration + Playwright: reviewer, owner, manager; approve, reject, send back, delegate; notifications sent; timeline correct |
| Template with merge fields renders a server-side A4 PDF | Integration: PDF produced, page size A4, merge values present (text extracted), `generated_document` stores template version and data hash |
| Posting a sample event creates a balanced journal through posting rules; unbalanced rejected; closed period refused | Integration: `test.sample_event` posts via rule; a crafted unbalanced entry fails at commit; posting into a closed period fails |
| Trial balance always sums to zero with multi-currency entries | Property-style test: random QAR/BDT/USD postings with rates; trial balance debit = credit in base currency |
| Events written to the outbox in the same transaction and delivered to a signed webhook with retry | Integration: rollback leaves no event; delivery signed (HMAC), failing endpoint retried with backoff, delivery log complete |
| OpenAPI document generated and served | Existing test extended: every Phase 2 route present |
| Tests pass in CI, PROGRESS updated | Local full suite until the GitHub billing lock is cleared (see DECISIONS) |

## 7. Commit sequence

| Row | Title | Tier | Reads | What it builds |
| --- | --- | --- | --- | --- |
| 2.1 | Module registry | S | SPEC 2.13, PLAN 4 | Module manifest (routes, permissions, nav entries, event types, report definitions, settings, recycle-bin and attachable registrations); `main.ts` and `nav.ts` built from registered manifests; existing `party`, `files`, `notify` converted; lint rule still blocks cross-module internals |
| 2.2 | Numbering service | S | PLAN 3.7 (numbering_key), SPEC 2.12 | Per-company sequences with pattern (`L{0000}`, `INV-{YYYY}-{00000}`), gapless under concurrency (row lock), preview, reset rules; settings screen |
| 2.3 | Lookups | M | PLAN 3.7 lookup tables, 5.9 Lookups | `lookup_type`, `lookup_value` (i18n labels, hierarchy, sort, active), cached `GET /lookups/:key`, seed of the types listed in PLAN, admin screen |
| 2.4 | Entity and field definitions | S | PLAN 3.7 entity/field tables, SPEC 2.10 | Definitions with draft/publish and versions; field types; shared JSON-Schema generation and server validation; system entities registered so custom fields work on them; promote-field path documented |
| 2.5 | Custom records API | S | PLAN 3.7 custom_record, record_link, 5.9 Custom records | Generic `/records/:entityKey` CRUD through the CRUD factory, permissions per entity (`custom.<key>.<action>`), numbering, GIN filters, links, audit and recycle bin |
| 2.6 | Builder screens and generated pages | M, split | 2.4, 2.5 | Entity-type builder UI; generic list/form/detail pages rendered from definitions; custom-field section on system entity forms; menu entries for published types |
| 2.7 | Templates and PDF | M | PLAN 3.7 template tables, 5.9 Templates | Handlebars (no helpers that run code), versions per language and company, preview, server-side A4 PDF in a worker, `generated_document`; editor screen with sample data |
| 2.8 | Generic import and export | M, split | PLAN 3.8 import/export, 3.6 raw_input | Upload to `raw_input`, mapping (saved), preview with row errors, commit in a job, rollback (soft delete, audited); bulk export (CSV, Excel); wizard UI usable for any entity including custom |
| 2.9 | Formula engine and rate tables | S | PLAN 3.7 formula/rate tables, 5.9 Formulas, SPEC 2.10 | Sandboxed expression engine (CEL; no `eval`, time and size limits), decimal arithmetic for money, versions with effective dates, test cases, explain trace; rate tables with dimensions and dates, `resolve`; seed client and pay rates; screens |
| 2.10 | State machines | S | PLAN 3.7 state tables, 5.9 State machines | Configurable states and transitions with permission, required fields and reasons; `state_history` with effective date; transition endpoint usable by any entity; config screen |
| 2.11 | Workflow engine | S, split | PLAN 3.7 workflow tables, 5.9 Workflow | Versioned definitions, steps (approval, parallel, condition via formula, notify), quorum, SLA reminders and escalation as jobs, delegation, bindings on create or transition; task inbox and timeline (2.11b UI may run on M) |
| 2.12 | Event outbox and webhooks | S | PLAN 3.8 outbox/webhook tables, 5.10 | Outbox written in the same transaction (unit of work hook), publisher job, `event_consumption` for idempotent consumers, signed webhooks with backoff retry and delivery log; existing notifications moved onto events; admin screens |
| 2.13 | Report engine base | M | PLAN 3.7 report tables, 5.9 Reports | Code-registered definitions synced to the table, run with filters and paging, export CSV/Excel/PDF (via 2.7), saved reports; one generic report page |
| 2.14 | Ledger setup | S | PLAN 3.9 account to fiscal_period, 5.11 | Chart of accounts tree (seeded standard service-company chart, QAR base, editable), cost centres, tax codes (default none), exchange rates, fiscal years and periods with close, lock and reopen (reason, permission) |
| 2.15 | Posting service | S, split | PLAN 3.9 posting_rule, journal, journal_line, manual_journal | Posting rules as versioned data (account resolver, amount formula, dimension mapping); one posting service; database balance and period checks; reversal; multi-currency with base amounts; simulate endpoint; manual journals draft to post |
| 2.16 | Ledger reports and screens | M | 5.11 Reports | Balances and sub-ledger queries by dimension, trial balance, general ledger, party statement, journal screens, chart-of-accounts screens |
| 2.17 | Cash, bank and reconciliation | M | PLAN 3.9 cash to reconciliation_match | Cash locations, company bank accounts (IBAN encrypted), bank statement import (CSV first), match rules, auto and manual matching; may move to Phase 6 if time is short |
| 2.18 | Reserved tables and retention | M | PLAN 3.7 automation, service catalogue, report schedule, dashboard, semantic, retention | Create the remaining `cfg` tables (no engines), retention policies with a dry-run job; adapters config and health table (PLAN 3.8) |
| 2.19 | Phase 2 journeys and wrap-up | M | section 6 of this plan | Playwright journeys for every Done-when row, OpenAPI check, `ADDING_A_MODULE.md` updated for engines, PROGRESS marks Phase 2 done |
| 2.20 | Translations and docs polish | H | i18n files | Draft `bn` labels for all Phase 2 screens, glossary of finance terms; no logic changes |

Totals: 11 rows on S (some split), 8 on M, 1 on H. Expect about 24 sessions with splits.

## 8. Decisions this plan applies (to record in DECISIONS.md in row 2.1)

- **Chart of accounts:** no accountant's list yet; seed a standard service-company chart (QAR base) that admins extend from settings.
- **Expression language:** CEL through a maintained JavaScript implementation chosen in row 2.9 after security tests (sandbox, limits). If none passes, JSONLogic. Money values are decimals, never JavaScript floats.
- **PDF rendering:** headless Chromium in the worker (already used by Playwright), templates in HTML/CSS, A4. A separate rendering container is the fallback if memory use is too high.
- **Fiscal year:** calendar year, January to December, unless the owner says otherwise.
- **CI:** GitHub Actions blocked by a billing issue; run the full suite locally before each commit; no empty commits to trigger CI.

## 9. Questions for the owner

1. Do you have an accountant's chart of accounts, or is the standard seeded chart acceptable for now?
2. Is the fiscal year January to December?
3. The sample three-step workflow in the tests uses reviewer, owner, manager (the loan approval order in SPEC 4.5). Correct?
4. Row 2.17 (bank reconciliation) can move to Phase 6 to reach the people and tracking modules sooner. Keep it here or move it?
