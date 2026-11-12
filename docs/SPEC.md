# Fibrex Platform — Product and Engineering Specification

This file is the single source of truth for what to build. Read it fully before any work.
Section numbers (for example 2.9, 4.6, 5.8) are referenced from CLAUDE.md and docs/phases/.

## 1. Role, context and stack

You are a principal full-stack engineer and software architect. Design and build a production-grade, fully functional web application called **FleetForce** (working name) for a manpower supply company in Qatar. Write real, complete code: no placeholders, no "TODO: implement", no mock data in production paths.

### Business context

The company supplies bike riders and car drivers to food delivery platforms in Qatar (Snoonu, Keeta, Talabat, and others later). It recruits workers, manages their documents, vehicles, equipment, advances and loans, monitors their daily performance from client-provided reports, and pays monthly salaries after deductions. Snoonu is the first client; every client-specific feature must be built so a second client can be added through configuration, not code changes.

### Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18 + TypeScript + Vite, TanStack Query, React Router, React Hook Form + Zod, Tailwind CSS + shadcn/ui, TanStack Table, Recharts |
| Backend | Node.js 24 LTS (originally 20; changed 2026-11-13, see DECISIONS) + Express + TypeScript, Zod validation, layered structure (route, controller, service, repository) |
| Database | PostgreSQL 16 with Prisma ORM; JSONB for dynamic fields; all money as `NUMERIC(18,4)` |
| Jobs and queues | BullMQ + Redis for scheduled jobs, emails, sheet sync, salary generation |
| Files | S3-compatible object storage (local MinIO in development) with signed URLs |
| Real time | Socket.IO for in-app notifications |
| Auth | JWT access token + rotating refresh token in httpOnly cookie, Argon2 password hashing |
| Integrations | Google Sheets API (read-only service account or OAuth), SMTP or Gmail API for email, an LLM API for the assistant |
| Delivery | Monorepo (`apps/web`, `apps/api`, `packages/shared`), Docker Compose, `.env.example`, seed script |

PostgreSQL is chosen over MongoDB deliberately: the domain is relational and financial, and ledger correctness needs ACID transactions and foreign keys. Do not substitute it.

Additions required by sections 2.6 to 2.13: PostgreSQL row-level security and monthly partitioning (written as SQL migrations alongside Prisma), a sandboxed expression engine for formulas, a transactional outbox for events, Workbox for the Progressive Web App, OpenTelemetry for observability, server-side PDF rendering for all documents, and adapters for WhatsApp, SMS, OCR, e-signature, bank files and accounting software. If Prisma cannot express something the design needs, use typed raw SQL in the repository layer; never weaken the design to fit the ORM.

### Global conventions

- Default currency QAR and time zone Asia/Qatar, both configurable per company; store timestamps in UTC and every amount with its currency code.
- Interface in English, built with i18n (react-i18next) so Bangla and Arabic (RTL) can be added without refactoring.
- Every list page has search, filters, sorting, pagination, column chooser, and export to Excel and PDF.
- Every module is responsive and usable on a phone, because riders and drivers will use the portal from mobile.

## 2. Foundation (build this first; every module depends on it)

The foundation must make new entry forms and new reports cheap to add. A developer adding a module later should write a schema, a service, and a page config, and get permissions, audit history, soft delete, export, and notifications for free.

### 2.1 Users, roles and permissions

- Built-in roles: Super Admin, Admin, Owner, Manager, User (office staff), Rider, Driver. Super Admin can create further custom roles.
- Only Super Admin and Admin can create accounts. Super Admin can create every role, including Admin. Admin can create only the roles Super Admin allows.
- Permissions are granular and data-driven: `module` x `action` (view, create, update, delete, restore, export, approve) plus per-report access. Store them in tables, never hard-code role checks. Use a single `can(user, action, resource)` helper on both backend (middleware) and frontend (route guards and hidden buttons).
- Super Admin has a permission matrix screen: tick boxes per role, plus per-user overrides (grant or deny) that take priority over the role.
- Record-level scope: Riders and Drivers see only their own data. Staff can be limited by client platform or zone.
- Account security: forced password change on first login, optional two-factor (TOTP) for Super Admin, Admin and Owner, login history with device and IP, session list with remote logout, account lock after repeated failures.
- Super Admin can impersonate a user for support; impersonated actions are logged with both identities.

### 2.2 Audit trail and change history

- Every create, update, delete, restore, approve, login, export and file download writes an immutable audit record: who, role, when (to the second), IP, module, record id, action, and a field-level diff (old value to new value).
- Implement once as a Prisma extension or service-layer wrapper so no module can forget it. Audit rows are append-only; no API can edit or delete them.
- Every record has a "History" tab showing a timeline of all actions on it by all users, in chronological order. If several users changed the same or different fields, each change appears as its own entry.
- A global Activity Log page for Super Admin with filters by user, module, action and date range, and export.
- Optimistic locking with a `version` column: if two users edit the same record at once, the second save is refused with a clear message showing what changed, never a silent overwrite.

### 2.3 Soft delete and recovery

- Nothing is ever physically deleted through the app. All tables carry `deletedAt`, `deletedBy`, and `deleteReason`. Default queries exclude deleted rows through one shared mechanism.
- A Recycle Bin page (Super Admin and developer role) lists deleted records per module with who deleted them and when, with one-click restore. Restore is audited.
- Uploaded files are versioned, never overwritten; replacing a document keeps the previous file in history.
- Financial records (loan entries, salary sheets, payments) are never edited after posting. Corrections are made with a reversing entry that references the original.

### 2.4 Notifications

- One notification service with three channels: in-app (bell icon, real time through Socket.IO), email, and a pluggable slot for WhatsApp or SMS later.
- Events are published by modules (`loan.submitted`, `document.expiring`, `salary.generated`); recipients and channels are resolved from a configurable rules table, so new events need no changes to the notification code.
- Users have a notification centre with read and unread state, and per-channel preferences.

### 2.5 Extensibility engine

- **Custom fields:** Super Admin can add extra fields (text, number, date, dropdown, file) to employee, vehicle and other master records from the UI; stored in JSONB with a field-definition table and validated on the server.
- **Lookup tables managed from the UI:** zones, client platforms, document types, merchandise items, expense types, loan purposes, status reasons. Never hard-code these lists.
- **Report builder base:** every report is a registered definition (data source, columns, filters, grouping, permissions). A shared report page renders any definition with filters, totals, charts, and Excel and PDF export. Adding a report means adding one definition file.
- **Generic approval workflow engine:** configurable ordered steps, each assigned to a role or named users, with approve, reject, send back, comments and notifications. The loan application flow uses it; leave it reusable for leave requests, expenses and others.
- **Single source of truth:** all modules reference the employee, vehicle and client records by id. A name, phone number or Falcon ID is edited in one place and appears updated everywhere.

### 2.6 Ten-year design rule

The platform must run for 5 to 10 years without a redesign of its database or structure. Apply one rule everywhere: **anything the business may change is data or configuration, never code or schema.** A new form, field, report, pay component, fee, approval chain, document type, client platform, branch, company, currency, language, message template or printed document must be addable from the admin screens. Schema changes are reserved for genuinely new engines, are additive only, and never break existing data. Sections 2.7 to 2.13 are mandatory parts of Phase 1 and 2, even where the first release uses only a fraction of them.

### 2.7 Companies, branches and tenancy

- Build multi-tenant from the first migration. Hierarchy: Tenant (a customer of the software) > Company (legal entity) > Branch or office > Team or zone. The first release has one tenant and one company, but every business table carries `tenant_id` and `company_id` (and `branch_id` where it applies).
- Enforce isolation in the database with PostgreSQL Row-Level Security driven by the session's tenant, in addition to application checks. A missing filter in code must not be able to leak another company's data.
- Per-company settings: legal name, logo, letterhead, base currency, time zone, country, working week, financial year, numbering sequences, enabled modules (feature flags), and branding. Users can belong to several companies with a different role in each, and switch between them.
- Consolidated reporting across companies and branches for the owner, with inter-company loans and transfers recorded on both sides.
- Keep the door open to offering the software to other supply companies later: tenant onboarding, subscription plan and usage limits tables exist from day one, even if unused.

### 2.8 Universal party model

- One `party` table holds every person and organisation exactly once. Roles are attached to it: employee, rider, driver, candidate, borrower, investor, recruiting agent, vehicle owner, landlord, payee, supplier, client platform, guarantor, emergency contact.
- A party can hold several roles at the same time and over time (a rider who is also a vehicle owner and a borrower; a candidate who becomes an employee and later an ex-employee). Role periods are dated.
- All modules reference `party_id`. Platform identifiers (Falcon ID, Talabat ID, Keeta ID) live in a `party_identifier` table (type, value, platform, valid from and to), so a person can hold many IDs and an ID can move between people with full history. This is what makes "ID operated by another person" in 3.3 traceable.
- Duplicate detection on QID, passport, phone and name similarity, with a guided merge tool that preserves history.

### 2.9 Financial core: one ledger behind every module

- Implement a double-entry general ledger in Phase 2, before any money module. Tables: chart of accounts (editable tree), journal, journal line, fiscal period, currency, exchange rate.
- No module writes balances of its own. Loans, salary, vehicle rent, deposits, COD, fines, merchandise fines, investor capital, client invoices and expenses all post balanced journal entries through one posting service. A **posting-rules table** maps each business event (for example `loan.disbursed`, `payroll.posted`, `rent.paid`) to debit and credit accounts, so accounting treatment can change without code.
- Every journal line carries analysis dimensions: party, employee, vehicle, client platform, branch, cost centre, pay period, source document. Sub-ledgers (a rider's loan balance, a vehicle's cost, a platform's margin) are queries over these lines, which guarantees every report agrees with every other report.
- Journals are immutable. Corrections are reversing entries. Fiscal periods can be closed and locked; a locked period refuses new postings.
- Multi-currency from day one: every amount is stored with its currency code, exchange rate and base-currency amount. Use `NUMERIC(18,4)`. QAR is the default base currency; BDT and others are available for remittances and future countries.
- Cash and bank accounts, bank statement import with matching rules, and reconciliation are part of the core (used by 4.6 and 5.9).

### 2.10 Dynamic engines (configuration instead of code)

Build these as generic services with admin screens. Core modules must use them too, not bypass them.

- **Entity and form builder:** beyond custom fields, an administrator can define a whole new record type (name, fields, validations, relations to party, vehicle or any entity, list columns, form layout, permissions, numbering). The system generates the list page, form, detail page, history tab, import, export and API for it automatically. Data is stored in typed JSONB with JSON Schema validation and GIN indexes. Provide a documented path to promote a hot custom field to a real indexed column later.
- **Rules and formula engine:** pay components, deductions, fines, commissions, client billing rates, cost allocations, loan interest, eligibility rules and alert conditions are expressed as formulas in a sandboxed expression language (for example CEL or JSONLogic; never `eval`). Formulas are versioned with effective dates, testable against sample data in the admin screen, and every calculated figure can show "how was this calculated".
- **Workflow engine:** steps, parallel and conditional branches, amount thresholds, delegation during leave, deadlines with escalation, and reminders, attachable to any entity including custom ones.
- **State machines:** allowed statuses and transitions for each entity are configuration, with required fields and permissions per transition.
- **Template engine:** every printed or sent document (loan paper, pay slip, handover slip, invoice, letters, emails, WhatsApp messages) is an editable template with merge fields, per language and per company, versioned. Generated documents store the template version used.
- **Automation builder:** "when this event happens, if these conditions hold, do these actions" (notify, create task, start workflow, set field, call webhook), configured without code.
- **Report and dashboard builder:** extends 2.5. Users with permission build reports from a governed semantic layer (named measures and dimensions defined once), save them, schedule them by email, and place them as dashboard widgets.
- **Service request catalogue:** any request a worker or staff member can raise (loan, leave, salary certificate, NOC letter, vehicle problem, salary query, ID issue) is a catalogue item = dynamic form + workflow + template. The loan application in 4.5 is the first item, not a special case.
- **Effective dating everywhere:** rates, terms, assignments, prices, rules and organisational placement use `valid_from` and `valid_to`, so any past month can be recomputed exactly as it was.

### 2.11 Integration layer

- **Domain events with a transactional outbox:** every state change publishes a named, versioned event in the same database transaction. Notifications, automations, webhooks, search indexing and analytics consume events; modules never call each other's tables directly.
- **Public API:** versioned REST API (`/api/v1`) documented with OpenAPI, with API keys and OAuth2 scopes per integration, rate limits, idempotency keys on all write endpoints, and signed webhooks with retries and a delivery log. The web app uses the same API, so nothing is possible in the UI that an integration cannot do.
- **Adapter interfaces** with one implementation each at launch and room for more: client platform data (sheet, file, API), bank and payroll files, messaging (email, WhatsApp, SMS, push), OCR, LLM, e-signature, object storage, maps and telematics, accounting software, identity provider.
- **Generic import and export:** any entity, including custom ones, can be imported from Excel or CSV with saved column mappings, a validation preview and a rollback, and exported in bulk.

### 2.12 Data architecture for long life

- Primary keys are UUIDv7. Every table has `tenant_id`, `company_id`, created and updated by and at, `version`, and the soft-delete columns from 2.3. Human-readable numbers (`L0001`, invoice numbers) are separate sequence-generated columns per company.
- Partition high-volume tables by month from the start: daily performance, audit log, events and outbox, notifications, journal lines, location or telemetry points. Add the indexes each list page and report needs, and verify query plans with a seeded dataset of 5,000 workers and 5 years of history.
- Keep every raw input forever in object storage with a checksum: each sheet snapshot, uploaded Excel, bank file, and received webhook. Any derived data can be rebuilt from raw inputs when rules change.
- A separate read-only reporting schema (materialised views or a star schema refreshed by jobs) feeds heavy reports, BI tools and the AI assistant, so analytics never slows down operations. Support a read replica.
- Migrations follow expand-then-contract and run with zero downtime. No destructive migration without an archived copy. Maintain a living data dictionary generated from the schema.
- Search through PostgreSQL full-text and trigram indexes behind a search interface, replaceable by OpenSearch later without touching modules.
- Archival and retention policies per entity are configuration: data past its retention is archived or anonymised by a scheduled job, never by hand.

### 2.13 Modular monolith and plug-in modules

- One deployable application, strictly divided into modules. A module owns its tables and exposes a typed service interface and events; importing another module's internals is blocked by lint rules. This keeps the system simple to run now and lets any module be split into its own service later without a rewrite.
- Each module registers itself through a manifest: routes, permissions, menu items, events, report definitions, dashboard widgets, settings, automation triggers and actions. Adding a module means adding a folder and a manifest, with no edits to the core.
- Modules can be switched on or off per company with feature flags, which also allows safe gradual rollout of new features.

## 3. Core modules, part A

### 3.1 Client sheet sync and performance reports (Snoonu first)

Snoonu owns a Google Sheets daily report and has given the company's Google account viewer access. The app must read it and never attempt to write to it.

- A scheduled job runs every day at **04:00 Asia/Qatar**. It reads the sheet through the Google Sheets API (read-only scope), stores a raw snapshot of the rows for that day, then normalises them into `daily_performance` rows linked to employees by Falcon ID.
- Column mapping is configurable from an admin screen (sheet column to system field), because Snoonu may rename or reorder columns. Unknown columns are kept in JSONB, not dropped.
- The job is idempotent (re-running a date replaces that date's data, with history), retries on failure, logs each run (rows read, matched, unmatched, errors), and alerts admins if the sheet is unreachable, empty, or the layout changed. A "Run now" and "Re-import date range" button exists for admins.
- Falcon IDs in the sheet that match no employee go to an "Unmatched riders" queue for staff to link or create.
- **Report 1, Daily:** for yesterday, per rider and overall: orders completed, login time, minutes late against shift start, working hours, average working hours, online time, acceptance and cancellation figures, and every other metric the sheet provides. Include top and bottom performers, absentees (in master data but no activity), zone-wise and rider-versus-driver breakdowns, and comparison with the previous day.
- **Report 2, Monthly:** the same metrics aggregated month to date and for any chosen month: totals, averages, days worked, late-login count and total late minutes, trend charts, and per-person drill-down to daily rows.
- After the 04:00 run, email a summary of the daily report to a configurable recipient list and show it on the dashboard.
- Design the importer as a `ClientReportAdapter` interface with a Snoonu implementation, so Keeta and Talabat adapters (sheet, Excel upload or API) can be added later. Performance data is stored per platform so orders and earnings can be tracked and commissions calculated per platform.

### 3.2 Employee master database and documents

This is the single source of truth for every person. All other modules read from it.

- Profile fields: full name (English, and optional Arabic or Bangla), photo, Falcon ID and other platform IDs, profession (Rider or Driver), client platform, zone, nationality, date of birth, QID number, passport number, phones, WhatsApp, email, emergency contact, address or accommodation, joining date, sponsorship (company sponsored or outside sponsor), recruiting agent, bank or wallet details, status, and custom fields.
- Standard document types, each with file upload (PDF or image, multiple pages), document number, issue date and **expiry date**: Qatar ID, driving licence, vehicle Istimara, passport copy, food handling certificate, health card, insurance, and agreement copy (required when the worker is not under company sponsorship).
- **Custom documents:** an "Add other document" control where the user types a document name, uploads the file and optionally sets an expiry date. No code change is needed for new document types.
- Document expiry engine: a daily job finds documents expiring within configurable windows (default 30, 14 and **7 days** before, on the day, and overdue). At 7 days it emails the company email list a consolidated table (employee, document, expiry date, days left), raises in-app alerts, and shows an expiry calendar and a colour-coded expiring-soon list. The same engine covers vehicle documents and company-level documents (trade licence, office lease, contracts).
- Each profile page shows tabs fed by other modules: documents, tracking status, performance, issued merchandise, vehicle, rates and charges, loans and advances, salary sheets, history.
- Bulk import of employees from Excel with a validation preview, and a missing-documents report.

### 3.3 Daily tracking (morning call sheet)

Each morning office staff call every rider and driver and record who is working.

- The page lists everyone with name, Falcon ID, zone, profession and contact number, pulled from the synced Snoonu data and master database (not typed again). Include click-to-call and WhatsApp links.
- **Status dropdown:** Active, Inactive, Blocked, Terminated. For Inactive, Blocked or Terminated a reason is mandatory, and the effective date is saved and displayed.
- **Who is working the ID dropdown:** "Owner himself" or "Another person". If another person: that person's name (linkable to an employee record), contact, the date they took over the ID, the COD amount outstanding at handover, and the number of orders on the ID at handover.
- Selections save inline immediately and appear in the same row next to the other details, with no page reload. Staff can add a call note and a call outcome (answered, no answer, switched off).
- Every change is kept as a dated status history per person; nothing is overwritten. The page shows today's view by default and can show any past date.
- Summary strip at the top: counts of Active, Inactive, Blocked, Terminated, IDs operated by someone else, and not yet called today. Filters by zone, profession, status and caller.
- Cross-check: flag people marked Active who had no orders yesterday in the sheet, and people marked Inactive who did.

### 3.4 Merchandise and inventory

Snoonu issues equipment to the company, which issues it to workers.

- Item catalogue managed from the UI. Seed with: T-shirt, pants, thermal bag, helmet, chest guard, gloves, safety guard, delivery box, vest, jacket. Support sizes where relevant.
- Stock ledger with movement types: received from Snoonu, issued to employee, returned by employee, lost, damaged, returned to Snoonu, manual adjustment. Current stock is always calculated from the ledger.
- Issue screen: pick employee, items, sizes, quantities, date; produces a printable handover slip for signature, and the signed copy can be uploaded.
- Loss tracking: record a lost item against an employee with date and note, whether a fine was charged, the fine amount, and whether it will be deducted from salary (creates a deduction entry for the payroll module).
- Report page, with a **reconciliation summary at the top**: for each item, quantity received from Snoonu versus quantity the company can account for (in office stock + with employees + recorded lost or damaged + returned to Snoonu), with any difference highlighted.
- Below the summary: current office stock per item with low-stock warnings, who holds what, full movement history, and per-employee holdings (used at exit clearance).

## 4. Core modules, part B

### 4.1 Fleet (bikes and cars)

- Vehicle register: type (bike or car), make, model, year, colour, plate number, chassis number, owner (company, a named third party, or the worker himself), ownership or rental terms, Istimara expiry, insurance expiry, status (in use, idle, in workshop, sold or returned), photos and documents.
- Assignment history: who is using the vehicle, from which date, to which date. A vehicle has one current user; reassigning closes the previous period automatically. The list shows current user and "using since" date.
- Istimara and insurance expiry use the shared expiry alert engine. Maintenance log with date, odometer, work done, cost, workshop, and next service due by date or kilometres, with alerts.
- Traffic fines log per vehicle, automatically attributed to the person assigned on the violation date, with optional salary deduction.
- **Monthly rent and service charge ledger**, driven by the register: for each vehicle and month, the rent amount and service charge, **who it is paid to** (payee), payment date, method, reference, status (due, paid, partial), and receipt upload. A "Generate this month's dues" action creates entries for all active vehicles from their agreed terms. Reports by month, by vehicle and by payee, with outstanding totals.

### 4.2 Rates, charges and company-borne costs

One commercial profile per employee, with effective dates so past months stay correct when terms change.

- Order rate paid to the person (per order, with optional slabs or different rates per platform or vehicle type).
- Office charge taken from the person (fixed monthly amount, per order, or percentage).
- Company-borne expenses: a list per person of expense type (for example visa, accommodation, fuel, vehicle rent, insurance) and amount, one-time or monthly.
- Company SIM: whether the person uses a company SIM, the SIM number, plan, and monthly bill amount; a monthly SIM bill entry screen and a list of all SIMs with holders.
- A list view shows all of this for everyone on one screen with filters and export. The payroll module reads these values; they are never retyped in salary files.

### 4.3 Loans and advances

- Each borrower has one running ledger made up of individually numbered loans (see 4.6 for loan-level rules). Every transaction is a row: date, type (loan given, salary deduction, cash repayment, negative-salary carry-over, adjustment), amount, purpose, entered by, linked document, and running balance.
- The report shows each person's **total outstanding** and, on drill-down, the complete history: how much was given on which date and for what purpose, and every recovery.
- Giving a new loan is a two-step process:
  1. Enter employee, amount, purpose, repayment plan (monthly instalment or free). The system generates a **loan paper** (print-ready A4 PDF with company letterhead) showing employee details, previous outstanding balance, new amount, purpose, new total balance, repayment terms, date, and signature blocks for the borrower and the authorised officer. The entry is saved as "Awaiting signature".
  2. After the borrower signs the printout, the user uploads a photo or scan of the signed paper. Only then is the loan posted to the ledger. The signed image stays attached to that entry permanently.
- Posted entries cannot be edited or deleted; corrections use reversing entries.

### 4.4 Salary sheet portal

- The user uploads one Excel file per month (template downloadable from the portal). Column mapping is configurable and remembered. Expected columns include Falcon ID or employee code, name, orders, earnings, allowances, each deduction type, and advance deduction.
- On upload the system shows a validation preview: unmatched people, missing or invalid values, duplicate rows, advance deduction larger than the outstanding balance, and totals. Nothing is posted until the user confirms.
- On confirmation, a background job creates an **individual salary sheet (payslip) per person** in the file: earnings, each deduction line, advance deducted, net payable, with a PDF per person, a combined PDF, and a summary sheet for the month.
- **Advance deduction:** the amount deducted is posted to that person's loan ledger as a recovery, reducing the outstanding balance, with the note "Deducted from salary of \[Month Year\]" and a link to the payslip.
- **Negative salary:** if a person's net salary is below zero, the payslip shows net payable as 0 and the negative amount is posted to their ledger as a new advance, noted "Negative salary carried over from \[Month Year\]".
- Posting a salary run is one database transaction: all payslips and ledger entries succeed together or none do. A run can be reversed as a whole (with audit and reversing ledger entries) but not edited row by row after posting. Uploading the same month twice is blocked unless the earlier run is reversed.
- Payslip status: generated, approved, paid, with payment date and method. Riders and drivers can view and download their own payslips in their portal.

### 4.5 Loan application workflow (rider and driver portal)

Riders and drivers log in to a simple mobile-first portal showing their profile, documents and expiry dates, issued items, loan balance and history, payslips and notifications.

1. The worker submits a loan application: amount, purpose, preferred repayment. The form shows his current outstanding balance.
2. **Step 1, review:** the application goes to Admin and to any users Super Admin has given the "loan review" permission. Any one of them can accept, reject or send back with a comment.
3. **Step 2, owner approval:** accepted applications go to the company Owner, who can approve (optionally changing the amount), reject or send back.
4. **Step 3, manager disbursement:** approved applications go to the Manager, who generates the loan paper, collects the signature, uploads the signed copy and marks it disbursed. This posts the loan through the same process as 4.3.

The worker sees a live status tracker (Submitted, Under review, Awaiting owner, Approved, Disbursed, or Rejected with reason) and a timeline of who acted and when. Every step sends in-app and email notifications to the next approver and to the applicant. Build this on the generic workflow engine so the steps and approvers are configurable. Send a reminder if a step is pending for more than a configurable number of hours.

### 4.6 Loan fund, investors and cash book

The company currently runs its loans in an Excel workbook ("Loan Management System v7": sheets Dashboard, Borrower Details, Loans, Payments, Borrowers, Investors, Investor Ledger, Data Check). This module must replace that workbook completely and extends 4.3. Where 4.3 and this section differ, this section wins.

**Loan-level records**

- Every loan is its own record with a permanent, system-generated ID (`L0001`, `L0002`, continuing from the highest imported ID), never typed by hand and never reused.
- Loan fields: date, borrower, principal, monthly interest % (default 0), term in months (default 0 = open-ended), purpose category (lookup list) plus free-text note, and attachments.
- Calculations, matching the workbook: flat interest = principal x monthly % x term; total payable = principal + interest; due date = loan date + term months (one month when term is 0); paid so far = sum of payments allocated to the loan; balance = total payable - paid.
- Status is derived, never typed: Paid (balance 0), Overdue (past due date), Due soon (within 7 days), Open (no term), Active. Due-soon and overdue loans raise notifications.
- A manual discount or write-off on a loan is a separate, permission-controlled, audited entry with a reason, not an edit of the total.

**Borrowers who are not riders or drivers**

- A borrower is a "party" of one of these types: Employee (linked to the master database by Falcon or Snoonu ID), Office staff, External person or business, or the Company itself (used when the fund pays a company expense such as lunch, SIM bills or agreement fees, so the fund can see what the company owes it).
- The loan paper and signature step in 4.3 is mandatory for Employee and External borrowers and optional for Company entries. The rider loan application workflow in 4.5 creates Employee loans here.

**Payments**

- One row per payment: date, loan, amount, method (Cash, Bank, bKash, Other; list editable), note, receipt upload. The loan picker shows only open loans with their balance due.
- A payment can be allocated to one chosen loan, or entered against the borrower and auto-allocated oldest loan first, splitting across loans if needed. Salary deductions from 4.4 use the automatic rule and carry the note "Cut from \[Month\] salary".
- The system blocks: overpayment beyond the balance, a payment dated before its loan, a payment without a loan, and duplicates (same date, borrower and amount asks for confirmation).

**Investors and fund capital**

- Investor register (name, phone, notes) and an investor ledger with Deposit and Withdraw entries (date, amount, note, attachment).
- Per investor: total deposited, total withdrawn, net capital, share % of total net capital, last deposit date, and estimated profit share (share % x total interest of all loans, pro-rata by net capital).
- Investor data is visible only to roles with the "fund" permission. An investor can optionally be given a read-only login to see his own ledger and the fund summary.

**Cash book**

- A fund cash book derived from the ledgers: investor deposits and loan repayments are money in; loans given, investor withdrawals and fund expenses are money out. Cash in hand = net investor capital - total loans given + total collected - expenses, shown with a running balance and filterable by date.
- Support separate cash locations (for example hand cash, bank, card) with transfers between them, and a simple petty-cash entry screen (collection with source, cost with reason) for small movements that are not loans.
- A periodic cash count screen: the user enters the physically counted amount and the system records any difference with a note.

**Fund dashboard and reports**

- Cards: net investor capital, total loan given, total collected, total outstanding, cash in hand, borrowers with due, overdue loans (count and amount), collected in the last 30 days, collection rate (collected / total payable).
- Borrower table: loans count, principal, interest, total payable, paid, balance, status; clicking a borrower opens his detail page with summary, full loan history and full payment history.
- Reports: outstanding by borrower and by purpose, ageing of open loans, monthly given versus collected, recoveries by method, investor statement, cash book statement. All through the shared report engine.

**Import of the existing workbook**

- A one-time import tool reads the workbook: 86 borrowers, 139 loans, 74 payments, 3 investors and 11 investor-ledger rows at the time of writing. Existing loan IDs and dates are preserved.
- Borrowers are matched to employees by Snoonu ID; those without an ID (14 at the time of writing) are shown for manual matching or creation as External or Company parties.
- Payments are linked by the loan ID in the workbook's "Select Loan" label. After import, the system must show the same totals as the workbook dashboard (loan given, collected, outstanding, net capital, cash in hand) on a reconciliation screen before the import is confirmed.
- Imported entries are marked "Imported" and are exempt from the signed loan paper requirement.

### 4.7 Payroll processing and profit and loss (replaces the existing Fibrex Payroll app)

The company already uses a small in-house app ("Fibrex Payroll & Profitability Management System": React + Vite + Tailwind, Express, PostgreSQL) to turn the monthly salary Excel into pay slips and to see profit and loss. This module must do everything that app does, inside the new platform, and fix its limits. It extends 4.4; where they differ, this section wins.

**What the existing app does (keep all of it)**

- Upload an Excel or CSV salary file by drag and drop; one salary record per Falcon Flex ID.
- Searchable salary table (Falcon Flex ID, name, type, orders, earnings, deductions, final payout, status) with View, Download PDF, Edit and Duplicate actions.
- "Create Salary Sheet" to add one person by hand without a file.
- Edit screen grouped as Basic Information, Orders & Earnings, Deductions, with live recalculation on save.
- Custom earnings and custom deductions per person: any number of lines, each with a reason and amount, shown on the pay slip marked "(Exceptional)".
- Status per sheet: Draft, Generated, Approved.
- Pay slip with company logo, employee details, per-order rate, earnings and deductions tables, net payable amount, and three signature blocks: HR, Company Chairman, and Receiver's signature and fingerprint.
- Profit and loss page: order-margin revenue, office charges, work permit fees, total revenue, company expenses by category, net profit or loss, and an expense entry form.

**Salary file columns (the real monthly file)**

Falcon Flex ID, Name, Driver/ Rider, Online Orders, Per Order Rate, Order Allowance, Bonus Orders, Bonus AMT, Special Bonus, COD, Adjustments Plus, Adjustments Minus, Positive COD - Terminated Only, Extra KMS, Extra KMS Amount, Bills, Advance cut, Sim Bill, Work Permit, Office Charge, Quality Violations, Previously Adjusted COD, Total Unpaid COD, TOTAL ERNINGS, TOTAL DEDUCTION, FINAL PAYOUT. Accept the misspellings in the file ("ERNINGS", "Work Parmit") and header variations through the configurable column mapping.

**Calculation rules**

- Order allowance = online orders x per-order rate. The rate comes from the file if present, otherwise from the person's commercial profile (4.2), otherwise the default (driver 14, rider 10 QAR). A typed allowance overrides the calculation and is flagged.
- Total earnings = order allowance + bonus amount + special bonus + COD + adjustments plus + positive COD (terminated only) + extra KMs amount + custom earnings.
- Total deduction = advance cut + SIM bill + work permit + office charge + quality violations + previously adjusted COD + total unpaid COD + custom deductions.
- Final payout = total earnings - total deduction. All totals are recomputed by the server; totals typed in the file are only compared, and any difference is shown in the upload preview.
- **Confirm before coding:** the Excel formulas above add "COD" to earnings and leave "Bills" and "Adjustments Minus" out of the deduction total, while the old app treats "COD" as unpaid COD (a deduction) and deducts "Bills" and "Adjustments Minus". Build the rule set as configuration (each component is flagged earning, deduction or information-only) and ask the business which treatment is correct for these three columns.
- Pay components are a managed list, so a new earning or deduction column can be added from the UI without code or schema changes.

**Limits of the old app that the new module must fix**

- **Pay periods:** the old app has no month; uploading a new file overwrites last month's record for the same Falcon ID. Every salary record must belong to a pay period (month and year, per client platform), and all past periods stay viewable.
- **Linked to master data:** salary records reference the employee record, not a typed name. "Duplicate" must create a second sheet for the same employee and period with a label (for example a second ID or a split month), not an invented Falcon ID.
- **Deductions flow to their ledgers:** advance cut posts to the loan ledger (4.3, 4.6); SIM bill reads from the SIM register (4.2); office charge and company-borne costs from the commercial profile (4.2); unpaid COD and COD taken over with an ID from tracking (3.3); fines for lost items (3.4) and traffic fines (4.1) arrive as suggested deduction lines. Suggested values pre-fill the sheet and the user can override with a reason.
- **Rates are data, not environment variables:** client rate per order (currently driver 18, rider 14 QAR) and pay rate (driver 14, rider 10 QAR) are stored per platform and profession with effective dates and edited from settings.
- **Access control and history:** every edit, custom line, status change and deletion follows the permission, audit and soft-delete rules in section 2. Approved sheets are locked; changing one requires re-opening by a permitted role with a reason.
- **Bulk actions:** approve all, download all pay slips as one PDF or a ZIP, export the period summary to Excel, and mark paid with date and method.
- **PDF quality:** generate pay slips on the server as real text PDFs (not screenshots), A4, with logo, period, pay slip number and the three signature blocks.

**Profit and loss**

- Revenue per period = sum over employees of (client rate - pay rate) x online orders, plus office charges, plus work permit fees, plus any other income lines entered. Use each person's actual pay rate for the period, not only the default.
- Company expense register: date, category (managed list, seeded with Office Rent, Utility, Government Fees, Marketing, Other), purpose, amount, paid from (cash location in 4.6), receipt upload. Vehicle rent (4.1), accommodation (5.4), SIM bills and company-borne employee costs (4.2) feed in automatically so nothing is entered twice.
- Report by month, quarter and year, with comparison to the previous period, breakdown by platform and by driver versus rider, expenses by category, and net profit or loss. The old app totals all time in one figure; the new report must always be period-based.

**Migration**

- Import existing records from the old app's PostgreSQL tables (`employee_salaries`, `exceptional_costs`, `exceptional_earnings`, `company_expenses`) into a pay period chosen at import, matching employees by Falcon Flex ID.

## 5. Additional modules

### 5.1 Central overview dashboard

- One screen, built from live data, with widgets shown according to the viewer's permissions: total workforce by status, profession, platform and zone; yesterday's orders and average working hours; today's tracking progress; documents expiring in 7 and 30 days; total outstanding loans; pending loan applications waiting for the viewer; vehicle dues this month; merchandise discrepancies; onboarding pipeline counts; outstanding agent deposits; monthly cost and income trend.
- Every number is clickable and opens the filtered list behind it. A collapsible sidebar gives one-click access to each module. Include a global search (Ctrl+K) across employees, vehicles, Falcon IDs and plate numbers.

### 5.2 Onboarding pipeline

- A Kanban board and list view for candidates moving through configurable stages. Default stages: Interview, Visa application, Medical, Ticket, Arrival, QID application, Driving school enrolled, Driving test passed, Platform ID created, Active.
- Each card shows the candidate, agent, days in the current stage, and missing items. Moving a card records the date and user. Stages have target durations; candidates stuck beyond the target are highlighted.
- When a candidate reaches the final stage, convert him to an employee record in one click, carrying over all data and documents.

### 5.3 Recruiting agents and deposits

- Agent register with contact details and the list of workers each agent supplied.
- Security deposit tracking per worker and per agent: amount agreed, received, outstanding, refund due date, refunds paid, with payment history and receipts. Summary of total received and total outstanding per agent.

### 5.4 Accommodation and cost allocation

- Register of accommodations (building, room, capacity, monthly rent, landlord, lease expiry) and who lives where, with move-in and move-out dates.
- Monthly rent and utility bills are entered per accommodation; the system divides the cost by actual occupancy for that month (pro-rated by days stayed) and shows the cost per person. Each person's share is either company-borne or passed to payroll as a deduction, according to his commercial profile in 4.2.

### 5.5 Platform performance and commission

- Orders and earnings tracked per person per platform (Snoonu, Talabat, Keeta, and others), fed by the adapters in 3.1.
- Company income per platform is calculated from the client rate; worker pay from the order rate in 4.2; the margin per person, per platform and per month is reported.

### 5.6 AI assistant connected to live data

- A chat panel where permitted users ask questions in plain English or Bangla, for example "How many riders were inactive yesterday in Al Sadd?", "Whose QID expires this month?", "What is Rahim's loan balance?".
- Implement with LLM tool calling over a fixed set of **read-only, parameterised query functions** (for example `getEmployees(filters)`, `getExpiringDocuments(days)`, `getLoanBalance(employeeId)`, `getPerformance(dateRange, filters)`). The model must never generate or run raw SQL.
- Every tool call runs with the asking user's permissions, so the assistant cannot reveal data the user cannot see in the normal screens. Answers show the figures with a link to the underlying list. All questions and tool calls are logged in the audit trail.
- Keep the LLM provider behind an interface with the API key in environment configuration.

### 5.7 Client contracts, invoicing and receivables

This is the income side of the business and must reconcile to the last riyal.

- Contract register per client platform: parties, start and end dates, renewal alerts, and a rate card with effective dates (rate per order by profession, vehicle type, zone or slab; bonuses; penalties; fixed fees; minimum guarantees). Rates are formulas in the rules engine, not columns.
- For each billing period the system computes **expected revenue** from the imported performance data and the rate card, per worker and in total, and produces a client invoice or statement from a template with a numbered sequence.
- Import the client's own payout statement (Excel, PDF data or API) and reconcile line by line: orders counted, rate applied, bonuses, penalties, COD adjustments. Differences are listed per worker with the reason and the amount, and can be raised as a dispute with status tracking until resolved.
- Receivables: invoiced, received, outstanding, ageing by client, expected payment date, and bank receipt matching. Client penalties and quality deductions can be passed on to the responsible worker as suggested payroll deductions.
- Margin report per client, zone, profession and worker: client revenue minus worker pay minus directly attributable costs (vehicle, SIM, accommodation, visa).

### 5.8 Automatic payroll engine

Payroll must be computable without any Excel file. The upload in 4.4 and 4.7 remains as a verification source and for manual overrides.

- Pay components are defined in the rules engine: each has a type (earning, deduction, employer cost, information), a formula, a data source, an order of calculation, a ledger account, and effective dates. Seed the list with every column in 4.7.
- For a pay period the engine gathers inputs automatically: orders and bonuses from performance data (3.1), per-order rate and office charge from the commercial profile (4.2), SIM bill, vehicle rent and traffic fines (4.1), accommodation share (5.4), merchandise fines (3.4), unpaid COD (3.3 and client statements), loan instalment (4.6), client penalties (5.7), and approved one-off items.
- Run stages: Draft (calculated) > Reviewed > Approved > Posted > Paid. A run can be recalculated any number of times until approved. Each pay slip shows the formula and inputs behind every line.
- **Three-way check before approval:** engine result versus uploaded Excel versus client statement, with differences per person and per component. Nothing is approved while unexplained differences remain above a configurable tolerance.
- Rules for minimum take-home, maximum deduction per month, and priority order of deductions when earnings are insufficient; anything not recovered is carried forward automatically to the correct ledger.
- Off-cycle runs (final settlement, bonus, correction), retroactive adjustments when a past rate changes, and simulation ("what if the rider rate becomes 11").

### 5.9 Salary payment, WPS and bank files

- After a run is approved, create payment batches by method: bank transfer through Qatar's Wage Protection System, other bank transfer, cash, mobile wallet. One person's pay can be split across methods.
- Generate the WPS salary information file exactly to the current official specification supplied by the company's bank, plus bank bulk-transfer files. File layouts are configurable templates so a change of bank or format needs no code. Validate QID, IBAN and required fields before a file can be produced.
- Cash payments produce a signature sheet and individual receipts; the worker confirms receipt in the app (5.10).
- Import the bank's result or statement file, mark each payment paid, failed or returned, and reconcile the batch. Failed payments return to a queue.
- Bank details are verified once (document upload and approval) and any later change needs a second person's approval.

### 5.10 Rider and driver mobile app

- Deliver the worker portal as an installable Progressive Web App with push notifications, working on low-end Android phones and slow connections. Forms and uploads queue while offline and send when the connection returns. Structure the API so native Android and iOS apps can be added later without backend changes.
- Languages: English, Bangla, Arabic (RTL), Urdu, Hindi and Nepali, switchable per user. Large touch targets and icon-led navigation for users who read little.
- Login by phone number with one-time code as well as password; optional device biometrics.
- Features: profile and documents with expiry countdown, take a photo to renew a document, pay slips, loan balance and applications, issued items, vehicle and its documents, daily and monthly performance, notices, service requests (2.10), incident reporting with photos and location, and a help chat.
- **Electronic signature:** loan papers, handover slips, policy acknowledgements and cash receipts can be signed on the phone (drawn signature plus one-time code). Store signer, time, IP, device, location if permitted, and a hash of the signed document, and stamp them on the final PDF. Paper signing with upload remains available.
- Optional daily check-in ("I am working today") that pre-fills the morning tracking page in 3.3, leaving calls only for those who did not respond.

### 5.11 Messaging: WhatsApp, SMS and broadcast

- Implement the WhatsApp Business Platform and an SMS provider as channels of the notification service in 2.4, using approved message templates per language, with opt-in records, delivery and read status, and a per-person message history.
- Broadcasts to a filtered group (zone, platform, status, expiring documents) with scheduling and a preview of recipients and cost.
- Two-way: a worker can reply with a document photo or a simple answer (for example "1 = working, 2 = off"), which is attached to the right record. Unrecognised replies go to a shared staff inbox.
- Channel fallback order is configuration (push, then WhatsApp, then SMS, then email).

### 5.12 Document intelligence (OCR)

- When a document is uploaded, extract the document type, number, holder name, issue and expiry dates through the OCR adapter, including Arabic text, and pre-fill the form. Show a confidence level per field; the user confirms before saving. Low-confidence or mismatched results (name on the document differs from the profile) are flagged.
- Detect expired, unreadable, cropped or duplicate documents at upload.
- Bulk upload: drop a folder of scans and let the system sort them to the right person and document type for staff to confirm.

### 5.13 Exit clearance and final settlement

- Starting an exit (resignation, termination, transfer to another sponsor, absconding, end of contract) opens a clearance checklist built on the workflow engine, with one task per department.
- The system gathers everything outstanding for the person in one screen: loan and advance balance, unpaid COD, issued merchandise not returned, vehicle and its condition, traffic fines, SIM card, accommodation, security deposit, unpaid salary and pending client penalties.
- It calculates a final settlement (amount payable to or recoverable from the worker) through an off-cycle payroll run, produces a settlement statement and clearance certificate for signature, and posts the entries.
- Platform IDs are flagged for deactivation with the client, system access is revoked on the last day, and documents are retained according to the retention policy. Rehire eligibility and the exit reason are recorded for analytics.

### 5.14 Risk, fraud and anomaly detection

- A rules-based risk engine (rules are configuration in the rules engine) evaluates events and nightly snapshots. Seed rules: unpaid COD above a threshold or rising for several days; ID operated by someone other than its owner; orders falling sharply against the person's own average; active status with no orders, or orders while marked inactive; repeated late logins; loan requests soon after a previous loan; deductions exceeding earnings for consecutive months; documents expired while still working; the same phone, bank account or device used by several workers; edits to approved financial records; unusual activity by a staff user (mass export, off-hours changes).
- Each worker has a risk score with the contributing factors shown. Alerts open cases with an owner, notes, actions taken and outcome.
- Loan approval screens show the applicant's risk score, earnings trend, repayment history and a suggested safe loan limit.
- Keep model-based prediction (attrition, default, absence) as a later plug-in fed from the reporting schema; the case and scoring tables must already support scores from several sources.

### 5.15 Accounting and finance

- On top of the ledger in 2.9: trial balance, general ledger, profit and loss, balance sheet, cash flow, receivables and payables ageing, by company, branch, client platform and cost centre, for any period, with drill-down from a figure to the source document.
- Payables: supplier and payee bills (vehicle owners, landlords, garages, telecom, government fees), due dates, approvals, payment batches and recurring bills.
- Budgets per account and cost centre with actual-versus-budget reporting; month-end close checklist; opening balances import.
- Fixed asset register for company-owned vehicles and equipment with depreciation.
- Two-way sync adapter for external accounting software (start with one of Zoho Books, Odoo or QuickBooks; the interface must allow others), so the company can keep its auditor's tool while this platform stays the operational source.
- Tax fields and tax codes exist on every transaction line and default to none, so a future tax in any country is configuration.

### 5.16 Incidents, violations, leave and HR requests

- Incident and accident register: date, place, people and vehicle involved, photos, police report, insurance claim status, repair cost, liability decision and recovery from the worker if any.
- Traffic violations: import or entry, automatic attribution to the person holding the vehicle on that date (4.1), dispute, payment and recovery through payroll.
- Leave and absence: vacation, sick leave, emergency leave and exit and re-entry travel, with balances, approval workflow, passport handover record, expected return date, and automatic status change in tracking (3.3).
- Disciplinary record: warnings, client complaints, quality violations, with acknowledgement by the worker in the app.
- Letters on request (salary certificate, NOC, experience letter, bank letter) generated from templates and approved through the service request catalogue.

### 5.17 Workforce planning and capacity

- Headcount targets per client platform, zone and profession against actual active workers, with the gap fed by the onboarding pipeline (5.2) and exits (5.13).
- Forecast of workers needed and expected arrivals by week; visa quota and work permit tracking per company; vehicle availability against planned joiners.
- Shift and zone allocation where the client allows the company to schedule, with swap requests.

### 5.18 Telematics and location readiness

- Define a location and telemetry ingestion API and partitioned storage now, with no device vendor attached. When GPS trackers, a rider app location feed or a client API becomes available, it plugs in as an adapter.
- Planned uses: live map of active workers, vehicle mileage for service schedules, geofenced zone compliance, accident reconstruction, and theft alerts. Location collection must be consent-based and limited to working hours.

### 5.19 Analytics and business intelligence

- KPI catalogue defined once in the semantic layer (2.10): orders per worker per day, utilisation, late-login rate, attrition, revenue and margin per worker, cost per worker, loan exposure, collection rate, document compliance rate, onboarding lead time, vehicle cost per kilometre.
- Role-based dashboards for owner, operations, finance, HR and fleet, with targets, trends and drill-down; scheduled email or WhatsApp digests.
- Cohort views: workers by joining month, agent, nationality or zone compared on performance, retention and repayment.
- Read-only connection for external BI tools (Power BI, Metabase) on the reporting schema.

### 5.20 AI layer (extends 5.6)

- The assistant uses the same semantic layer and permission checks, answers in the user's language, shows its sources, and can produce a chart or an export.
- Action mode: the assistant may prepare actions (draft a broadcast, fill a form, create a report, propose payroll corrections) but every action is shown for human confirmation and executed through the normal API with the user's permissions and full audit.
- Proactive briefings: a daily summary for each manager of what needs attention (anomalies, pending approvals, expiring documents, unreconciled amounts).
- Document question-answering over contracts and policies; voice input for staff and workers.
- All AI features sit behind the LLM adapter with per-company on or off switches, usage and cost tracking, prompt and response logging, and no personal data sent beyond what the question needs.

## 6. Design, code quality and delivery

### 6.1 UI and UX

- Modern, clean, premium SaaS look: generous spacing, clear typography, soft shadows, rounded cards, subtle motion, light and dark themes, and a consistent design-token system (colours, spacing, radius) defined once.
- Layout: collapsible sidebar grouped by area (Overview, People, Operations, Fleet, Inventory, Finance, Reports, Administration), top bar with global search, notification bell, theme switch and user menu.
- One reusable data-table component and one reusable form system used by every module, so all screens behave the same. Inline editing where staff work fast (the tracking page).
- Always show loading skeletons, empty states with a next action, friendly error messages, confirmation dialogs for destructive actions, and success toasts. Keyboard accessible, WCAG AA contrast.
- Print-ready layouts for the loan paper, payslips and handover slips with company letterhead (logo and details editable in settings).

### 6.2 Code quality and comments

- TypeScript strict mode on both sides. Shared Zod schemas and types in `packages/shared` so frontend and backend validate identically.
- **Comment every important and complex part of the code.** Each service file starts with a header comment stating its purpose, which files and functions it depends on, and which modules depend on it. Complex functions (salary posting, ledger balance, cost allocation, sheet normalisation, permission resolution, workflow transitions) get step-by-step comments explaining why, not only what. Add JSDoc on all exported functions.
- Comments must stay truthful: explain business rules (for example "negative net salary becomes a new advance") at the place they are implemented.
- Modular folder structure, one folder per module containing its routes, controller, service, repository, validation and tests. No business logic in controllers or React components.
- Provide `docs/ARCHITECTURE.md` (with diagrams of modules and data flow), `docs/ADDING_A_MODULE.md` and `docs/ADDING_A_REPORT.md` as step-by-step guides, an ER diagram, and OpenAPI (Swagger) documentation for every endpoint.

### 6.3 Security and reliability

- Server-side permission check on every endpoint; never rely on hidden buttons. Rate limiting, Helmet, strict CORS, CSRF protection for cookie flows, input validation everywhere, parameterised queries only.
- Uploaded files: type and size validation, stored privately, served only through short-lived signed URLs after a permission check. Sensitive identifiers (QID, passport, bank details) are masked in lists and visible only to permitted roles.
- Secrets only in environment variables. Google credentials are read-only scoped.
- All money operations inside database transactions; balances are derived from ledgers, never stored as editable numbers.
- Centralised error handling, structured logging with request ids, health-check endpoint, job monitoring screen (queue status, last run, failures, retry), and daily automated database backups with a documented restore procedure.

### 6.4 Testing

- Unit tests for all financial and rule logic: salary posting, advance deduction, negative-salary carry-over, ledger balance, rent dues, occupancy allocation, permission resolution, workflow transitions, expiry windows.
- Integration tests for the main API flows and an end-to-end test (Playwright) for: login, create employee with documents, daily tracking update, issue merchandise, loan application through all three approvals, salary upload and posting.
- The Google Sheets importer is tested against fixture data, including a changed-column case.

### 6.5 Security, privacy and compliance (extends 6.3)

- Target OWASP ASVS Level 2. Run dependency, secret and static-analysis scans in CI, and plan an independent penetration test before go-live and yearly after.
- Encryption in transit (TLS 1.2 or later) and at rest for database, backups and object storage. Field-level envelope encryption for QID, passport, bank and IBAN numbers, with keys in a key management service and a key-rotation procedure. Searchable hashes allow lookup without decrypting.
- Identity: single sign-on ready (OIDC and SAML), mandatory two-factor for privileged roles, password policy, session and device management, optional IP allow-list for admin functions, break-glass account procedure.
- Make the audit log tamper-evident with a hash chain, and export it to write-once storage.
- Segregation of duties as configuration: the person who creates a payment, loan, bank-detail change or payroll run cannot be its only approver. Sensitive actions require re-authentication.
- Privacy by design, following Qatar's personal data protection law (Law No. 13 of 2016) and the equivalent law of any country added later: record the purpose and consent for each category of personal data, keep a processing register, support access, correction and deletion requests, apply retention schedules automatically, and mask personal data in non-production environments. Data residency (hosting region) is a per-tenant setting. The company must confirm exact legal obligations with its legal adviser.
- Labour and wage compliance checks as configurable rules: wages paid through WPS on time, deductions within permitted limits, valid documents for everyone who is working. A compliance dashboard lists breaches before an inspector does.
- Backups: continuous database archiving with point-in-time recovery, daily snapshots kept in a second region, restore tested automatically every month. Targets: at most 15 minutes of data loss and 4 hours to restore service. Write the disaster recovery runbook.

### 6.6 Operations and delivery standards

- Environments: local, staging (production-like with masked data) and production. Infrastructure defined as code. Everything containerised; start on a single managed host with managed PostgreSQL, and keep the design ready for horizontal scaling behind a load balancer (stateless API, Redis for sessions and queues, object storage for files).
- CI/CD pipeline: lint, type check, tests, security scans, build, database migration check, deploy to staging automatically and to production on approval, with zero-downtime rollout and one-step rollback.
- Observability with OpenTelemetry: structured logs, metrics and traces with a request id end to end; error tracking; uptime checks; dashboards and alerts for API latency, error rate, queue depth, failed jobs, failed logins and the 04:00 sync. Define service-level objectives (99.9% availability, 95% of pages under 2 seconds).
- Performance budget and load tests with the 5,000-worker, 5-year dataset; pagination and background jobs for anything heavy.
- Feature flags for gradual release; versioned API with a deprecation policy; changelog and in-app release notes.
- Dependency upgrades scheduled quarterly, with supported LTS versions only, so the stack does not rot over ten years. Avoid any library without active maintenance; wrap third-party services behind the adapters in 2.11 so each can be replaced.
- Admin console for the platform operator: tenant management, job monitor, integration health, usage, storage and message costs.
- Documentation kept in the repository and generated where possible: architecture decision records, data dictionary, API reference, admin guide, user guides per role in each language, runbooks.

### 6.7 Build phases

Build in this order. At the end of each phase, stop, summarise what was built, list how to run and test it, and wait for confirmation before continuing.

1. **Foundation A:** project setup, CI/CD and staging, multi-tenant schema with row-level security, party model, authentication, roles and permission matrix, audit trail, soft delete and recycle bin, notification service, app shell and design system.
2. **Foundation B:** dynamic engines (entity and form builder, lookups, rules and formulas, workflow, state machines, templates, numbering), event outbox, public API v1, generic import and export, general ledger and posting service.
3. Employee master data, documents, custom documents, expiry alert engine, document OCR.
4. Google Sheets sync at 04:00, daily and monthly performance reports, daily tracking page.
5. Merchandise and inventory with reconciliation; fleet register, assignments, rent ledger, violations and incidents.
6. Rates and charges, loans with loan paper, loan fund with investors and cash book, import of the existing loan workbook.
7. Payroll: pay components, automatic payroll engine, Excel verification, pay slips, payment batches, WPS and bank files, profit and loss (4.4, 4.7, 5.8, 5.9).
8. Client contracts, invoicing, statement reconciliation and receivables; accounting reports, payables, budgets and accounting-software sync.
9. Rider and driver mobile app, electronic signature, loan application workflow, service request catalogue, WhatsApp and SMS.
10. Dashboard, onboarding pipeline, agents and deposits, accommodation, leave and HR requests, exit clearance, workforce planning.
11. Risk engine, analytics and BI, report and dashboard builder, automation builder, AI layer, telematics ingestion API.
12. Hardening: security review and penetration test fixes, load test, disaster recovery drill, full test suite, documentation, migration of live data and go-live.

### 6.8 Before you write code

First reply with: a short summary of your understanding, the complete database schema (tables, key columns, relations), the folder structure, the list of API endpoints per module, and any questions or assumptions. Flag any requirement that conflicts with another and propose a resolution. Begin Phase 1 only after that plan is approved.
