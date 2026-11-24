# Phase 5 plan: Inventory and fleet

Status: **waiting for approval**. Based on `docs/phases/phase-05.md`, SPEC 3.4, 4.1 and 5.16 (incidents and violations only), PLAN 3.12, 3.13, 5.14, 5.15, `docs/DECISIONS.md`, and what Phases 1 to 4 built. Written 2026-11-24.

## 1. How to use this plan

Each row in section 9 is one Claude Code session and one commit. For every row:

1. `/clear`
2. `/model` set to the tier in the row (**S** = strongest: Fable or Opus; **M** = mid: Sonnet; **H** = small: Haiku).
3. Run `git log --oneline -1` first and confirm the previous row is committed.
4. Paste, replacing `5.N`:

```
Read CLAUDE.md and docs/PROGRESS.md, then build row 5.N of docs/phases/phase-05-plan.md section 9, following the token budget rules exactly. Read only the PLAN/SPEC sections that row names. Run lint, typecheck and the tests for this row, then the full suite once. Commit as "Phase 5.N: <title>" with no AI attribution lines (see CLAUDE.md), update PROGRESS.md in one line, and stop.
```

A row marked **split** may be done as `5.Na` and `5.Nb` in two sessions if the first runs long.

## 2. What Phase 5 gives the owner (plain words)

- **Merchandise:** one list of every item Snoonu gives you (T-shirts, bags, helmets, boxes ...) with sizes. You record what Snoonu delivered, what you hand to each rider, what comes back, what is lost or damaged, and what you return to Snoonu. The system counts the office stock for you; nobody types a stock number. Handing items to a rider prints a **handover slip** for signature, and the signed copy is kept on file.
- **Reconciliation:** one page answers "Snoonu gave us 120 helmets; where are they?" (office + with riders + lost or damaged + returned) and highlights any gap. A rider's profile shows exactly what they hold, which you need when they leave.
- **Fines for lost items:** if a rider loses an item and you charge them, the charge goes into a **pending deductions** list that payroll (Phase 7) will pick up. Nothing is taken from salary automatically without a person approving it.
- **Fleet:** one register of bikes and cars with plate, owner, Istimara and insurance dates and documents. Each vehicle shows **who has it today and since when**; giving it to someone else closes the previous person's period automatically. The rider's profile shows their current vehicle and plate.
- **Expiry alerts:** Istimara and insurance expiry use the same alert emails as QID and passport (14 and 7 days before).
- **Rent and service charges:** "Generate this month's dues" creates the rent lines for every active vehicle from its agreed terms, with **who it is paid to**. You record payments with receipts, and reports show what is outstanding by month, vehicle and payee. Rent and payments go into the accounts automatically.
- **Traffic fines and accidents:** a fine is entered (or imported) with its date; the system finds who held the vehicle that day. You can dispute it, mark it paid, and send it to pending deductions. Accidents are recorded with photos, police report, insurance claim, repair cost and any recovery from the worker.
- **Snoonu FDB check finished:** the Istimara date in Snoonu's FDB tab is now compared with the vehicle the rider holds, the sheet's plate is compared with the assigned vehicle, and the check runs by itself after the morning sync.

## 3. What Phases 1 to 4 already give us

| Built | Where | How Phase 5 uses it |
| --- | --- | --- |
| Party model, roles, identifiers, `PartyReferenceRegistry`, `AttachableRegistry` | Phase 1, row 8 | Holders, payees, workshops, vehicle owners and incident third parties are parties; every new `party_id` column is registered so a merge moves it; vehicles, slips, violations and incidents register as attachable types |
| Employees, status state machine, **placements** (effective-dated, one per day, profession and client platform) | Phase 3 | Issue and assign screens list employees; a vehicle assignment checks the person is an employee on that date; leaving (terminated) shows what they still hold |
| **Documents** with `owner_type` `party`, `vehicle`, `company` already allowed in the SQL; Istimara type seeded (code `istimara`) but not offered for people (Phase 3 open item) | Phase 3, row 3.2 | Vehicle documents (Istimara, insurance, photos) are `people.document` rows with `owner_type = 'vehicle'`; no new document table |
| **Expiry alert engine** (`expiry-service.ts`, `GET /documents/expiring?ownerType=`, 14 and 7 days, `expiry_alert_log`) | Phase 3 | Vehicle documents are picked up by the same job; Phase 5 only makes the email and list name the vehicle and its current holder |
| Templates, PDF worker, `generated_document`, numbering sequences | Phase 2 | Handover slip PDF and numbers; incident numbers |
| Ledger, `PostingService` (rules per event key, reversal), cash locations, seeded standard chart; `journal_line` already has a `vehicle_id` dimension | Phase 2 | Rent accrual, rent payments, fines paid, maintenance cost |
| Event outbox, notifications, report engine, import wizard, recycle bin, audit | Phases 1 and 2 | Low-stock and service-due alerts, reports, vehicle and violation imports |
| **Plate number:** kept only on the unmatched-ID queue row and in the call sheet's sheet details (parsed from the stored sync row). **No home on the employee.** | Phase 4, rows 4.5b and 4.8c | The plate now lives on `fleet.vehicle`; the employee's plate is "the plate of the vehicle they hold today". The sheet's plate becomes a cross-check, not a store |
| **FDB check** reads Istimara expiry per Falcon ID **but does not compare it**; runs only when staff press Run or upload a copy | Phase 4, rows 4.9 and 4.9b | Row 5.14 compares it to the Istimara of the vehicle the person holds, and schedules the check |
| Not built in Phase 4: a **"date only" pill** on the employee documents tab (documents created from the FDB tab with `source = snoonu_fdb` and no file) | Phase 4, row 4.9b | Row 5.9 builds the documents tab for vehicles from the same component, so the pill is added there for both |

Not in Phase 5:

- Payroll itself (Phase 7). Phase 5 only fills the pending deductions list.
- Rates, charges, company-borne costs and SIMs (Phase 6, SPEC 4.2), even though "vehicle rent" is also an expense type there.
- Leave, disciplinary records and letters from SPEC 5.16 (Phase 10).
- Reading Snoonu's `Merchandise Report` tab automatically (see decision D9).
- GPS and telematics (Phase 11).

## 4. Tables and relations

All tables use `app.setup_table(...)` (RLS, audit trigger, no DELETE grant), standard columns per PLAN 2.1, money as `NUMERIC(18,4)` plus currency. Tag **A** means insert-only: the app role has no UPDATE or DELETE, corrections are reversal rows.

### 4.1 Schema `payroll` (only the inbound queue, created early)

| Table | Tag | Key columns | Notes |
| --- | --- | --- | --- |
| `suggested_deduction` | S | party_id, source_module, source_type, source_id, pay_component_key, amount (money), target_period (YYYY-MM, null = next run), status (pending, applied, waived), payslip_line_id (null until Phase 7), waive_reason | PLAN 3.16. Unique (source_type, source_id) among live rows, so a source makes at most one suggestion. Phase 5 only writes `pending` and lets staff `waive` with a reason; Phase 7 applies it |

### 4.2 Schema `inventory` (PLAN 3.12)

| Table | Tag | Key columns | Notes |
| --- | --- | --- | --- |
| `item` | S | code, name JSONB, category (lookup `merchandise_category`), has_sizes, unit, low_stock_threshold, default_loss_fine (money), active | Seeded: T-shirt, pants, thermal bag, helmet, chest guard, gloves, safety guard, delivery box, vest, jacket |
| `item_variant` | S | item_id, size_code (null when no sizes), sku | Exactly one variant with no size when `has_sizes` is false |
| `stock_location` | S+B | name, kind (office, warehouse), active | One "Main office" seeded |
| `stock_movement` | **A** | number, movement_date, type, item_variant_id, quantity (signed), location_id, holder_party_id, client_platform_id, handover_slip_id, reference, note, reversal_of_id | The only source of stock. See rules below |
| `handover_slip` | S | number, party_id, issue_date, kind (issue, return), generated_document_id, signed_file_id, status (generated, signed) | One slip groups the lines of one issue or return |
| `loss_record` | S | stock_movement_id, party_id, fine_charged, fine (money), deduct_from_salary, suggested_deduction_id | One per lost or damaged movement that is charged to a person |

Stock rules (enforced in the service under a lock per variant and location, and checked again by tests):

1. **Stock is never stored.** Office stock per variant and location = sum of `quantity` of live (not reversed) movements at that location. A person's holding per variant = issued minus returned minus lost or damaged while held.
2. **Sign per type** (CHECK constraint): received from client `+`; issued `-` at the location and `+` to the holder; returned by employee `+`; lost or damaged from office `-`; lost or damaged while held reduces the holding only; returned to client `-`; adjustment `+` or `-` with a required note.
3. **No negative stock:** an issue, loss from office, or return to Snoonu larger than the office stock is refused. A return or a loss "while held" larger than what the person holds is refused.
4. **Reversal only:** a wrong movement is undone by a reversal row (`reversal_of_id`, opposite sign, reason required); a movement is reversed at most once; a reversal that would make stock negative is refused. A reversed loss waives its pending deduction.
5. **Holder is an employee** of the company on the movement date (checked through `PartyService` and the employee record).

### 4.3 Schema `fleet` (PLAN 3.13)

| Table | Tag | Key columns | Notes |
| --- | --- | --- | --- |
| `vehicle` | S+B | vehicle_type (bike, car), make, model, year, colour, plate_number, chassis_number, owner_kind (company, third_party, worker), owner_party_id, status (in_use, idle, in_workshop, sold_or_returned), custom_fields | Plate and chassis unique among live vehicles of the company (normalised: upper case, no spaces). Documents are `people.document` with `owner_type = 'vehicle'` |
| `vehicle_terms` | S | vehicle_id, valid_from, valid_to, rent (money), service_charge (money), payee_party_id, due_day (1..28), charge_to_worker (money, nullable), terms_note | Effective-dated, exclusion constraint: no overlap per vehicle. A change of terms closes the old row and starts a new one, so past months keep their terms |
| `vehicle_assignment` | S | vehicle_id, party_id, from_date, to_date, return_note, odometer_out_km, odometer_in_km | See assignment rules below |
| `maintenance_log` | S | vehicle_id, date, odometer_km, work_done, cost (money), workshop_party_id, next_due_date, next_due_km, paid_from_cash_location_id, journal_id | |
| `vehicle_due` | S | vehicle_id, period (YYYY-MM), kind (rent, service_charge), amount (money), payee_party_id, due_date, vehicle_terms_id, journal_id | Unique (vehicle, period, kind) among live rows. Status (due, partial, paid) is **derived** from payments, never stored |
| `vehicle_due_payment` | **A** | vehicle_due_id, paid_on, amount (money), method_id, reference, receipt_file_id, cash_location_id, journal_id, reversal_of_id | Corrections by reversal; total paid can never exceed the due |
| `traffic_violation` | S | vehicle_id, violation_at, reference_no, authority, description, amount (money), attributed_party_id, attribution (auto, manual), attribution_note, dispute_status (none, disputed, upheld, cancelled), paid_status (unpaid, paid), deduct_from_salary, suggested_deduction_id, journal_id | Reference number unique per authority among live rows, so an import cannot double a fine |
| `incident` | S+B | number, occurred_at, place, geo, vehicle_id, description, police_report_file_id, insurance_claim_status, repair_cost (money), liability_decision (company, worker, third_party, shared, pending), recovery (money), suggested_deduction_id | Photos through `AttachableRegistry` |
| `incident_party` | S | incident_id, party_id, role (driver, third_party, witness) | |

Assignment rules (the part that must be right, row 5.8 on S):

1. **One holder per vehicle per day:** exclusion constraint on `(vehicle_id, daterange(from_date, to_date, '[]'))` among live rows. `to_date` null means "still holding".
2. **One vehicle per person per day** (exclusion constraint on `party_id`), unless the owner answers question 4 differently.
3. **Reassigning closes the previous period automatically:** assigning vehicle V to B from date D sets the open period of A to D - 1 in the same transaction. D cannot be on or before A's `from_date` (that would erase A's period; staff must correct A's period first).
4. **Back-dating is allowed** only into a gap: a period that would overlap a closed period of the vehicle or of the person is refused with the clashing period named.
5. **Return (unassign)** sets `to_date` and optional odometer and note; the vehicle becomes `idle`. Status `in_use` and `idle` follow assignments; `in_workshop` and `sold_or_returned` are set by staff; a sold or returned vehicle cannot be assigned, and selling it requires that it is not assigned.
6. **Holder on a date** (`GET /vehicles/:id/holder?at=`) is the single source for violation attribution, the employee's current plate and the FDB Istimara comparison.
7. **Corrections:** a period's dates may be edited only while no violation or incident is attributed inside the days being removed; otherwise the edit is refused and staff re-attribute first. A wrongly created period is removed with the recycle bin (soft delete with a reason) under the same check. Every change is in the audit trail.
8. **Leaving:** when an employee moves to terminated, the status change shows the vehicle and items they still hold (exit clearance uses the same holdings call in Phase 10). It does not block the move.

Deductions and damage charges (SPEC 3.4, 4.1, 5.16):

- **Lost or damaged item** charged to a person: `loss_record` with fine and "deduct from salary" -> one `suggested_deduction` (`pay_component_key` `merchandise_fine`).
- **Traffic fine** with "deduct from salary" -> one `suggested_deduction` (`traffic_fine`) for the attributed person; re-attributing moves the pending suggestion to the new person; a fine that is disputed and cancelled waives it; a suggestion already applied by payroll cannot be moved or waived from here.
- **Incident** with liability worker or shared and a recovery amount -> one `suggested_deduction` (`incident_recovery`).
- **Vehicle rent charged to the worker** (`vehicle_terms.charge_to_worker`) is **not** created in Phase 5: it is a monthly rate and belongs to Phase 6 commercial profiles and Phase 7 payroll (DECISIONS #18 still open, question 2).

What stays retire-only (never deleted, never edited after the fact):

- `stock_movement` and `vehicle_due_payment` are insert-only; mistakes are reversal rows.
- `item`, `item_variant`, `stock_location`: retired (`active = false`), not deleted, once any movement uses them.
- `vehicle`: retired by status `sold_or_returned`; its assignments, dues, documents and fines stay.
- `vehicle_assignment`: closed, not deleted (rule 7 for corrections).
- `vehicle_terms`: closed with `valid_to`, never rewritten for a month that has dues.
- `vehicle_due`: a generated due with a payment cannot be removed; a due with no payment may be voided (soft delete with reason), which reverses its accrual journal.
- Journals: posted entries are immutable; corrections are reversals (SPEC 2.9).
- Handover slips: the generated PDF is insert-only; a new signed copy replaces the link to the old one, the old file stays.

Ledger postings (rules seeded per company through the posting service; accounts from the standard chart, editable as data):

| Event key | When | Debit | Credit |
| --- | --- | --- | --- |
| `fleet.due_accrued` | A due is generated | Vehicle rent expense or Vehicle service charge expense (vehicle dimension) | Accounts payable, payee party |
| `fleet.due_paid` | A payment is recorded | Accounts payable, payee party | Cash or bank (cash location) |
| `fleet.violation_paid` | A fine is marked paid | Recoverable from employees (person) when "deduct from salary", else Traffic fines expense | Cash or bank |
| `fleet.maintenance_paid` | A maintenance cost is recorded as paid | Vehicle repairs and maintenance expense (vehicle dimension) | Cash or bank |

Reversing a payment, voiding a due or reversing a fine payment posts the reversal journal. Inventory movements post nothing: the equipment belongs to Snoonu and has no cost on our books.

## 5. Endpoints

PLAN 5.14 and 5.15 under `/api/v1`, all in OpenAPI, with these additions:

- `GET /suggested-deductions?partyId=&status=`, `POST /suggested-deductions/:id/waive`.
- `GET /employees/:id/holdings` (items held plus current vehicle), used by the profile and later by exit clearance.
- `POST /stock/opening-balance` (one-time, per location, dated go-live; refused once any other movement exists for that variant and location).
- Imports registered on the existing wizard: vehicles, opening stock, opening assignments, traffic violations.

## 6. Screens, reports and alerts

| Area | Screens |
| --- | --- |
| Merchandise | Item catalogue with sizes; **Receive from Snoonu**; **Issue** (pick employee, items, sizes, quantities, date; prints the handover slip); **Return** (shows what the person holds); **Lost or damaged** (with fine and "deduct from salary"); **Return to Snoonu**; Adjustment; Movements (filter, reverse); Handover slips (download, upload signed copy) |
| Merchandise report | **Reconciliation summary at the top**: per item, received from Snoonu versus office stock + with employees + lost or damaged + returned to Snoonu, difference highlighted; then office stock with low-stock warnings, **who holds what**, movement history, per-employee holdings |
| Fleet | Vehicle register (list shows **current user and "using since"**, plate, type, status, Istimara and insurance expiry); vehicle detail with tabs: Details, Terms, Assignments, Documents (with the date-only pill), Maintenance, Dues, Fines, Incidents; Assign and Return dialogs |
| Rent and charges | Dues list per month with **Generate this month's dues**, record payment (receipt upload), reverse payment; reports by month, by vehicle, by payee with outstanding totals |
| Fines and incidents | Traffic fines list (import, attributed person, re-attribute, dispute, mark paid, deduct); Incidents list and form (people involved, photos, police report, insurance claim, repair cost, liability, recovery) |
| Pending deductions | One list of suggestions from all sources, filter by person and status, waive with reason (payroll applies them in Phase 7) |
| Employee profile | **Vehicle and plate today** in the header details; Holdings tab (items and vehicle); Deductions tab (pending suggestions) |
| Performance | FDB check gains "Istimara differs" and "Plate differs"; run history shows scheduled runs |

Reports (report engine): `inventory.reconciliation`, `inventory.low_stock`, `inventory.holdings`, `fleet.current_holders`, `fleet.dues_by_month`, `fleet.dues_by_vehicle`, `fleet.dues_by_payee`, `fleet.violations`, `fleet.maintenance_due`.

Alerts (existing notification rules and expiry engine):

- **Istimara and insurance expiry** for vehicles: same job, same 14 and 7 day emails, the email names plate and current holder; the Expiring documents report filters by owner type.
- **Low stock:** once when office stock of an item falls to or below its threshold (not again until it rises above).
- **Service due:** maintenance next due date reached or within 7 days (odometer-based due is shown on the vehicle and in `fleet.maintenance_due`; there is no live odometer feed).
- **Rent overdue:** daily, dues past their due date and not fully paid, to fleet admins.

Responsive rules from Phase 1 apply. All labels through i18n; drafts for bn, hi, ne, ur in the last row.

## 7. Phase 4 follow-ups folded into Phase 5

| Follow-up | Fold in? | Where | Why |
| --- | --- | --- | --- |
| Plate field on the employee | **Yes, as derived** | 5.8 and 5.9 | A plate belongs to a vehicle. The employee shows the plate of the vehicle they hold today; history comes from assignments. Typing a plate on the employee would create a second copy that goes stale |
| Istimara comparison in the FDB check | **Yes** | 5.14 | Needs vehicles and assignments, which only exist after 5.8 |
| "Date only" pill on the documents tab | **Yes** | 5.9 | The vehicle Documents tab reuses the same component; one small change covers both |
| Scheduled FDB check | **Yes** | 5.14 | Tiny once the comparison is touched; runs after the 04:00 sync from the same source, so differences are ready for the morning |

## 8. "Done when" mapped to tests

| Done when (phase-05.md plus this plan) | Test |
| --- | --- |
| Stock is derived from the movement ledger; issue produces a printable handover slip | Unit: stock and holding sums, sign rules, negative stock and over-return refused, reversal; integration: issue -> slip PDF generated, signed copy uploaded; no stock column exists |
| Reconciliation shows received versus accounted for per item with differences | Integration: fixture with known movements, report equals a hand-computed table including a deliberate gap |
| Reassigning a vehicle closes the previous assignment | Integration: assign A then B from D, A ends D - 1; overlap refused (vehicle and person); back-dating into a gap allowed; correction refused when a fine sits in the removed days |
| Generate this month's dues creates rent entries with payee | Integration: twice for the same month creates nothing new; terms changed mid-year keep old months; sold vehicle skipped; accrual journal balanced |
| A traffic violation is attributed to the holder on that date | Unit and integration: date inside, on the boundary days, in a gap (unattributed, flagged), re-attribution moves the pending deduction |
| Rent payments and fines post to the ledger | Integration: payment, partial payment, over-payment refused, reversal; fine paid with and without deduction posts to the right account; journals balanced and immutable |
| Lost item, fine and incident recovery create pending deductions | Integration: one suggestion per source; reversal or cancellation waives it |
| Vehicle Istimara and insurance alerts | Integration: vehicle document 14 days out produces one alert naming plate and holder; second run sends nothing |
| FDB Istimara and plate differences; scheduled check | Integration with the Phase 4 FDB fixture extended with Istimara and plate values |
| Main journeys | Playwright: receive, issue with slip, return, reconciliation; add vehicle, assign, reassign, generate dues, pay; enter fine and see the holder |
| Tests pass in CI, PROGRESS updated | Full suite (local until the GitHub billing lock is cleared) |

## 9. Commit sequence

| Row | Title | Tier | Reads | What it builds |
| --- | --- | --- | --- | --- |
| 5.1 | Pending deductions queue | S | PLAN 3.16 `suggested_deduction`, this plan 4.1 | Migration for `payroll.suggested_deduction` (unique live source, status rules), `DeductionSuggestionService` (`suggest`, `move`, `waive`; applied rows frozen by trigger), events, permissions `payroll.suggested_deduction.*`, routes list and waive, RLS and audit tests. Record D1 to D10 in DECISIONS.md |
| 5.2 | Inventory schema and catalogue | S | PLAN 3.12, this plan 4.2 | Migration for all inventory tables (insert-only `stock_movement` with sign CHECK and single reversal), seeded items and Main office, module manifest, permissions `inventory.*`, `PartyReferenceRegistry` and `AttachableRegistry` entries, item and location CRUD routes, RLS and audit tests |
| 5.3 | Stock movement service | S | this plan 4.2 rules | `StockService`: receipt, issue, return, loss, damage, return to client, adjustment, opening balance, reversal; lock per variant and location; derived stock and holdings queries; loss with fine creates the suggestion (5.1); routes `/stock*`; unit tests for every rule |
| 5.4 | Handover slips | M | PLAN 3.12, Phase 2 templates | Slip numbering (`HS{00000}` unless the owner gives a format), English template with signature lines, PDF through the worker, download and signed-copy upload, one slip per issue or return |
| 5.5 | Merchandise screens | M, split | 5.2 to 5.4 | Catalogue, Receive, Issue (prints slip), Return, Lost or damaged, Return to Snoonu, Adjustment, Movements with reverse, Slips; employee Holdings tab; opening stock import on the wizard |
| 5.6 | Inventory reports and low-stock alert | M | SPEC 3.4 report | `inventory.reconciliation` (summary first), `inventory.low_stock`, `inventory.holdings`; report page layout as SPEC 3.4; low-stock notification rule |
| 5.7 | Fleet schema | S | PLAN 3.13, this plan 4.3 | Migration for all fleet tables with the exclusion constraints (assignment per vehicle and per person, terms per vehicle), unique plate, chassis and fine reference, insert-only payments, module manifest, permissions `fleet.*`, registries, vehicle document types Istimara and insurance set to apply to vehicles, RLS and audit tests |
| 5.8 | Vehicles and assignments | S | this plan 4.3 assignment rules | `VehicleService` and `AssignmentService`: register CRUD, assign (closes the previous period), return, back-dating, corrections guarded by attributed fines, status rules, `holderOn(vehicle, date)` and `vehicleOf(person, date)`, employee holdings route, plate normalisation, vehicle and opening-assignment imports; tests for every rule |
| 5.9 | Fleet screens | M, split | 5.7, 5.8 | Register with current user and "using since", vehicle detail tabs (Details, Terms, Assignments, Documents with the **date-only pill**, also on the employee documents tab), Assign and Return dialogs, employee header shows vehicle and plate today, vehicle expiry emails and list name plate and holder |
| 5.10 | Rent dues, payments and postings | S | SPEC 4.1 rent ledger, Phase 2 posting service | Effective-dated terms service, `Generate this month's dues` (idempotent, active vehicles only, terms valid on the due date), void a due, payments with receipt, reversal, derived status, posting rules `fleet.due_accrued`, `fleet.due_paid`, `fleet.violation_paid`, `fleet.maintenance_paid` seeded per company, balanced-journal tests |
| 5.11 | Dues screens, reports and overdue alert | M | 5.10 | Dues list by month with Generate, payment dialog, reverse; reports by month, vehicle and payee with outstanding totals; daily overdue alert |
| 5.12 | Traffic violations | S | SPEC 4.1, 5.16 violations | Entry and import (duplicate reference refused), automatic attribution through `holderOn`, unattributed flag, re-attribute, dispute, mark paid (posting), deduct from salary (suggestion moves or waives as in 4.3), screens and `fleet.violations` report |
| 5.13 | Maintenance and incidents | M, split | SPEC 4.1 maintenance, 5.16 incidents | Maintenance log with cost paid from a cash location (rule from 5.10), next due by date or km, service-due alert and `fleet.maintenance_due`; incident register with people involved, photos, police report, claim status, repair cost, liability and recovery (suggestion through 5.1) |
| 5.14 | FDB check: Istimara, plate, schedule | M | Phase 4 rows 4.9, 4.9b | Compare the FDB Istimara expiry with the Istimara of the vehicle the person holds on the run date; compare the sheet's plate with the assigned vehicle (difference types `istimara_differs`, `plate_differs`, `no_vehicle`); run the FDB check automatically after each successful scheduled sync of the same source; tests on the extended fixture |
| 5.15 | Phase 5 journeys and wrap-up | M | section 8 | Playwright journeys for each Done-when row, OpenAPI check, user guide pages for merchandise and fleet, PROGRESS marks Phase 5 done |
| 5.16 | Translations | H | i18n files | Draft bn, hi, ne, ur labels for Phase 5 keys; glossary (Istimara, handover slip, reconciliation, payee, attribution, pending deduction) |

Totals: 7 rows on S, 8 on M, 1 on H. Expect about 20 sessions with splits.

Cost note: S rows are the ones that decide whether a number is right: the deductions queue, the stock rules, the assignment periods (attribution depends on them), rent and fine postings, and violation attribution. Screens, slips, reports and the FDB extension follow existing patterns and stay on M.

## 10. Decisions this plan proposes (to record in DECISIONS.md in row 5.1)

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Create `payroll.suggested_deduction` now (inbound queue only); Phase 7 applies it | Fines from Phase 5 must not be lost or kept in three module-specific lists; PLAN already names this table as the single queue |
| D2 | Stock and holdings are derived from `stock_movement` only; no stock column anywhere | SPEC 3.4 "always calculated from the ledger"; same principle as money (SPEC 2.9) |
| D3 | Lost or damaged "while held" is its own movement and reduces the person's holding, not office stock | The reconciliation must count it once; office stock never held that item |
| D4 | The employee's plate is derived from the current vehicle assignment; the sheet's plate is only compared | One home for a fact; the Phase 4 sheet plate becomes a cross-check |
| D5 | One holder per vehicle per day and one vehicle per person per day, both as database constraints; reassignment closes the previous period at D - 1 | Violation attribution needs exactly one answer for any date |
| D6 | Rent and service charges are accrued when dues are generated (expense against payee payable) and cleared by payments; status is derived | Outstanding by payee then matches the ledger; no module balance |
| D7 | Inventory movements post nothing to the ledger | The equipment belongs to Snoonu and has no cost to the company |
| D8 | Vehicle documents reuse `people.document` (`owner_type = vehicle`) and the existing expiry job | Already allowed by the Phase 3 schema; one alert engine (SPEC 4.1) |
| D9 | Snoonu's `Merchandise Report` tab is not read in Phase 5; receipts are entered by staff | Its layout is unknown; the adapter can read it later without schema changes |
| D10 | A traffic fine with no holder on its date is saved as unattributed and flagged, never guessed | Wrong attribution would take money from the wrong person |

## 11. Questions for the owner

Each has a suggested default; reply "default" to accept it.

1. **Bikes owned by the worker:** when a rider uses their own bike, does the company pay them anything for it, and should that appear here? *Default: the bike is listed with owner "worker" so documents and fines work, but no rent dues are created; any allowance is handled in payroll (Phase 7).*
2. **Rent from the worker's salary** (open question #18): for a company-rented bike or car, do you take any rent from the worker's salary? *Default: no. If yes for some vehicles, you set a "charge to worker" amount on that vehicle and payroll uses it in Phase 7.*
3. **Traffic fines:** should a fine normally be taken from the worker's salary? *Default: yes, ticked by default, staff can untick it, and nothing is deducted until payroll approves it.*
4. **More than one vehicle:** can one person ever hold two vehicles at the same time (for example a bike and a car)? *Default: no, one at a time.*
5. **Sizes:** which items have sizes, and which sizes? *Default: T-shirt, pants, vest and jacket in S, M, L, XL, XXL, XXXL; gloves in M, L, XL; all other items one size.*
6. **Lost or damaged items:** is there a standard fine per item? *Default: each item has a default fine you can set (start at 0), staff can change it each time, and "deduct from salary" is ticked only when a fine is entered.*
7. **Rent day and payees:** on which day of the month is vehicle rent due, and who do you pay (rental company names)? *Default: due on the 1st; you add each rental company once as a payee when entering the vehicle.*
8. **Starting figures:** how will you give us today's numbers: office stock per item and size, who holds what, and the vehicle list with current users? *Default: three Excel templates from the import screen, filled once on the go-live date; the slip number format starts at HS00001.*
