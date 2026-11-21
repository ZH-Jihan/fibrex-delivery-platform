# Phase 4 plan: Performance and tracking

Status: **waiting for approval**. Based on `docs/PLAN.md` sections 3.11, 5.13, `docs/phases/phase-04.md`, SPEC 3.1, 3.3, 5.5, and the real Snoonu sheet saved in `reference/Fibrex Trading Contracting and Services.xlsx`. Written 2026-11-21.

## 1. How to use this plan

Each row in section 7 is one Claude Code session and one commit. For every row:

1. `/clear`
2. `/model` set to the tier in the row (**S** = strongest: Fable or Opus; **M** = mid: Sonnet; **H** = small: Haiku).
3. Run `git log --oneline -1` first and confirm the previous row is committed.
4. Paste, replacing `4.N`:

```
Read CLAUDE.md and docs/PROGRESS.md, then build row 4.N of docs/phases/phase-04-plan.md section 7, following the token budget rules exactly. Read only the PLAN/SPEC sections that row names. Run lint, typecheck and the tests for this row, then the full suite once. Commit as "Phase 4.N: <title>" with no AI attribution lines (see CLAUDE.md), update PROGRESS.md in one line, and stop.
```

A row marked **split** may be done as `4.Na` and `4.Nb` in two sessions if the first runs long.

## 2. What the real Snoonu sheet looks like

The owner's Google account has **viewer** access to a Snoonu-owned workbook. Its first tab, `Daily Report`, is itself an `IMPORTRANGE` from a master Snoonu workbook, so Snoonu controls its layout. Read from the saved copy:

- **Header rows:** row 1 and 2 hold totals (Total Rider, Total Driver, Total Active, Total Inactive, average late login) and block titles. **Row 3 is the column header row.** Data starts at row 4, one row per person.
- **Fixed columns A to M:** Public ID (this is the Falcon ID and the match key), Name, Company, Day OFF, Schedule (for example `14:00-02:00`, sometimes `NA`), Break start, Break End, Zone, Contact Number, Driver / Rider, Plate Number, Skill, Tags.
- **Columns N and O:** Pending Amount and Balance Amount (running figures; kept as metrics, meaning confirmed with the owner before use).
- **Day blocks from column P:** one block of **7 columns per day of the month**, titled in row 1 "1st of the month", "2nd of the month" and so on up to the 31st: Assigned, Delivered, Acceptance Rate, Working Hours (decimal hours), Late Log In By Min, Kms, AVG KM per Order. The block title has **no month name**. Owner answer (2026-11-21): **Snoonu's month runs from the 26th to the 25th**, but the day blocks are **titled by calendar day of the month**: block "26th of the month" is the first day of the cycle, then 27th to 31st, then 1st to 25th. Each block means the date with that day number inside the current cycle (cycle 26 Oct to 25 Nov: block 26 is 26 Oct, block 1 is 1 Nov). Blocks for days that do not exist (for example the 31st in a 30-day month) stay empty. The sheet runs **one day behind**: on the morning of a date it shows data up to the day before. When a cycle ends, the sheet resets and **every daily value becomes 0**, and the new cycle's first day (the 26th) only shows real figures on the 27th. Checked against the saved copy: blocks 26 to 31 and 1 to 19 hold figures, blocks 20 to 25 are 0, which matches a download taken on 20 November.
- **Right side:** Inactive count and average late login by minutes.
- Other tabs: `FDB Report` (Falcon ID, agent name, type, account status, employment status, documents status, sponsorship, secondment, and expiry dates for QID, passport, Istimara, driving licence, insurance, food handling, health card), `Payout_<Mon><YY>` (the monthly payout sheet: online orders, rates 15 driver and 11 rider, allowances, bonuses, COD, final payout), `Penalties_<Mon><YY>`, `Merchandise Report`. Phase 7 and 8 will read the payout and penalty tabs through the same adapter.

The owner asked for the morning call sheet to show, from this sheet, **how many orders each person did the previous day and how many hours they were active.** These are **Delivered** and **Working Hours** of yesterday's block.

## 3. Scope

Client report adapter with a Snoonu implementation, scheduled and manual sync with idempotent re-import and run history, unmatched-person queue, daily and monthly performance reports with a summary email, daily tracking page (morning call sheet), status history, ID-operator tracking, and the Active versus orders cross-check.

Reused, not rebuilt: party and identifiers (Falcon ID is a `party_identifier`), employees and status state machine (Phase 3), jobs and scheduler, raw_input, report engine, notify and email, import wizard, SecretBox encryption, module registry.

Not in Phase 4:

- Payroll from the payout tab, penalties import, platform margin (Phases 7 and 8). `performance.platform_margin` is registered but stays empty until rates exist.
- WhatsApp and SMS sending (Phase 9). The call sheet only has click-to-call and WhatsApp links.
- Worker check-in app (`worker_checkin`, Phase 9).
- Keeta and Talabat adapters. The interface is built so they can be added.

## 4. Tables created

PLAN 3.11, schema `performance` and `tracking`. Each uses `app.setup_table(...)` (RLS, audit trigger, no DELETE grant). `daily_performance` is partitioned by month.

| Table | Notes |
| --- | --- |
| `client_platform` | Snoonu seeded (organisation party, code `snoonu`, adapter `sheet`, `cycle_start_day` = 26) |
| `sync_source` | spreadsheet id and tab in `config_encrypted`, cron `0 4 * * *`, Asia/Qatar |
| `column_mapping` | versioned sheet header to field map with aliases, so a renamed column is a mapping change, not code |
| `metric_definition` | seeded: assigned, delivered, acceptance_rate, working_hours, late_minutes, kms, avg_km_per_order |
| `sync_run`, `sync_run_error` | run log, `layout_changed`, `raw_input_id` snapshot |
| `daily_performance` | `orders_completed` = Delivered, `working_minutes` = Working Hours x 60, `late_minutes`, everything else in `metrics`, `is_current` flag |
| `unmatched_identifier` | Falcon IDs in the sheet with no person |
| `tracking_entry`, `id_operator_period`, `call_log` | dated history, never overwritten |

Rules enforced in the database:

- One current `daily_performance` row per person per platform per date (partial unique index on `is_current`).
- `id_operator_period`: exclusion constraint, one operator per identifier at a time.
- `tracking_entry` for Inactive, Blocked or Terminated needs a reason (check constraint).
- The same raw snapshot hash for the same date is stored once.

## 5. Endpoints

PLAN 5.13 under `/api/v1`, all in OpenAPI: platforms, sync sources, column mappings, test (reads headers only), run now, reimport range, sync runs with errors and raw snapshot, unmatched identifiers (link, create employee, ignore), metric definitions, `GET /performance/person/:partyId`, tracking (list with summary strip, status, operator, calls, history, cross-check), and an Excel-upload route for a day's file. Reports: `performance.daily`, `performance.monthly`, `performance.platform_margin`.

## 6. Screens (web)

| Area | Screens |
| --- | --- |
| Performance | Platforms, Sync sources (mapping editor, "test headers"), Sync runs (list, detail, errors, snapshot), Unmatched riders queue, Daily report, Monthly report, Upload a day's Excel |
| Tracking | **Morning call sheet**: one row per person with name, Falcon ID, zone, driver or rider, phone with call and WhatsApp links, **yesterday's orders and active hours**, status dropdown, who is working the ID, call outcome and note, summary strip, filters, past dates, cross-check flags |
| Employee profile | Performance tab (daily rows and monthly totals), Status history in the History tab |

Responsive rules from Phase 1 apply. All labels via i18n, Bangla drafts in the last row.

## 7. "Done when" mapped to tests

| Done when (phase-04.md) | Test |
| --- | --- |
| Importer passes fixture tests, including a renamed-column case; raw snapshot stored every run | Unit and integration with a fixture workbook built to the real layout (fake names and IDs): normal run; **cycle mapping** (block N maps to the date with day number N inside the cycle that contains the run date; cycle 26 Oct to 25 Nov: block 26 is 26 Oct, block 1 is 1 Nov; a run on the 27th stores the 26th; the 31st block in a 30-day month stays empty); **reset guard** (a sheet whose daily values are all 0 never overwrites stored real figures and raises a warning); "Delivered" renamed to "Orders Delivered" mapped by alias; unknown column kept in metrics; snapshot row in `raw_input` |
| Re-running a date is idempotent; failures alert admins; Run now and Re-import range work | Integration: run twice, one current row; reimport range flips old rows to not current and keeps them; unreachable and empty and layout-changed cases raise an admin alert |
| Daily and monthly reports match hand-calculated figures | Integration: fixture with known totals; daily and monthly report numbers equal a hand-computed table in the test |
| Tracking page saves status, reason, date and ID-operator details inline, keeps dated history | Integration and Playwright: change status, reason required, history shows both rows; operator period saved, overlapping period refused |
| Cross-check flags Active with no orders and Inactive with orders | Integration with fixture |
| Tests pass, PROGRESS updated | Local full suite until the GitHub billing lock is cleared |

## 8. Commit sequence

| Row | Title | Tier | Reads | What it builds |
| --- | --- | --- | --- | --- |
| 4.1 | Performance schema and platforms | S | PLAN 3.11, 3.6 raw_input | Migration for all tables in section 4 (partitioned `daily_performance`, constraints above), Snoonu platform and metric definitions seeded, module manifest, permissions `performance.*` and `tracking.*`, RLS and audit tests |
| 4.2 | Snoonu sheet parser | S | SPEC 3.1, section 2 of this plan | `ClientReportAdapter` interface; Snoonu parser for the wide Daily Report layout (header row 3, 7-column day blocks; block-to-date mapping from the platform's cycle start day 26 and the block's day-of-month title; a block counts as filled only if it has non-zero values; month-reset detection and unexpected-layout detection); aliases through `column_mapping`; fixture workbook with fake people; Excel-file and in-memory sources only |
| 4.3 | Sync engine and Excel upload | S | PLAN 3.11, 5.13 | Run service: for each run it stores the snapshot, then stores every filled day block it finds (so a missed day is caught up the next morning), never replacing real figures with a reset sheet; snapshot to `raw_input`, normalise, match Falcon ID to party identifier, unmatched queue, idempotent re-run with `is_current`, retries, admin alerts, run now, reimport range, upload a day's Excel; 04:00 Asia/Qatar scheduled job (reads from the configured source) |
| 4.4 | Google Sheets reader | S | SPEC 3.1, adapter_config | Read-only Google Sheets reader behind the adapter interface; OAuth consent flow for the owner's Google account with the refresh token sealed by SecretBox; reads headers only for "test"; clear errors when access is revoked; works against recorded responses in tests. **Owner steps are guided live in this row.** |
| 4.4b | Service-account auth for the Google reader | S | adapter_config, DECISIONS 4.4 | Owner decision: an unpublished OAuth app loses its grant every 7 days, so the primary route is a mirror Google Sheet owned by the owner (`=IMPORTRANGE` of Snoonu's Daily Report, tab `Daily Report`) shared as Viewer with a Google service account. Sync source auth mode `service_account` (default for new sources) next to `oauth`; key read from `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`, never stored, logged or returned, redacted in errors; RS256 JWT with only `spreadsheets.readonly`, token cached until shortly before expiry; 401, invalid_grant, 403 (names the service account email to share with), 404, 429 handled as in 4.4; same IMPORTRANGE unreadable rule; settings page shows the mode, the service account email and Test headers; `docs/GOOGLE_SETUP.md` leads with the mirror-sheet route, OAuth moved to an alternative section; tests with a throwaway RSA key and fake Google answers |
| 4.5 | Sync screens | M, split | 4.2 to 4.4 | Platforms, Sync sources with mapping editor and test, Runs list and detail, Unmatched riders queue (link, create employee, ignore), Upload a day's Excel, Run now and Re-import buttons |
| 4.6 | Performance reports | M, split | SPEC 3.1 reports, 5.9 Reports | `performance.daily` and `performance.monthly` through the report engine (the "month" is Snoonu's cycle, 26th to 25th, not the calendar month; a calendar-month view is optional) (orders, active hours, late, acceptance, kms; absentees, top and bottom performers, zone and driver-versus-rider breakdown, previous-day comparison, trend), per-person performance, summary email after the 04:00 run to an admin-editable recipient list (default: fibrextrading@gmail.com only) |
| 4.7 | Tracking tables and API | S | SPEC 3.3, PLAN 3.11 | Status changes recorded in `tracking_entry` and applied to the employee status state machine, reasons, effective dates, operator periods, call log, history, cross-check, `GET /tracking?date=` with the summary strip (the call sheet lists only employees who currently have a rider or driver placement; office staff and others without a Falcon ID are not on it), permissions and tests |
| 4.8 | Morning call sheet screen | M, split | SPEC 3.3 | The page described in section 6: inline saves with no reload, yesterday's orders and active hours, click-to-call and WhatsApp links, filters, date picker, cross-check flags |
| 4.9 | Snoonu FDB report check | M | section 2, Phase 3 documents | Read the `FDB Report` tab through the same adapter and show differences against our employee documents and expiry dates (QID, passport, licence, insurance, health card, food handling) for staff to review; no automatic overwrite |
| 4.10 | Phase 4 journeys and wrap-up | M | section 7 | Playwright journeys for each Done-when row, OpenAPI check, PROGRESS marks Phase 4 done |
| 4.11 | Translations and docs polish | H | i18n files | Draft `bn` labels, glossary additions (Falcon ID, Assigned, Delivered, Acceptance rate, Working hours, Late login, Cross-check, Unmatched) |

Totals: 5 rows on S, 5 on M, 1 on H. Expect about 14 sessions with splits.

Cost note: 4.2, 4.3, 4.4 and 4.7 carry the data correctness and credentials, so they stay on S. Screens and reports are ordinary work for M.

## 9. Decisions this plan applies (to record in DECISIONS.md in row 4.1)

- **Match key:** the sheet's Public ID is the Falcon ID and matches `party_identifier` of type `falcon_id`.
- **Orders:** `orders_completed` is the **Delivered** column, not Assigned. **Active hours** is the **Working Hours** column (hours, stored as minutes). Late minutes use Snoonu's own "Late Log In By Min".
- **Snoonu cycle:** the performance month runs 26th to 25th (`cycle_start_day` = 26 on the platform). A daily block titled with day N maps to the date with day number N inside the current cycle. The sheet is one day behind and resets to zeros at the cycle start, so a run never overwrites real stored figures with zeros.
- **Pending Amount:** money riders have spent or collected that Snoonu will take back from them (unpaid COD side). Kept as a metric; Balance Amount is kept but not used.
- **Never write to the sheet.** Read-only scope only.
- **Google access:** the account that already has viewer access (fibrextrading@gmail.com) gives read-only OAuth consent once. If access is ever lost, the day's Excel upload works as the fallback. A Snoonu-granted service account is the later, steadier option.
- **Raw first:** every run keeps its raw snapshot; unknown columns stay in `metrics`.
- **No real data in the repo:** the fixture uses fake names and IDs in the real layout; `reference/` stays out of git.

## 10. Questions for the owner

1. ~~Month change~~ answered: cycle 26th to 25th; sheet one day behind; resets to zeros at the cycle start (see section 2).
2. ~~Hours and orders~~ answered yes: Working Hours = active hours, Delivered = orders.
3. ~~Summary email~~ answered: fibrextrading@gmail.com only.
4. ~~Google consent~~ answered yes (guided live in row 4.4).
5. ~~Pending and Balance~~ answered: Pending = money Snoonu will take back from riders; Balance not used.
6. **Still to observe (owner, 3 minutes):** the next cycle change is **25 to 27 November**. Please open the sheet on the evening of the 25th, the morning of the 26th and the morning of the 27th, and note for each: does the 25th's figure survive on the 26th, and when does the 26th's figure first appear? Or download the Excel on those three days into `reference/`. This confirms the timing the importer relies on.
