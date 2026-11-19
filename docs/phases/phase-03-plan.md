# Phase 3 plan: People and documents

Status: **waiting for approval**. Based on `docs/PLAN.md` sections 3.5, 3.10, 5.12, `docs/phases/phase-03.md` and SPEC 2.8, 3.2, 5.12. Written 2026-11-19.

## 1. How to use this plan

Each row in section 7 is one Claude Code session and one commit. For every row:

1. `/clear`
2. `/model` set to the tier in the row (**S** = strongest: Fable or Opus; **M** = mid: Sonnet; **H** = small: Haiku).
3. Run `git log --oneline -1` first and confirm the previous row is committed.
4. Paste, replacing `3.N`:

```
Read CLAUDE.md and docs/PROGRESS.md, then build row 3.N of docs/phases/phase-03-plan.md section 7, following the token budget rules exactly. Read only the PLAN/SPEC sections that row names. Run lint, typecheck and the tests for this row, then the full suite once. Commit as "Phase 3.N: <title>" with no AI attribution lines (see CLAUDE.md), update PROGRESS.md in one line, and stop.
```

A row marked **split** may be done as `3.Na` and `3.Nb` in two sessions if the first runs long.

## 2. Scope

Employee master data on top of the existing `party` model (Phase 1), documents with expiry for people, vehicles and the company, the daily expiry alert engine, OCR pre-fill (stub adapter until a provider key exists), bulk scan upload, and bulk employee import from Excel.

Reused from earlier phases, not rebuilt: party, party_identifier vault (encryption, hash, mask), files module (versions), numbering, lookups, state machines (employee status), generic import engine (2.8), report engine (2.13), templates, notify module, job scheduler, module registry.

Not in Phase 3:

- Daily tracking, status dropdown screens, call sheet (Phase 4). Only the `status_code` state machine is seeded here.
- Vehicle register screens (Phase 5). Phase 3 makes the document engine accept `owner_type = vehicle`; the vehicle table comes later.
- Worker portal document renewal (Phase 9).
- A real OCR provider. A stub adapter returns fixed demo values, clearly named, listed in PROGRESS until replaced.
- Profile tabs fed by other modules (loans, salary, merchandise): the tab frame exists, tabs appear when their module does.

## 3. Tables created

PLAN 3.10, schema `people`. Each uses `app.setup_table(...)` (RLS, audit trigger, no DELETE grant).

| Table | Notes |
| --- | --- |
| `employee` | party_id unique per company, employee_code from numbering key `employee`, status_code, sponsorship, sponsor_party_id, recruiting_agent_party_id, joining_date, custom_fields |
| `employment_period` | start, end, rehire_eligible (exit_case_id left null until Phase 10) |
| `employee_placement` | effective-dated profession, client platform, zone, team; exclusion constraint: one current placement |
| `document_type` | seeded: QID, driving licence, Istimara, passport, food handling, health card, insurance, agreement; admin can add more |
| `document_requirement` | which types a person must hold (for example agreement when sponsorship = outside) |
| `document` | owner_type (party, vehicle, company), document_type_id or custom_name, number encrypted + hash + masked, issue and expiry dates, status |
| `expiry_alert_log` | one row per document per window, so each window alerts once |
| `ocr_job` | provider, result per field with confidence, flags |
| `bulk_upload`, `bulk_upload_item` | folder of scans, suggested person and type, confirm or reject |

Rules enforced in the database, not only in code:

- `document.number_*` follows the same vault pattern as `party_identifier`: plaintext is never stored for QID, passport or licence numbers.
- A document of type `custom` must have `custom_name`; a typed document must not.
- `status` is derived by the daily job and on write, never typed by a user.
- Only one non-replaced document of a given type per owner may be current; a renewal marks the old one `replaced` and keeps it.

## 4. Endpoints

PLAN 5.12, under `/api/v1`, through the CRUD factory, all in OpenAPI:

- `/employees` CRUD+ (importable, exportable), `GET /employees/:id/profile`, `GET /employees/:id/tabs/:tab`, `/employees/:id/placements` CRUD+.
- `/document-types` CRUD+, `/document-requirements` CRUD+.
- `/documents` CRUD+, `POST /documents/:id/files` (new file version), `GET /documents/expiring?withinDays=`, `GET /documents/expiry-calendar?month=`.
- `POST /ocr/jobs`, `GET /ocr/jobs/:id`, `/bulk-uploads` with `POST /bulk-uploads/:id/items/:item/confirm`.
- Reports: `people.missing_documents`, `people.expiring_documents`, `people.headcount`.

Permissions follow `people.<thing>.<action>`. Reading a full document number needs its own permission, `people.document_number.reveal`, and every reveal is audited. Lists always show the masked value.

## 5. Screens (web)

| Area | Screens |
| --- | --- |
| People | Employees (list with filters, create, import), Employee profile (Profile, Documents, Placement, History tabs; other tabs appear with their modules) |
| Documents | Add document (standard type or "Add other document" with typed name), OCR confirm panel with per-field confidence, Expiring soon (colour coded), Expiry calendar, Missing documents, Bulk scan upload |
| Settings | Document types, Document requirements, Expiry alert settings (email list, windows) |

Responsive rules from Phase 1 apply (cards below 768px). All labels go through i18n with Bangla drafts in the last row.

## 6. "Done when" mapped to tests

| Done when (phase-03.md) | Test |
| --- | --- |
| Employee with all standard documents plus a custom-named document, each with expiry | Playwright: create employee, add 8 standard documents and "Gym pass" custom document, all show with expiry dates |
| Daily job emails the consolidated expiry list at the windows (7 days default), in-app alerts, calendar | Integration with a fixed clock: documents at 20, 14, 7, 0 and -3 days; job run sends one email per window to the Mailpit list, writes `expiry_alert_log`, second run sends nothing; calendar endpoint lists them |
| OCR pre-fills number and dates with confidence; user confirms before save | Integration: stub adapter result stored in `ocr_job`; document is not created until confirm; low confidence and name mismatch flagged. Playwright: upload, see pre-fill, edit, confirm |
| Bulk Excel import with validation preview and rollback | Integration + Playwright: 10 rows with 2 bad rows shown in preview; commit 8; rollback removes them (soft delete, audited) |
| Sensitive identifiers encrypted at rest and masked in lists | Integration: raw DB read shows ciphertext only; list API returns masked value; reveal needs permission and is audited |
| Tests pass, PROGRESS updated | Local full suite until the GitHub billing lock is cleared |

## 7. Commit sequence

| Row | Title | Tier | Reads | What it builds |
| --- | --- | --- | --- | --- |
| 3.1 | People schema and employee API | S | PLAN 3.10, 3.5, SPEC 2.8, 3.2 | Migration for employee, employment_period, employee_placement; employee numbering key; employee status state machine seeded (active, inactive, blocked, terminated); module manifest and permissions; employee CRUD that creates or links a `party` with the employee role in one transaction; duplicate warning on QID, passport, phone; RLS and audit tests |
| 3.2 | Documents core | S | PLAN 3.10, 3.6 file tables | `document_type` seeded, `document_requirement`, `document`; encrypted number with hash and mask; file versions through the files module; custom document rule; renewal marks old as replaced; status derivation; reveal permission and audit; tests including raw-DB ciphertext check |
| 3.3 | Employee screens | M, split | 3.1, 3.2 | Employees list, create and edit form (name in English, Arabic or Bangla, phones, QID, passport, nationality, sponsorship, agent, bank placeholder), profile page with Documents tab and "Add other document", placement history |
| 3.4 | Expiry engine | S | SPEC 3.2, PLAN 3.10 expiry_alert_log, notify module | Daily scheduled job, configurable windows (default 14 and 7 days before; expired items only in-app), one consolidated email per run to the company email list (setting), in-app alerts to roles, `expiry_alert_log` idempotency, owner types party, vehicle and company; endpoints `expiring` and `expiry-calendar` |
| 3.5 | Expiry screens and people reports | M | 3.4, 5.9 Reports | Expiring soon list (red, amber, green), expiry calendar, alert settings screen, reports `people.missing_documents`, `people.expiring_documents`, `people.headcount` through the report engine |
| 3.6 | OCR adapter and confirm flow | S | SPEC 5.12, PLAN adapter_config, ocr_job | Adapter interface (`ocr`), stub implementation named as stub, `ocr_job`, field confidence, flags for expired, name mismatch, unreadable, duplicate; upload to pre-fill to confirm flow in the document form; adapter health row |
| 3.7 | Bulk scan upload | M | SPEC 5.12, PLAN bulk tables | Upload many files, one OCR job each, suggest person and document type, staff confirm or reject per item, confirmed items create documents |
| 3.8 | Employee Excel import | M | 2.8 import engine | Employee import profile on the generic wizard: template download, mapping, party matching by QID or phone, validation preview with row errors, commit job, rollback; imports identifiers through the vault |
| 3.9 | Phase 3 journeys and wrap-up | M | section 6 | Playwright journeys for each Done-when row, OpenAPI check, `ADDING_A_MODULE.md` touched if needed, PROGRESS marks Phase 3 done |
| 3.10 | Translations and docs polish | H | i18n files | Draft `bn` labels for Phase 3 screens, glossary additions (QID, Istimara, Health card, Sponsor); no logic changes |

Totals: 4 rows on S, 5 on M, 1 on H. Expect about 12 sessions with splits.

Cost note: rows 3.1, 3.2, 3.4 and 3.6 touch encryption, money-adjacent identity data and background jobs, so keep them on S. Everything else is ordinary CRUD and screens.

## 8. Decisions this plan applies (to record in DECISIONS.md in row 3.1)

- **Identity data:** QID, passport and licence numbers use the same vault, hash and mask pattern as `party_identifier`; no new crypto.
- **Expiry windows (owner answer 2026-11-19):** emails only at 14 days and 7 days before expiry. Expired and expiring documents still show in the app (red or amber list, calendar), but no email on the day or after. Per document type override stays possible through `alert_windows`. Default windows are 14 and 7, not the SPEC default of 30, 14, 7.
- **Expiry email list (owner answer 2026-11-19):** fibrextrading@gmail.com and zakirjihan222@gmail.com, stored as a setting the admin can edit, not in code.
- **OCR:** stub adapter until the owner gives a provider key. Nothing is saved from OCR without user confirmation.
- **Status:** employee status is a state machine so Phase 4 can drive it with dated history.
- **Documents never deleted:** renewals replace, old versions kept.

## 9. Questions for the owner

1. ~~Expiry email list~~ answered: fibrextrading@gmail.com and zakirjihan222@gmail.com.
2. ~~Windows~~ answered: 14 days and 7 days before only.
3. ~~Mandatory documents~~ answered: all standard documents are required for every worker (QID, driving licence, passport, food handling, health card, insurance); the agreement copy only when the sponsor is outside. Seed `document_requirement` this way; admin can change it.
4. ~~Employee code~~ owner left it to us: numbering key `employee`, pattern `E{0000}` (E0001, E0002 ...). Editable in Numbering sequences.
5. ~~Import size~~ about 40 employees. No old export yet: row 3.8 builds the template from the SPEC 3.2 fields; the owner fills it from the old data.
6. ~~OCR~~ owner unsure: stay on the stub (demo values) now; a real provider is chosen later, only an adapter swap.
