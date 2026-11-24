# Phase 5 plan: Inventory and fleet

Status: **waiting for approval**. Based on `docs/phases/phase-05.md`, SPEC 3.4, 4.1 and 5.16 (incidents and violations only), PLAN 3.12, 3.13, 5.14, 5.15, `docs/DECISIONS.md`, and what Phases 1 to 4 built. Written 2026-11-24. Updated 2026-11-24 with the owner's answers (section 11) and the three rider cost arrangements; open points are in section 12.

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
- **Fleet:** one register of bikes and cars with plate, owner, Istimara and insurance dates and documents. Each vehicle shows **who has it today and since when**; giving it to someone else closes the previous person's period automatically. The rider's profile shows their current vehicle, plate and cost arrangement.
- **Three kinds of rider (cost arrangement):** every vehicle assignment says, from a date, which arrangement applies:
  - **Own bike:** the rider's own bike; the company provides nothing for it. Garage repair bills for it come as a list from the garage and go to pending deductions.
  - **Company support:** the company pays the bike rent, the fuel bill and the room rent; nothing is deducted from the rider for the bike. Fuel and room are company expenses and show in the expense reports.
  - **Rider pays:** the rider uses a company or rented vehicle, and its rent and its service charges are taken from his salary (as pending deductions that payroll approves).
  - The per-order pay (5 QAR for company support, 10 QAR otherwise) is set up in Phase 6 and paid in Phase 7; Phase 5 only records the arrangement and its dates and shows it, including a report "Riders by cost arrangement".
- **Expiry alerts:** Istimara and insurance expiry use the same alert emails as QID and passport (14 and 7 days before).
- **Rent and service charges:** "Generate this month's dues" creates the rent lines for every active vehicle from its agreed terms, with **who it is paid to**, due 4 days after the salary payment date. It also creates this month's rent charge for every "rider pays" rider as a pending deduction. Garage, service, fuel and room bills are entered or imported as charge lines. For a bike supplied by a garage, its rent and its service charges are owed to the same garage and appear on **one payee statement**. You record payments with receipts, and reports show what is outstanding by month, vehicle and payee. Rent, charges and payments go into the accounts automatically.
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
- Rates, charges, company-borne costs and SIMs (Phase 6, SPEC 4.2), even though "vehicle rent" is also an expense type there. This includes the **per-order pay rate per cost arrangement** (5 QAR company support, 10 QAR own bike and rider pays): loaded into the rate tables in Phase 6, driven by the arrangement Phase 5 stores (decision D15).
- A housing module. Room rent for company-support riders is only a charge line with a charge type (decision D13).
- Leave, disciplinary records and letters from SPEC 5.16 (Phase 10).
- Reading Snoonu's `Merchandise Report` tab automatically (see decision D9).
- GPS and telematics (Phase 11).

## 4. Tables and relations

All tables use `app.setup_table(...)` (RLS, audit trigger, no DELETE grant), standard columns per PLAN 2.1, money as `NUMERIC(18,4)` plus currency. Tag **A** means insert-only: the app role has no UPDATE or DELETE, corrections are reversal rows.

### 4.1 Schema `payroll` (only the inbound queue, created early)

| Table | Tag | Key columns | Notes |
| --- | --- | --- | --- |
| `suggested_deduction` | S | party_id, source_module, source_type, source_id, pay_component_key, amount (money), target_period (YYYY-MM, null = next run), status (pending, applied, waived), payslip_line_id (null until Phase 7), waive_reason | PLAN 3.16. Unique (source_type, source_id) among live rows, so a source makes at most one suggestion. Phase 5 only writes `pending` and lets staff `waive` with a reason; Phase 7 applies it. Pay component keys used in Phase 5: `merchandise_fine`, `traffic_fine`, `incident_recovery`, `vehicle_rent_recovery`, `vehicle_charge_recovery` |

### 4.2 Schema `inventory` (PLAN 3.12)

| Table | Tag | Key columns | Notes |
| --- | --- | --- | --- |
| `item` | S | code, name JSONB, category (lookup `merchandise_category`), has_sizes, unit, low_stock_threshold, active | Seeded: T-shirt, pants, thermal bag, helmet, chest guard, gloves, safety guard, delivery box, vest, jacket. Sizes seeded: T-shirt, pants, vest, jacket in S, M, L, XL, XXL, XXXL; gloves in M, L, XL; others one size |
| `item_variant` | S | item_id, size_code (null when no sizes), sku, loss_fine (money, default 0) | Exactly one variant with no size when `has_sizes` is false. The fine rate is per variant (owner); staff can change it on each loss |
| `stock_location` | S+B | name, kind (office, warehouse), active | One "Main office" seeded |
| `stock_movement` | **A** | number, movement_date, type, item_variant_id, quantity (signed), location_id, holder_party_id, client_platform_id, handover_slip_id, reference, note, reversal_of_id | The only source of stock. See rules below |
| `handover_slip` | S | number, party_id, issue_date, kind (issue, return), generated_document_id, signed_file_id, status (generated, signed) | One slip groups the lines of one issue or return |
| `loss_record` | S | stock_movement_id, party_id, fine_charged, fine (money), deduct_from_salary, suggested_deduction_id | One per lost or damaged movement that is charged to a person. Fine starts at the variant's `loss_fine`, editable; "deduct from salary" is ticked by default whenever the fine is above 0 |

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
| `vehicle_terms` | S | vehicle_id, valid_from, valid_to, rent (money), service_charge (money), payee_party_id, rider_charge (money, nullable), rider_charge_basis (month_prorated, per_day; nullable), terms_note | Effective-dated, exclusion constraint: no overlap per vehicle. A change of terms closes the old row and starts a new one, so past months keep their terms. `payee_party_id` is the vehicle's owner or the garage that supplied it; for a garage the rent and the garage's service charges go to the same payee. `rider_charge` is what a "rider pays" rider is charged; both it and its basis are required before a "rider pays" arrangement can start on the vehicle. No due day here: the due date comes from the company settings (D14) |
| `vehicle_assignment` | S | vehicle_id, party_id, from_date, to_date, return_note, odometer_out_km, odometer_in_km | See assignment rules below |
| `cost_arrangement` | S | vehicle_assignment_id, party_id, vehicle_id, valid_from, valid_to, arrangement (own_bike, company_supported, rider_pays), note | Dated periods inside one assignment, exclusion constraint: no overlap per assignment. See arrangement rules below |
| `charge_type` | S+B | code, name JSONB, expense_account_key, applies_to (vehicle, rider, both), active | Data, not code. Seeded: `service`, `repair`, `fuel`, `room_rent`, `other` |
| `maintenance_log` | S | vehicle_id, date, odometer_km, work_done, workshop_party_id, next_due_date, next_due_km, vehicle_due_id (nullable) | The cost is not stored here: it is a charge line (`vehicle_due` kind `charge`, type `repair` or `service`) linked by `vehicle_due_id`, so charge-to-rider and posting rules apply once (D17) |
| `vehicle_due` | S | vehicle_id (nullable for kind `charge`), period (YYYY-MM), kind (rent, service_charge, charge), charge_type_id (kind `charge` only), charge_date, description, amount (money), payee_party_id, due_date, vehicle_terms_id, rider_party_id, charge_to_rider, suggested_deduction_id, source (generated, typed, imported), import_batch_id, journal_id | Everything owed to a payee. `rent` and `service_charge` are generated from terms: unique (vehicle, period, kind) among live generated rows. `charge` is one bill line (garage list, fuel bill, room rent): vehicle or rider required, the other filled from `holderOn` / `vehicleOf` on the charge date; duplicate guard on (payee, charge date, rider or vehicle, amount, description) among live rows, a deliberate repeat needs a confirm. Status (due, partial, paid) is **derived** from payments, never stored |
| `vehicle_due_payment` | **A** | vehicle_due_id, paid_on, amount (money), method_id, reference, receipt_file_id, cash_location_id, journal_id, reversal_of_id | Corrections by reversal; total paid can never exceed the due. One payment may be split over several dues of the same payee from the payee statement (one row per due, same reference) |
| `rider_rent_charge` | S | cost_arrangement_id, party_id, vehicle_id, period (YYYY-MM), basis, rate (money), days, amount (money), suggested_deduction_id | The monthly "rider pays" rent charge, the source row of its suggestion. Unique (cost_arrangement_id, period) among live rows, so running Generate twice creates nothing new |
| `traffic_violation` | S | vehicle_id, violation_at, reference_no, authority, description, amount (money), attributed_party_id, attribution (auto, manual), attribution_note, dispute_status (none, disputed, upheld, cancelled), paid_status (unpaid, paid), deduct_from_salary, suggested_deduction_id, journal_id | Reference number unique per authority among live rows, so an import cannot double a fine |
| `incident` | S+B | number, occurred_at, place, geo, vehicle_id, description, police_report_file_id, insurance_claim_status, repair_cost (money), liability_decision (company, worker, third_party, shared, pending), recovery (money), suggested_deduction_id | Photos through `AttachableRegistry` |
| `incident_party` | S | incident_id, party_id, role (driver, third_party, witness) | |

Assignment rules (the part that must be right, row 5.8 on S):

1. **One holder per vehicle per day:** exclusion constraint on `(vehicle_id, daterange(from_date, to_date, '[]'))` among live rows. `to_date` null means "still holding".
2. **One vehicle per person per day** (exclusion constraint on `party_id`); owner confirmed one at a time.
3. **Reassigning closes the previous period automatically:** assigning vehicle V to B from date D sets the open period of A to D - 1 in the same transaction. D cannot be on or before A's `from_date` (that would erase A's period; staff must correct A's period first).
4. **Back-dating is allowed** only into a gap: a period that would overlap a closed period of the vehicle or of the person is refused with the clashing period named.
5. **Return (unassign)** sets `to_date` and optional odometer and note; the vehicle becomes `idle`. Status `in_use` and `idle` follow assignments; `in_workshop` and `sold_or_returned` are set by staff; a sold or returned vehicle cannot be assigned, and selling it requires that it is not assigned.
6. **Holder on a date** (`GET /vehicles/:id/holder?at=`) is the single source for violation attribution, the employee's current plate and the FDB Istimara comparison.
7. **Corrections:** a period's dates may be edited only while no violation or incident is attributed inside the days being removed; otherwise the edit is refused and staff re-attribute first. A wrongly created period is removed with the recycle bin (soft delete with a reason) under the same check. Every change is in the audit trail.
8. **Leaving:** when an employee moves to terminated, the status change shows the vehicle and items they still hold (exit clearance uses the same holdings call in Phase 10). It does not block the move.

Cost arrangement rules (row 5.8 on S; decision D11):

1. **Every assignment has an arrangement on every day it covers.** Creating an assignment creates its first `cost_arrangement` from the same `from_date`; closing or shortening the assignment closes or shortens the open arrangement in the same transaction.
2. **Default and allowed values:** when the vehicle's `owner_kind` is `worker` and the owner is the person assigned, the arrangement is `own_bike` and nothing else is allowed. For a company or third-party (rented or garage-supplied) vehicle, staff must choose `company_supported` or `rider_pays` in the Assign dialog; `own_bike` is refused. A worker-owned vehicle assigned to someone other than its owner is refused (ask the owner if this ever happens).
3. **`rider_pays` needs terms:** refused unless the vehicle's terms valid on the start date carry `rider_charge` and `rider_charge_basis`.
4. **Changing the arrangement** from date D (inside the assignment) closes the current period at D - 1 and opens the new one from D, the same pattern as reassignment. Back-dating is allowed only while no `rider_rent_charge` or rider charge suggestion that is already applied by payroll falls in the changed days; pending ones are recalculated (moved or waived through 5.1). What a mid-cycle switch means for pay is still to confirm (section 12); the data model keeps exact dates so either answer works.
5. **Arrangement on a date** (`arrangementOn(person, date)`) is the single source for the holdings view, the employee header, the "Riders by cost arrangement" report, the rider rent run, the default of "charge to rider" on charge lines, and (Phase 6) the per-order rate.

Rider charges (rows 5.10 and 5.10b; decisions D12 and D13):

- **Rider pays, monthly rent:** "Generate this month's dues" for period P also creates one `rider_rent_charge` per `rider_pays` arrangement period that overlaps P, and one `vehicle_rent_recovery` suggestion for it. Amount: basis `month_prorated` = `rider_charge` x days held under `rider_pays` in P / days in P; basis `per_day` = `rider_charge` x those days; rounded half-up to 0.01 QAR. Which basis the owner uses is still to confirm (section 12); both are built, the basis is chosen per terms row. Period P is the calendar month until the owner confirms otherwise.
- **Rider pays, service charges:** a charge line (`vehicle_due` kind `charge`) on a vehicle whose holder on the charge date is under `rider_pays`, with "charge to rider" ticked, creates one `vehicle_charge_recovery` suggestion for that holder.
- **Own bike, garage charges:** the garage's list (import or typed: date, rider, plate, description, amount; payee = the garage, type `repair` by default) creates charge lines with "charge to rider" ticked, each with one `vehicle_charge_recovery` suggestion. An imported row whose plate is not the rider's vehicle on that date is flagged in the preview and not imported until fixed.
- **Company support:** fuel and room rent are charge lines (types `fuel`, `room_rent`) with "charge to rider" unticked; they are company expenses and appear in `fleet.expenses`. Nothing is suggested for the rider.
- **Default of "charge to rider":** ticked when the holder's arrangement on the charge date is `own_bike` or `rider_pays`, unticked for `company_supported` or when there is no holder. Staff can change it until the line is paid or its suggestion is applied.
- **Queue rules:** one suggestion per source (unique source), re-attributing the line's rider moves a pending suggestion, unticking "charge to rider" or voiding the line waives it, an applied suggestion freezes the line.

Due dates and payee statements (row 5.10; decision D14):

- Two company settings: `payroll.salary_payment_day` (day of the month after the period on which salary for the period is paid; seeded **empty** because the owner has not given it, section 12) and `fleet.due_offset_days` (default 4). Due date of every generated due for period P = salary payment date for P + offset. Generate refuses with a clear message while the salary payment day is empty. A charge line's due date uses the same rule for the period of its charge date.
- **Payee statement:** one per payee per period (and for a date range): every rent, service charge and charge line owed to that payee, its payments and the outstanding total. For a garage-supplied bike the garage is the terms payee, so its rent and its service lines are on one statement and can be paid with one payment split over the lines.

Deductions and damage charges (SPEC 3.4, 4.1, 5.16):

- **Lost or damaged item** charged to a person: `loss_record` with fine and "deduct from salary" -> one `suggested_deduction` (`pay_component_key` `merchandise_fine`).
- **Traffic fine:** "deduct from salary" is **ticked by default** (owner); staff can untick it; nothing is taken until payroll approves. -> one `suggested_deduction` (`traffic_fine`) for the attributed person; re-attributing moves the pending suggestion to the new person; a fine that is disputed and cancelled waives it; a suggestion already applied by payroll cannot be moved or waived from here.
- **Incident** with liability worker or shared and a recovery amount -> one `suggested_deduction` (`incident_recovery`).
- **Vehicle rent and service charges charged to the rider** (`rider_pays`) and **garage charges** (`own_bike`): see "Rider charges" above (`vehicle_rent_recovery`, `vehicle_charge_recovery`). DECISIONS #18 is answered by this.

What stays retire-only (never deleted, never edited after the fact):

- `stock_movement` and `vehicle_due_payment` are insert-only; mistakes are reversal rows.
- `item`, `item_variant`, `stock_location`: retired (`active = false`), not deleted, once any movement uses them.
- `vehicle`: retired by status `sold_or_returned`; its assignments, dues, documents and fines stay.
- `vehicle_assignment` and `cost_arrangement`: closed, not deleted (rule 7 and arrangement rule 4 for corrections).
- `vehicle_terms`: closed with `valid_to`, never rewritten for a month that has dues or rider rent charges.
- `rider_rent_charge`: voided (soft delete with reason, waives its pending suggestion) only while the suggestion is not applied; Generate then recreates it from current data.
- `vehicle_due`: a generated due with a payment cannot be removed; a due with no payment may be voided (soft delete with reason), which reverses its accrual journal.
- Journals: posted entries are immutable; corrections are reversals (SPEC 2.9).
- Handover slips: the generated PDF is insert-only; a new signed copy replaces the link to the old one, the old file stays.

Ledger postings (rules seeded per company through the posting service; accounts from the standard chart, editable as data):

| Event key | When | Debit | Credit |
| --- | --- | --- | --- |
| `fleet.due_accrued` | A due is generated, or a charge line is entered or imported | Rent: Vehicle rent expense; service charge: Vehicle service charge expense; charge line: the charge type's expense account (repairs, fuel, staff accommodation, other), or Recoverable from employees (rider) when "charge to rider" is ticked. Vehicle dimension when there is a vehicle | Accounts payable, payee party |
| `fleet.due_paid` | A payment is recorded | Accounts payable, payee party | Cash or bank (cash location) |
| `fleet.violation_paid` | A fine is marked paid | Recoverable from employees (person) when "deduct from salary", else Traffic fines expense | Cash or bank |
| `fleet.recovery_waived` | A suggestion backed by a "Recoverable from employees" posting is waived (charge line or fine) | The expense account the line would have used | Recoverable from employees (person) |

Ticking or unticking "charge to rider" on a posted line reverses the accrual and posts it again. Reversing a payment, voiding a due or reversing a fine payment posts the reversal journal. The `rider_pays` rent charge (`rider_rent_charge`) posts nothing in Phase 5: the company's rent to the owner is already accrued as `rent`, and the recovery is booked when payroll applies the deduction in Phase 7. Inventory movements post nothing: the equipment belongs to Snoonu and has no cost on our books. Expense accounts for fuel and staff accommodation are added to the standard chart if missing (data, editable).

## 5. Endpoints

PLAN 5.14 and 5.15 under `/api/v1`, all in OpenAPI, with these additions:

- `GET /suggested-deductions?partyId=&status=`, `POST /suggested-deductions/:id/waive`.
- `GET /employees/:id/holdings` (items held plus current vehicle and its cost arrangement with "since"), used by the profile and later by exit clearance.
- `GET /vehicle-assignments/:id/arrangements`, `POST /vehicle-assignments/:id/arrangements` (change from a date), `GET /cost-arrangements?at=` (who is on which arrangement on a date).
- `GET/POST /vehicle-charges` (charge lines; void, re-attribute, toggle "charge to rider"), `GET /charge-types` (CRUD on the lookup), `GET /payees/:partyId/statement?period=` or `?from=&to=`, `POST /payees/:partyId/payments` (one payment split over chosen dues).
- `GET/PUT /fleet/settings` (salary payment day, due offset).
- `POST /stock/opening-balance` (one-time, per location, dated go-live; refused once any other movement exists for that variant and location).
- Imports registered on the existing wizard: vehicles, opening stock, opening assignments (with arrangement and "since" date), traffic violations, **garage charges** (date, rider, plate, description, amount; payee and charge type picked in the wizard). The three go-live templates are opening stock, opening holdings and vehicles with current users (question 8).

## 6. Screens, reports and alerts

| Area | Screens |
| --- | --- |
| Merchandise | Item catalogue with sizes; **Receive from Snoonu**; **Issue** (pick employee, items, sizes, quantities, date; prints the handover slip); **Return** (shows what the person holds); **Lost or damaged** (with fine and "deduct from salary"); **Return to Snoonu**; Adjustment; Movements (filter, reverse); Handover slips (download, upload signed copy) |
| Merchandise report | **Reconciliation summary at the top**: per item, received from Snoonu versus office stock + with employees + lost or damaged + returned to Snoonu, difference highlighted; then office stock with low-stock warnings, **who holds what**, movement history, per-employee holdings |
| Fleet | Vehicle register (list shows **current user and "using since"**, arrangement, plate, type, status, Istimara and insurance expiry); vehicle detail with tabs: Details, Terms (rent, service charge, payee, rider charge and basis), Assignments (with arrangement periods), Documents (with the date-only pill), Maintenance, Dues and charges, Fines, Incidents; Assign dialog (arrangement: fixed "Own bike" for the owner's own vehicle, otherwise a required choice), Change arrangement and Return dialogs |
| Rent and charges | Dues list per month with **Generate this month's dues** (also creates rider rent charges, shows how many), record payment (receipt upload), reverse payment; **Charges** entry (type, payee, vehicle or rider, amount, "charge to rider") and the garage list import; **Payee statement** with one payment over several lines; Fleet settings (salary payment day, offset); reports by month, by vehicle, by payee with outstanding totals |
| Fines and incidents | Traffic fines list (import, attributed person, re-attribute, dispute, mark paid, deduct); Incidents list and form (people involved, photos, police report, insurance claim, repair cost, liability, recovery) |
| Pending deductions | One list of suggestions from all sources, filter by person and status, waive with reason (payroll applies them in Phase 7) |
| Employee profile | **Vehicle, plate and cost arrangement today** in the header details; Holdings tab (items, vehicle, arrangement and since, arrangement history); Deductions tab (pending suggestions) |
| Performance | FDB check gains "Istimara differs" and "Plate differs"; run history shows scheduled runs |

Reports (report engine): `inventory.reconciliation`, `inventory.low_stock`, `inventory.holdings`, `fleet.current_holders`, `fleet.dues_by_month`, `fleet.dues_by_vehicle`, `fleet.dues_by_payee`, `fleet.payee_statement`, `fleet.expenses` (company-paid rent, service, repair, fuel and room by charge type, vehicle, rider, arrangement and month; lines charged to riders shown apart), **`fleet.riders_by_arrangement`** ("Riders by cost arrangement": rider, vehicle, arrangement, since, monthly charge; on a chosen date, default today; monthly charge = `rider_charge` with its basis for `rider_pays`, plus the amount charged for the current month so far; blank otherwise), `fleet.violations`, `fleet.maintenance_due`.

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
| Every assignment carries a dated cost arrangement | Unit and integration: own vehicle defaults to own_bike and refuses others; company or rented vehicle requires company_supported or rider_pays; rider_pays refused without rider charge on the terms; change from D closes the old period at D - 1; closing the assignment closes the arrangement; `arrangementOn` on boundary days |
| Generate this month's dues creates rent entries with payee, due salary payment date + 4 days | Integration: twice for the same month creates nothing new; terms changed mid-year keep old months; sold vehicle skipped; due date from the settings, refused while the salary payment day is empty; accrual journal balanced |
| Rider pays: monthly rent charge and service charges become pending deductions | Unit: proration month_prorated and per_day, full month, joined mid-month, switched arrangement mid-month, rounding; integration: Generate creates one suggestion per arrangement period and month (twice creates nothing), a service charge line charged to the rider creates one suggestion, re-attribute moves it, untick or void waives it and posts `fleet.recovery_waived` |
| Own bike: garage charges become pending deductions | Integration: garage list import with a wrong plate flagged, duplicate line refused without confirm, each line one suggestion and an accrual to Recoverable from employees against the garage payable |
| Company support: fuel and room are company expenses | Integration: fuel and room lines post to their expense accounts, no suggestion, appear in `fleet.expenses` |
| Garage-supplied bike: one payee statement | Integration: rent and service lines of one garage on one statement; one payment split over them; outstanding matches the payable account balance for that payee |
| Report "Riders by cost arrangement" | Integration: fixture with all three arrangements and one mid-month switch; report on two dates equals a hand-written table (rider, vehicle, arrangement, since, monthly charge) |
| A traffic violation is attributed to the holder on that date | Unit and integration: date inside, on the boundary days, in a gap (unattributed, flagged), re-attribution moves the pending deduction |
| Rent payments and fines post to the ledger | Integration: payment, partial payment, over-payment refused, reversal; fine paid with and without deduction posts to the right account; journals balanced and immutable |
| Lost item, fine and incident recovery create pending deductions | Integration: one suggestion per source; reversal or cancellation waives it |
| Vehicle Istimara and insurance alerts | Integration: vehicle document 14 days out produces one alert naming plate and holder; second run sends nothing |
| FDB Istimara and plate differences; scheduled check | Integration with the Phase 4 FDB fixture extended with Istimara and plate values |
| Main journeys | Playwright: receive, issue with slip, return, reconciliation; add vehicle, assign with an arrangement, change arrangement, reassign, generate dues, pay from the payee statement; import a garage list; enter fine and see the holder; Riders by cost arrangement |
| Tests pass in CI, PROGRESS updated | Full suite (local until the GitHub billing lock is cleared) |

## 9. Commit sequence

| Row | Title | Tier | Reads | What it builds |
| --- | --- | --- | --- | --- |
| 5.1 | Pending deductions queue | S | PLAN 3.16 `suggested_deduction`, this plan 4.1 | Migration for `payroll.suggested_deduction` (unique live source, status rules), `DeductionSuggestionService` (`suggest`, `move`, `waive`, `recalculate` of a pending amount; applied rows frozen by trigger), events, permissions `payroll.suggested_deduction.*`, routes list and waive, RLS and audit tests. Record in DECISIONS.md the decisions of section 10 not already there (the owner's rider rules and D15 were recorded with the plan) |
| 5.2 | Inventory schema and catalogue | S | PLAN 3.12, this plan 4.2 | Migration for all inventory tables (insert-only `stock_movement` with sign CHECK and single reversal), seeded items and Main office, module manifest, permissions `inventory.*`, `PartyReferenceRegistry` and `AttachableRegistry` entries, item and location CRUD routes, RLS and audit tests |
| 5.3 | Stock movement service | S | this plan 4.2 rules | `StockService`: receipt, issue, return, loss, damage, return to client, adjustment, opening balance, reversal; lock per variant and location; derived stock and holdings queries; loss with fine creates the suggestion (5.1); routes `/stock*`; unit tests for every rule |
| 5.4 | Handover slips | M | PLAN 3.12, Phase 2 templates | Slip numbering (`HS{00000}` unless the owner gives a format), English template with signature lines, PDF through the worker, download and signed-copy upload, one slip per issue or return |
| 5.5 | Merchandise screens | M, split | 5.2 to 5.4 | Catalogue, Receive, Issue (prints slip), Return, Lost or damaged, Return to Snoonu, Adjustment, Movements with reverse, Slips; employee Holdings tab; opening stock import on the wizard |
| 5.6 | Inventory reports and low-stock alert | M | SPEC 3.4 report | `inventory.reconciliation` (summary first), `inventory.low_stock`, `inventory.holdings`; report page layout as SPEC 3.4; low-stock notification rule |
| 5.7 | Fleet schema | S | PLAN 3.13, this plan 4.3 | Migration for all fleet tables with the exclusion constraints (assignment per vehicle and per person, terms per vehicle, cost arrangement per assignment), `vehicle_due` kinds and charge columns, `rider_rent_charge` with unique (arrangement, period), `charge_type` lookup seeded (service, repair, fuel, room_rent, other), company settings `payroll.salary_payment_day` (empty) and `fleet.due_offset_days` (4), unique plate, chassis and fine reference, insert-only payments, module manifest, permissions `fleet.*`, registries (payee, rider and workshop columns in `PartyReferenceRegistry`), vehicle document types Istimara and insurance set to apply to vehicles, RLS and audit tests |
| 5.8 | Vehicles, assignments and cost arrangements | S | this plan 4.3 assignment and arrangement rules | `VehicleService`, `AssignmentService` and arrangement handling: register CRUD, assign with arrangement (default and allowed values), change arrangement from a date, return (closes the arrangement), back-dating, corrections guarded by attributed fines and applied rider charges, status rules, `holderOn(vehicle, date)`, `vehicleOf(person, date)`, `arrangementOn(person, date)`, employee holdings route with arrangement and since, plate normalisation, vehicle and opening-assignment imports (arrangement and since columns); tests for every rule |
| 5.9 | Fleet screens | M, split | 5.7, 5.8 | Register with current user, "using since" and arrangement, vehicle detail tabs (Details, Terms with rider charge and basis, Assignments with arrangement periods, Documents with the **date-only pill**, also on the employee documents tab), Assign (arrangement choice), Change arrangement and Return dialogs, employee header shows vehicle, plate and arrangement today, vehicle expiry emails and list name plate and holder |
| 5.10 | Rent dues, payments and postings | S | SPEC 4.1 rent ledger, Phase 2 posting service, this plan 4.3 due dates | Effective-dated terms service (rider charge and basis required for rider_pays), fleet settings route, `Generate this month's dues` (idempotent, active vehicles only, terms valid in the period, due date = salary payment date + offset, refused while the day is empty), void a due, payments with receipt including one payment split over a payee's dues, reversal, derived status, payee statement query, posting rules `fleet.due_accrued` (by kind and charge type), `fleet.due_paid`, `fleet.violation_paid`, `fleet.recovery_waived` seeded per company, fuel and staff accommodation accounts added to the chart if missing, balanced-journal tests |
| 5.10b | Charge lines and rider recovery | S | this plan 4.3 rider charges, 5.1 queue | `VehicleChargeService`: charge lines typed and imported (garage list on the wizard with plate check and duplicate guard), rider and vehicle filled from `holderOn` / `vehicleOf`, default "charge to rider" from `arrangementOn`, suggestion per line (`vehicle_charge_recovery`), re-attribute moves, untick or void waives with reversal and `fleet.recovery_waived`; rider rent run inside Generate (`rider_rent_charge`, proration by basis, one `vehicle_rent_recovery` suggestion each, recalculated when an arrangement changes and the suggestion is still pending); unit tests for proration and every queue rule |
| 5.11 | Dues and charges screens, reports and overdue alert | M, split | 5.10, 5.10b | Dues list by month with Generate (shows dues and rider charges created), payment dialog, reverse; Charges entry and garage import screen; Payee statement with split payment; Fleet settings screen; reports `fleet.dues_by_month`, `_by_vehicle`, `_by_payee`, `fleet.payee_statement`, `fleet.expenses`, **`fleet.riders_by_arrangement`**; daily overdue alert |
| 5.12 | Traffic violations | S | SPEC 4.1, 5.16 violations | Entry and import (duplicate reference refused), automatic attribution through `holderOn`, unattributed flag, re-attribute, dispute, mark paid (posting), deduct from salary (suggestion moves or waives as in 4.3), screens and `fleet.violations` report |
| 5.13 | Maintenance and incidents | M, split | SPEC 4.1 maintenance, 5.16 incidents | Maintenance log with its cost entered as a charge line through `VehicleChargeService` (5.10b: workshop as payee, type repair or service, "charge to rider" defaulted by arrangement), next due by date or km, service-due alert and `fleet.maintenance_due`; incident register with people involved, photos, police report, claim status, repair cost, liability and recovery (suggestion through 5.1) |
| 5.14 | FDB check: Istimara, plate, schedule | M | Phase 4 rows 4.9, 4.9b | Compare the FDB Istimara expiry with the Istimara of the vehicle the person holds on the run date; compare the sheet's plate with the assigned vehicle (difference types `istimara_differs`, `plate_differs`, `no_vehicle`); run the FDB check automatically after each successful scheduled sync of the same source; tests on the extended fixture |
| 5.15 | Phase 5 journeys and wrap-up | M | section 8 | Playwright journeys for each Done-when row, OpenAPI check, user guide pages for merchandise and fleet, PROGRESS marks Phase 5 done |
| 5.16 | Translations | H | i18n files | Draft bn, hi, ne, ur labels for Phase 5 keys; glossary (Istimara, handover slip, reconciliation, payee, attribution, pending deduction) |

Totals: 8 rows on S, 8 on M, 1 on H. Expect about 21 sessions with splits.

Cost note: S rows are the ones that decide whether a number is right: the deductions queue, the stock rules, the assignment and arrangement periods (attribution, rider charges and the Phase 6 per-order rate depend on them), rent, charge and fine postings, rider recovery and proration, and violation attribution. Screens, slips, reports and the FDB extension follow existing patterns and stay on M. Row 5.10b was added because charge lines and rider recovery would not fit in one session with 5.10.

## 10. Decisions this plan proposes (to record in DECISIONS.md in row 5.1)

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Create `payroll.suggested_deduction` now (inbound queue only); Phase 7 applies it | Fines from Phase 5 must not be lost or kept in three module-specific lists; PLAN already names this table as the single queue |
| D2 | Stock and holdings are derived from `stock_movement` only; no stock column anywhere | SPEC 3.4 "always calculated from the ledger"; same principle as money (SPEC 2.9) |
| D3 | Lost or damaged "while held" is its own movement and reduces the person's holding, not office stock | The reconciliation must count it once; office stock never held that item |
| D4 | The employee's plate is derived from the current vehicle assignment; the sheet's plate is only compared | One home for a fact; the Phase 4 sheet plate becomes a cross-check |
| D5 | One holder per vehicle per day and one vehicle per person per day, both as database constraints; reassignment closes the previous period at D - 1 | Violation attribution needs exactly one answer for any date; owner confirmed one vehicle per person at a time |
| D6 | Rent, service charges and charge lines are all `vehicle_due` rows accrued when generated or entered (expense, or Recoverable from employees when charged to the rider, against the payee payable) and cleared by payments; status is derived | Outstanding by payee and the payee statement then match the ledger; no module balance |
| D7 | Inventory movements post nothing to the ledger | The equipment belongs to Snoonu and has no cost to the company |
| D8 | Vehicle documents reuse `people.document` (`owner_type = vehicle`) and the existing expiry job | Already allowed by the Phase 3 schema; one alert engine (SPEC 4.1) |
| D9 | Snoonu's `Merchandise Report` tab is not read in Phase 5; receipts are entered by staff | Its layout is unknown; the adapter can read it later without schema changes |
| D10 | A traffic fine with no holder on its date is saved as unattributed and flagged, never guessed | Wrong attribution would take money from the wrong person |
| D11 | Each vehicle assignment carries dated `cost_arrangement` periods: `own_bike`, `company_supported`, `rider_pays`; own_bike is fixed for the owner's own vehicle, the other two must be chosen for company or rented vehicles; `arrangementOn(person, date)` is the single source | Owner's three kinds of rider; pay, deductions and expenses all depend on which applies on a date |
| D12 | Rider pays: `vehicle_terms` carries `rider_charge` and `rider_charge_basis` (month_prorated or per_day); the monthly rent charge is a `rider_rent_charge` row made by "Generate this month's dues" with one `vehicle_rent_recovery` suggestion; it posts nothing until payroll applies it | Owner: rent is recovered from salary; one run, idempotent per arrangement and month; nothing taken without payroll approval |
| D13 | Service, repair, fuel and room bills are charge lines (`vehicle_due` kind `charge`) with a `charge_type` lookup (data); "charge to rider" defaults from the arrangement and creates one `vehicle_charge_recovery` suggestion; company-paid lines are expenses by charge type; no housing module | One route for every bill from a garage, fuel station or landlord; garage lists for own bikes and service charges for rider-pays vehicles reuse it |
| D14 | Due date of every vehicle due = salary payment date for the period (company setting `payroll.salary_payment_day`) + `fleet.due_offset_days` (4); the payee statement lists all dues of one payee, so a garage's rent and service lines are paid together | Owner: rent to bike owners is paid 4 days after salary; garages are paid rent and service together |
| D15 | Per-order pay rate is not stored in Phase 5: 5 QAR for company_supported, 10 QAR for own_bike and rider_pays, to be loaded into the rate tables in Phase 6, driven by the cost arrangement | Rates belong to Phase 6 (SPEC 4.2) and pay to Phase 7; Phase 5 keeps the dated arrangement they need |
| D16 | Loss fine is per item variant (default 0, editable at the loss); "deduct from salary" is ticked by default for item losses with a fine and for traffic fines | Owner's answers to questions 3 and 6 |
| D17 | Maintenance cost is entered as a charge line, not stored on the maintenance log | One cost route, so charge-to-rider and postings apply once |
| D18 | Waiving a suggestion that was posted to Recoverable from employees posts `fleet.recovery_waived` (expense debit, recoverable credit) | The recoverable balance per person must equal the pending and applied suggestions |

## 11. Questions for the owner (answered 2026-11-24)

1. **Bikes owned by the worker:** *Answer:* own bike, paid 10 QAR per order (Phase 6 and 7), the company provides nothing for the bike; garage repair charges come as a list from the garage and are deducted from salary (charge lines with "charge to rider", D13). The bike is listed with owner "worker"; no rent dues.
2. **Rent from the worker's salary** (open question #18): *Answer:* depends on the arrangement. Company support: the company pays bike rent, fuel and room, rider paid 5 QAR per order, nothing deducted for the bike. Rider pays: rider paid 10 QAR per order, vehicle rent and service charges deducted from salary (D12, D13). How the rent is calculated is still to confirm (section 12).
3. **Traffic fines:** *Answer:* always deducted from salary; ticked by default, staff can untick, nothing taken until payroll approves (D16).
4. **More than one vehicle:** *Answer:* one vehicle per person at a time (D5).
5. **Sizes:** *Answer:* as proposed: T-shirt, pants, vest and jacket in S, M, L, XL, XXL, XXXL; gloves in M, L, XL; all other items one size.
6. **Lost or damaged items:** *Answer:* a fine rate per item variant, editable at the loss (D16).
7. **Rent day and payees:** *Answer:* rent to bike owners is due 4 days after the salary payment date (company setting, offset 4); a garage-supplied bike's rent is paid to the garage together with its service charges on one payee statement (D14). The salary payment day itself is still to confirm.
8. **Starting figures:** *Answer:* three Excel templates (opening stock, opening holdings, vehicles with current users and arrangement); slip numbers start at HS00001.

## 12. Still to confirm with the owner

Each has the default the build uses until answered; none needs a schema change to switch.

1. **Salary payment day:** on which day of the following month is salary paid? *Default: none; Generate refuses until the setting is filled.*
2. **How the rider-pays rent is calculated:** a monthly amount prorated by days held, or a daily amount? *Default: both built; the basis is chosen on each vehicle's terms, `month_prorated` preselected; calendar month; rounded half-up to 0.01 QAR.*
3. **Switching arrangement mid-cycle:** when a rider moves between arrangements (for example rider pays to company support) during the month, is each part charged and paid by its own days, or does one arrangement apply to the whole cycle? *Default: split by exact days (the rent charge is prorated by days under rider pays; Phase 6 applies the per-order rate by the date of each order).*
4. **Room rent payee:** is room rent paid to a landlord we should list as a payee? *Default: yes, the landlord is added once as a payee party and room rent lines are owed to them.*
