# Fibrex Platform: Planning Reply (SPEC 6.8)

Status: **draft, waiting for approval**. No code has been written. Phase 1 starts only after this plan is approved.

Contents

1. Understanding
2. Cross-cutting design (the rules every table and endpoint follows)
3. Complete database schema
4. Folder structure
5. API endpoints per module
6. Conflicts between requirements, with proposed resolutions
7. Questions for the owner
8. Technical assumptions to approve
9. What happens next

---

## 1. Understanding

Fibrex supplies bike riders and car drivers to food delivery platforms in Qatar. Snoonu is the first client; Keeta, Talabat and others must be addable through configuration. Today the business runs on a Snoonu Google Sheet, a loan workbook (`Loan_Management_System_v7.xlsx`), a monthly salary Excel file, and a small in-house payroll app. The platform replaces all of them.

What the platform must do:

- **Know every person once.** One `party` record per person or organisation, with roles (employee, rider, borrower, investor, agent, landlord, client platform and so on) and platform IDs (Falcon ID and others) kept with dated history.
- **Run daily operations.** Read the Snoonu sheet at 04:00 each day, produce daily and monthly performance reports, support the morning call sheet, and track documents and their expiry, merchandise, vehicles, rent, fines and incidents.
- **Handle money correctly.** One double-entry ledger sits behind loans, the loan fund and investors, the cash book, payroll, vehicle rent, client invoices and expenses. No module stores its own balance. Posted entries are immutable, and corrections are reversals.
- **Pay people.** A payroll engine calculates pay from data. The salary Excel stays as a verification source. The platform produces pay slips, WPS and bank files, and period-based profit and loss.
- **Serve workers on their phones.** An installable PWA covers payslips, loans and loan applications, documents, e-signature and notifications, in several languages including Arabic (RTL) and Bangla.
- **Change through configuration.** Fields, forms, lookups, formulas, workflows, statuses, templates, reports and automations are data. Schema changes are only for new engines, and they are additive.
- **Last 5 to 10 years.** It is multi-tenant from the first migration, with row-level security, monthly partitioning of high-volume tables, a transactional outbox, adapters for every external service, a modular monolith with manifests, and a full audit trail.

The work is delivered in 12 phases (SPEC 6.7). Phases 1 and 2 build the foundation that every later phase depends on. Phase 7 completes the replacement of the current Excel files and the old payroll app.

**Scope of this schema.** Section 3 is the complete target schema for all 12 phases, so later phases never need a redesign. Each phase creates only its own tables, through additive migrations. The phase that creates each group of tables is shown in brackets, for example [P1].

---

## 2. Cross-cutting design

### 2.1 Standard columns

Each table in section 3 is tagged with one of these column sets.

| Tag | Columns | Used for |
| --- | --- | --- |
| **S** (standard) | `id UUID` (v7, primary key), `tenant_id`, `company_id`, `created_at`, `created_by`, `updated_at`, `updated_by`, `version INT`, `deleted_at`, `deleted_by`, `delete_reason` | Every normal business table |
| **S+B** | S plus `branch_id` | Tables where a branch applies |
| **A** (append-only) | `id`, `tenant_id`, `company_id`, `created_at`, `created_by` | Immutable facts: audit, outbox, journals, ledgers of movements, raw inputs. The application database role has no UPDATE or DELETE grant on these tables. |
| **G** (global) | `id`, created and updated columns, `version` | Shared reference data with no tenant: currencies, the permission catalogue, the event-type catalogue, subscription plans |
| **T** (tenant-level) | S without `company_id` | Data that belongs to a tenant, not a company: users, tenant settings |

Conventions:

- **Money.** `x (money)` means `x_amount NUMERIC(18,4)` and `x_currency CHAR(3)`. Financial documents also carry `fx_rate NUMERIC(18,8)` and `x_base_amount NUMERIC(18,4)`.
- **Effective dating.** `valid_from DATE` and `valid_to DATE NULL`. An exclusion constraint prevents overlapping periods for the same key.
- **Custom fields.** Master tables have `custom_fields JSONB`, validated against `field_definition` and indexed with GIN.
- **Human-readable numbers.** Columns such as `number` (for example `L0001`) come from `number_sequence` per company. They are separate from the UUID, and are never reused or typed by hand.
- **Database naming.** Tables use `snake_case`, with one Postgres schema per module. Prisma models use `@@map` and `@@schema`.

### 2.2 Tenancy and row-level security

- Each API request runs inside a transaction that first runs `SET LOCAL app.tenant_id`, `app.company_ids` (an array, so the owner's consolidated view works), `app.user_id`, `app.impersonator_id` and `app.request_id`.
- Every S, A and T table has an RLS policy: `tenant_id = current_setting('app.tenant_id')::uuid AND company_id = ANY(current_setting('app.company_ids')::uuid[])`.
- The application connects as `fibrex_app`, which is `NOBYPASSRLS`, does not own any tables, and has no `DELETE` grant on any business table. Migrations run as a separate owner role. Because of this, a forgotten filter in code cannot leak another tenant's or company's data, and a physical delete cannot happen through the app.

### 2.3 Audit

- **Data changes.** A generic `AFTER INSERT OR UPDATE` trigger on every S and T table writes to `audit.audit_log`, with a field-level JSONB diff (old value to new value) and the user, impersonator, IP, role and request taken from the `SET LOCAL` context. A module cannot forget to audit, including in its raw-SQL repositories.
- **Non-data events.** Login, export, file download, approval and AI tool calls are written by the shared `AuditService`.
- **Tamper evidence.** Rows get a per-tenant `seq`. A sealing job hashes rows in order into a chain (`audit_seal`) and exports sealed batches to write-once object storage. Sealing happens after the write so the hash chain does not slow down transactions.

### 2.4 Soft delete, optimistic locking and immutability

- **Soft delete.** `DELETE` endpoints set `deleted_*` and require a reason. A shared Prisma client extension adds `deleted_at IS NULL` to every read. Raw-SQL repositories use a shared `notDeleted()` helper, and a lint rule checks for it. Restore clears the columns and is audited.
- **Optimistic locking.** Updates send `If-Match: <version>`. The repository runs `UPDATE ... WHERE id = $1 AND version = $2`. If no row matches, the API returns 409 with the current record and a diff.
- **Financial immutability.** Posted financial documents (journal, loan, payment, payslip, invoice) cannot be soft-deleted or updated once posted. A database trigger blocks this. The only path is a reversal document.

### 2.5 Partitioning

These tables are partitioned by month from the start, with partitions created ahead of time by a job:

- `audit_log`, `outbox_event`, `webhook_delivery`, `notification`, `notification_delivery`
- `journal_line`, `daily_performance`, `location_point`, `risk_signal`, `login_event`, `ai_tool_call`

PostgreSQL requires the primary key of a partitioned table to include the partition key, so their primary key is `(id, <date column>)`. Other tables that reference a partitioned row store both columns.

### 2.6 Events, money and encryption

- **Outbox.** Every service command writes its domain events to `outbox_event` in the same transaction. A relay worker publishes them to BullMQ consumers: notifications, automations, webhooks, search indexing and reporting refresh.
- **Money arithmetic.** All money uses `decimal.js` in `packages/shared`, never JavaScript floating-point numbers. Rounding happens only at defined points (line level, half-up to 2 decimals for QAR display; 4 decimals stored).
- **Encryption.** QID, passport, IBAN and bank account numbers use envelope encryption through a `KeyManagementAdapter` (in development, a stub using a local key). Each encrypted value also stores an HMAC blind index for exact lookup and duplicate detection, and a masked display value.

---

## 3. Complete database schema

### 3.1 `platform`: tenancy, companies, settings [P1]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `tenant` | G-like | name, slug, status, data_residency_region, onboarded_at | Root of everything |
| `subscription_plan` | G | code, name, limits JSONB (users, workers, storage) | Exists from day one but is unused (SPEC 2.7) |
| `tenant_subscription` | T | plan_id, valid_from/to, status | → tenant, plan |
| `usage_counter` | T | metric, period, value | Storage, messages, AI tokens, workers |
| `company` | T | legal_name, trade_name, country_code, base_currency, time_zone, working_week JSONB, fiscal_year_start_month, logo_file_id, letterhead JSONB, status | → tenant |
| `branch` | S | code, name, address, is_head_office | → company |
| `org_unit` | S+B | kind (team, zone), code, name, parent_id | Tree under a branch. Zones live here because they are organisational placement; the "Zones" lookup screen edits this table. |
| `company_module` | S | module_key, enabled, rollout_percent, enabled_at | Feature flags per company (SPEC 2.13) |
| `setting` | S | scope (tenant, company, user), scope_id, key, value JSONB, valid_from | Typed by a Zod schema per key |
| `number_sequence` | S | key (loan, payslip, invoice ...), prefix, padding, next_value, reset_policy, format | Row lock on allocation; values are never reused |
| `currency` | G | code CHAR(3), name, minor_units | QAR, BDT, USD ... |
| `inter_company_link` | T | from_company_id, to_company_id, receivable_account_id, payable_account_id | For inter-company loans recorded on both sides (SPEC 2.7) |

### 3.2 `iam`: users, roles, permissions, sessions [P1]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `user_account` | T | party_id, username, email, phone, status, must_change_password, failed_attempts, locked_until, last_login_at, preferred_language, mfa_required | → party. One login per person per tenant. |
| `credential` | T | user_id, kind (password), hash (Argon2id), set_at | Password history is kept for the password policy |
| `mfa_factor` | T | user_id, kind (totp, webauthn), secret_encrypted, confirmed_at | |
| `mfa_recovery_code` | T | user_id, code_hash, used_at | |
| `otp_challenge` | T | user_id or phone, purpose (login, sign, reauth), code_hash, expires_at, attempts | |
| `company_membership` | T | user_id, company_id, is_default, status | A user can belong to several companies |
| `membership_role` | T | membership_id, role_id | A different role in each company |
| `role` | T | key, name, is_builtin, description | Built-in roles: super_admin, admin, owner, manager, user, rider, driver |
| `role_grantable` | T | grantor_role_id, grantable_role_id | Which roles an Admin may create (SPEC 2.1) |
| `permission` | G | key, module_key, action (view, create, update, delete, restore, export, approve, or custom such as loan.review and fund.view), resource, description | Catalogue registered by module manifests |
| `role_permission` | T | role_id, permission_id | Permission matrix |
| `user_permission_override` | T | user_id, company_id, permission_id, effect (grant, deny) | Overrides take priority over the role |
| `data_scope` | T | subject_type (role, user), subject_id, company_id, scope_kind (own, platform, zone, branch, all), values UUID[] | Record-level scope |
| `session` | T | user_id, company_id, device, user_agent, ip, created_at, last_seen_at, revoked_at, revoked_by | Session list and remote logout |
| `refresh_token` | T | session_id, token_hash, family_id, rotated_from_id, expires_at, used_at | Rotation with reuse detection |
| `login_event` | A, partitioned | user_id, at, ip, device, result (success, fail, locked, mfa_fail) | Login history |
| `password_reset_token` | T | user_id, token_hash, expires_at, used_at | |
| `impersonation` | T | actor_user_id, target_user_id, reason, started_at, ended_at | Both identities are stamped into the audit context |
| `api_client` | S | name, kind (api_key, oauth_client), scopes TEXT[], rate_limit, status | Integrations (SPEC 2.11) |
| `api_key` | S | api_client_id, key_prefix, key_hash, expires_at, revoked_at | |
| `ip_allowlist` | T | cidr, applies_to (admin) | Optional (SPEC 6.5) |
| `sso_provider` | T | kind (oidc, saml), config_encrypted, status | Ready for SSO, unused at launch |

### 3.3 `audit` [P1]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `audit_log` | A, partitioned | seq BIGINT, at, user_id, impersonator_id, role_keys, ip, request_id, module_key, entity_type, entity_id, action (create, update, delete, restore, approve, login, export, download, transition, ai_query ...), diff JSONB, meta JSONB | Feeds the History tab and the Activity Log |
| `audit_seal` | A | tenant_id, from_seq, to_seq, prev_hash, hash, sealed_at, worm_object_key | Hash chain |
| `export_log` | A | user_id, entity_type, filters JSONB, row_count, format, file_id | Also used by the "mass export" risk rule |

### 3.4 `notify` [P1; WhatsApp, SMS and broadcast in P9]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `event_type` | G | key (loan.submitted ...), version, module_key, payload_schema JSONB, description | Registered by manifests |
| `notification_rule` | S | event_type_key, condition_expr, recipient_spec JSONB (roles, permission, users, party-of-record, workflow assignee), channels TEXT[], template_key, active | New events need no code (SPEC 2.4) |
| `notification` | S, partitioned | user_id, event_type_key, title, body, link, entity_type, entity_id, read_at | Bell and notification centre |
| `notification_delivery` | A, partitioned | notification_id, channel, recipient_address, status (queued, sent, delivered, read, failed), provider_message_id, attempts, error | |
| `notification_preference` | T | user_id, category, channel, enabled | |
| `channel_fallback` | S | order TEXT[] (push, whatsapp, sms, email) | SPEC 5.11 |
| `push_subscription` | T | user_id, endpoint, keys JSONB, device | Web Push for the PWA |
| `message_opt_in` | S | party_id, channel, opted_in_at, opted_out_at, source | |
| `inbound_message` | A | channel, from_address, party_id, body, media_file_id, matched_entity, status | Two-way messages |
| `staff_inbox_item` | S | inbound_message_id, assigned_to, status, resolution | Unrecognised replies |
| `broadcast` | S | name, channel, template_version_id, audience_filter JSONB, scheduled_at, status, estimated_cost (money) | |
| `broadcast_recipient` | A | broadcast_id, party_id, delivery_id, status | |

### 3.5 `party`: the universal party model [P1]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `party` | S | kind (person, organisation), display_name, names JSONB ({en, ar, bn}), date_of_birth, gender, nationality_code, photo_file_id, custom_fields JSONB, search_tsv, merged_into_id | Every person and organisation exactly once. Trigram index on names. |
| `party_role` | S | party_id, role_type (lookup: employee, rider, driver, candidate, borrower, investor, recruiting_agent, vehicle_owner, landlord, payee, supplier, client_platform, guarantor, emergency_contact, office_staff ...), valid_from/to, status, attributes JSONB | Several roles at once and over time |
| `party_identifier` | S | party_id, type (lookup: falcon_id, snoonu_id, talabat_id, keeta_id, qid, passport, cr_number, visa_number ...), client_platform_id, value_encrypted, value_hash, value_masked, value_plain (only for non-sensitive types), valid_from/to | The same ID can move between people over time; a database constraint stops two people holding it in overlapping periods |
| `party_contact` | S | party_id, kind (phone, whatsapp, email), value, is_primary, verified_at | |
| `party_address` | S | party_id, kind, lines, city, country_code, geo | |
| `party_relationship` | S | from_party_id, to_party_id, type (emergency_contact, guarantor, supplied_by_agent, sponsor, employee_of), valid_from/to | |
| `party_bank_account` | S | party_id, kind (bank, wallet), bank_name, iban_encrypted, iban_hash, iban_masked, account_name, wallet_provider, status (pending, verified, rejected), proof_file_id, requested_by, approved_by, approved_at | Any change needs a second person's approval (SPEC 5.9, 6.5) |
| `party_duplicate_candidate` | S | party_a_id, party_b_id, score, reasons JSONB, status (open, dismissed, merged) | |
| `party_merge` | A | survivor_id, merged_id, snapshot JSONB, repointed_refs JSONB | History is preserved |

### 3.6 `files` [P1]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `file_object` | A | bucket, object_key, sha256, size_bytes, mime_type, original_name, scan_status | Immutable; never overwritten |
| `file_attachment` | S | entity_type, entity_id, file_object_id, purpose (photo, document_page, receipt, signed_copy ...), version_no, supersedes_id, label | Replacing a file adds a version |
| `raw_input` | A | kind (sheet_snapshot, excel_upload, bank_file, client_statement, webhook, workbook_import, legacy_dump), source, received_at, file_object_id, sha256, meta JSONB | Every raw input is kept forever (SPEC 2.12) |

### 3.7 `cfg`: dynamic engines [P2; automation, semantic layer and service catalogue tables are created in P2 and used fully in P9 and P11]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `lookup_type` | S | key (zone is the exception, see `org_unit`; client_platform_type, document_category, merchandise_category, expense_type, loan_purpose, status_reason, payment_method, call_outcome, vehicle_type ...), name, is_system, allow_hierarchy | |
| `lookup_value` | S | lookup_type_id, code, labels JSONB (i18n), parent_id, sort_order, active, meta JSONB | |
| `entity_definition` | S | key, name JSONB, kind (system, custom), json_schema JSONB, list_config JSONB, form_layout JSONB, detail_layout JSONB, numbering_key, state_machine_id, permission_module_key, version, status (draft, published) | System entities are registered here too, so custom fields work on them |
| `field_definition` | S | entity_definition_id, key, label JSONB, type (text, number, decimal, date, dropdown, multi, file, party_ref, entity_ref, boolean), validations JSONB, lookup_type_id, ref_entity_key, required, sort_order, promoted_column, status | |
| `custom_record` | S+B | entity_definition_id, number, data JSONB (GIN), state_code, party_id | Records of admin-defined entity types |
| `record_link` | S | from_entity_type, from_id, to_entity_type, to_id, relation_key | Relations from custom records |
| `formula` | S | key, name, purpose (pay_component, billing_rate, fine, interest, eligibility, alert, allocation, risk), return_type, input_schema JSONB | |
| `formula_version` | S | formula_id, language (cel), expression TEXT, valid_from/to, status (draft, active, retired), test_cases JSONB, checksum | Versioned with effective dates |
| `rate_table` | S | key (client_rate_per_order, pay_rate_per_order ...), dimensions TEXT[] (platform, profession, vehicle_type, zone, slab) | Parameter tables that formulas read |
| `rate_table_row` | S | rate_table_id, dims JSONB, value NUMERIC(18,4), currency, valid_from/to | Seed: client rate driver 18 / rider 14; pay rate driver 14 / rider 10 QAR |
| `state_machine` | S | entity_key, name, version | |
| `state` | S | state_machine_id, code, labels JSONB, category (open, active, closed), is_initial, is_final, colour | |
| `state_transition` | S | state_machine_id, from_code, to_code, permission_key, required_fields TEXT[], reason_lookup_type_id, reason_required, workflow_definition_id | |
| `state_history` | A | entity_type, entity_id, from_code, to_code, effective_date, reason_id, note, actor_id | Dated history (used by tracking, employee status and others) |
| `workflow_definition` | S | key, name, entity_key, status | |
| `workflow_version` | S | workflow_definition_id, version, graph JSONB, published_at | |
| `workflow_step` | S | workflow_version_id, key, kind (approval, parallel_group, condition, notify, task), assignee_rule JSONB (roles, permission, users, expression), quorum (any, all), condition_formula_version_id, sla_hours, reminder_hours, escalate_to JSONB, order_no | Amount thresholds use condition steps |
| `workflow_binding` | S | entity_key, trigger (on_create, on_transition:X, manual), workflow_definition_id, condition_expr | Attaches a workflow to any entity, including custom ones |
| `workflow_instance` | S | workflow_version_id, entity_type, entity_id, status (running, approved, rejected, cancelled), started_by, current_step_keys TEXT[] | |
| `workflow_task` | S | instance_id, step_key, assignee_user_id, assignee_role_id, status (open, done, skipped, expired), due_at, acted_by, action (approve, reject, send_back, comment), comment, delegated_from_user_id, payload JSONB (for example a changed amount) | |
| `workflow_delegation` | T | user_id, delegate_user_id, valid_from/to, scope JSONB | Delegation during leave |
| `template` | S | key, kind (pdf, email, whatsapp, sms, push), entity_key, name | |
| `template_version` | S | template_id, language, version, subject, body (Handlebars, logic-light), css, paper (A4), status, valid_from, provider_template_id | Per language and per company |
| `generated_document` | A | template_version_id, entity_type, entity_id, file_object_id, data_hash, merge_data JSONB, generated_by | Stores which template version was used |
| `automation_rule` | S | name, event_type_key, condition_expr, actions JSONB (notify, create_task, start_workflow, set_field, call_webhook), active, run_as_user_id | [P11] |
| `automation_run` | A | rule_id, event_id, result, error | |
| `service_catalog_item` | S | key, name JSONB, entity_definition_id (form), workflow_definition_id, template_id, audience_roles TEXT[], active | [P9] |
| `service_request` | S | number, catalog_item_id, requester_party_id, custom_record_id, status, workflow_instance_id, output_document_id | |
| `report_definition` | S | key, module_key, source, config JSONB, permission_key, is_system | Code-registered definitions are synced into this table |
| `saved_report` | S | report_definition_id, owner_user_id, name, filters JSONB, columns JSONB, shared_with JSONB | |
| `report_schedule` | S | saved_report_id, cron, time_zone, recipients JSONB, format, last_run_at | |
| `dashboard` | S | key, name, role_key, owner_user_id, layout JSONB | |
| `dashboard_widget` | S | dashboard_id, kind (kpi, chart, table), measure_keys, dimension_keys, filters JSONB, drill_link | |
| `semantic_measure` | S | key, label JSONB, sql_ref (registered view and column), aggregation, format, permission_key | [P11]. A governed list; never free SQL |
| `semantic_dimension` | S | key, label JSONB, sql_ref, type | |
| `retention_policy` | S | entity_key, keep_months, action (archive, anonymise), legal_basis | |
| `retention_run` | A | policy_id, run_at, rows_affected, archive_file_id | |

### 3.8 `integration` [P2]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `outbox_event` | A, partitioned | event_type_key, event_version, aggregate_type, aggregate_id, payload JSONB, occurred_at, published_at, attempts | Written in the same transaction as the change |
| `event_consumption` | A | consumer_key, event_id, processed_at | Makes consumers idempotent |
| `webhook_subscription` | S | url, secret_encrypted, event_type_keys TEXT[], active, api_client_id | Signed webhooks |
| `webhook_delivery` | A, partitioned | subscription_id, event_id, attempt, status_code, response_ms, error, next_retry_at | Delivery log |
| ~~`idempotency_key`~~ | — | — | Dropped 2026-11-13: idempotency records live in Redis (see DECISIONS) |
| `import_mapping` | S | entity_key, name, column_map JSONB, transforms JSONB | Saved column mappings |
| `import_job` | S | entity_key, raw_input_id, mapping_id, status (uploaded, previewed, committed, rolled_back, failed), stats JSONB | |
| `import_row` | A | import_job_id, row_no, raw JSONB, normalised JSONB, errors JSONB, created_entity_id | Rollback soft-deletes the created rows (audited) |
| `export_job` | S | entity_key, filters JSONB, format, status, file_object_id | Bulk exports |
| `adapter_config` | S | adapter_kind (client_report, messaging_email, whatsapp, sms, ocr, llm, esign, storage, bank_file, accounting, maps, kms, identity), provider, settings_encrypted, active | |
| `integration_health` | A | adapter_config_id, checked_at, status, latency_ms, error | |

### 3.9 `gl`: general ledger [P2]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `account` | S | code, name JSONB, type (asset, liability, equity, income, expense), parent_id, is_postable, is_control, currency_restriction, requires_dimensions TEXT[] | Editable tree |
| `cost_centre` | S | code, name, parent_id | |
| `tax_code` | S | code, rate, account_id, default (none) | Every line carries a tax code (SPEC 5.15) |
| `exchange_rate` | S | from_currency, to_currency, rate_date, rate NUMERIC(18,8), source | |
| `fiscal_year` | S | name, start_date, end_date, status | |
| `fiscal_period` | S | fiscal_year_id, period_no, start_date, end_date, status (open, closed, locked), closed_by, closed_at | A locked period refuses postings |
| `posting_rule` | S | event_key (loan.disbursed, payroll.posted ...), version, valid_from/to, lines JSONB (side, account resolver, amount expression, dimension mapping), status | Accounting treatment is data |
| `journal` | A | number, entry_date, fiscal_period_id, event_key, posting_rule_id, source_type, source_id, description, reversal_of_id, reversed_by_id, posted_by, posted_at, idempotency_key | Immutable; always posted |
| `journal_line` | A, partitioned by entry_date | journal_id, entry_date, line_no, account_id, debit, credit, currency, fx_rate, base_debit, base_credit, party_id, employee_party_id, vehicle_id, client_platform_id, branch_id, cost_centre_id, pay_period_id, loan_id, source_doc_type, source_doc_id, tax_code_id, memo | A CHECK constraint makes each line one-sided. A deferred constraint trigger checks that the journal balances in base currency. |
| `cash_location` | S | name, kind (hand, bank, card, wallet), account_id, currency | Fund and company cash |
| `company_bank_account` | S | cash_location_id, bank_name, iban_encrypted, wps_employer_id | |
| `bank_statement` | S | company_bank_account_id, raw_input_id, period_from/to, status | |
| `bank_statement_line` | S | statement_id, value_date, amount (money), reference, description, match_status | |
| `bank_match_rule` | S | name, conditions JSONB, target (account, party), priority | |
| `reconciliation_match` | S | statement_line_id, journal_line_id, journal_line_date, amount, matched_by, method (rule, manual) | Unmatching soft-deletes the match; the ledger is untouched |
| `manual_journal` | S | number, date, description, lines JSONB, status (draft, submitted, posted), journal_id | Drafts live here; only posting writes to `journal` |
| `budget` | S | name, fiscal_year_id, status | [P8] |
| `budget_line` | S | budget_id, account_id, cost_centre_id, period_no, amount (money) | |
| `close_checklist_item` | S | key, name, order_no, owner_role | [P8] |
| `period_close_task` | S | fiscal_period_id, checklist_item_id, status, done_by, done_at | |
| `fixed_asset` | S | number, name, category, vehicle_id, acquisition_date, cost (money), method (straight_line), useful_life_months, residual (money), status | [P8] |
| `depreciation_entry` | A | fixed_asset_id, fiscal_period_id, amount, journal_id | |
| `external_sync_map` | S | provider, local_type, local_id, external_id, last_synced_at, hash | [P8] accounting software sync |
| `external_sync_run` | A | provider, started_at, finished_at, pushed, pulled, errors JSONB | |

Sub-ledgers (a rider's loan balance, a vehicle's cost, a platform's margin) are queries over `journal_line` dimensions. The reporting schema materialises them for speed.

### 3.10 `people`: employees and documents [P3]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `employee` | S+B | party_id (unique per company), employee_code (sequence), status_code (state machine: active, inactive, blocked, terminated ...), sponsorship (company, outside), sponsor_party_id, recruiting_agent_party_id, joining_date, custom_fields JSONB | The employment master; other modules reference `party_id` |
| `employment_period` | S | employee_id, start_date, end_date, exit_case_id, rehire_eligible | Rehire keeps the same party |
| `employee_placement` | S+B | employee_id, valid_from/to, profession (lookup: rider, driver), client_platform_id, org_unit_id (zone), team_id | Effective-dated organisational placement |
| `document_type` | S | code, name JSONB, applies_to (party, vehicle, company), has_expiry, has_number, multi_page, alert_windows INT[] (null = default), is_system | Seed: QID, driving licence, Istimara, passport, food handling, health card, insurance, agreement |
| `document_requirement` | S | document_type_id, condition_expr (for example sponsorship = outside), applies_to_profession | Feeds the missing-documents report |
| `document` | S | owner_type (party, vehicle, company), owner_id, document_type_id (null for custom), custom_name, number_encrypted, number_hash, number_masked, issue_date, expiry_date, status (valid, expiring, expired, replaced), ocr_job_id | Files live in `file_attachment` with versions |
| `expiry_alert_log` | A | document_id, window_days, alerted_on, channels | Each window alerts once |
| `ocr_job` | S | file_object_id, provider, status, result JSONB (field, value, confidence), flags JSONB (name mismatch, expired, unreadable, duplicate) | [P3] stub adapter at first |
| `bulk_upload` | S | status, uploaded_count | Folder of scans |
| `bulk_upload_item` | S | bulk_upload_id, file_object_id, ocr_job_id, suggested_party_id, suggested_document_type_id, status (pending, confirmed, rejected), document_id | |

### 3.11 `performance` and `tracking` [P4]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `client_platform` | S | party_id (organisation), code (snoonu ...), name, adapter_kind (sheet, excel, api), status | The "client platforms" lookup screen edits this table |
| `sync_source` | S | client_platform_id, adapter_kind, config_encrypted (spreadsheet id, range), schedule_cron (0 4 * * *), time_zone, active | |
| `column_mapping` | S | sync_source_id, version, mapping JSONB (sheet header to field, aliases), valid_from | Versioned, so renamed columns are tracked |
| `metric_definition` | S | client_platform_id, key, label JSONB, unit, aggregation (sum, avg, max), is_core | So that "every other metric" in the sheet can be shown |
| `sync_run` | A | sync_source_id, business_date, trigger (scheduled, manual, reimport), status, rows_read, matched, unmatched, errors_count, raw_input_id, layout_changed, superseded_by_run_id, started_at, finished_at | Run log |
| `sync_run_error` | A | sync_run_id, row_no, code, message | |
| `daily_performance` | A, partitioned by business_date | sync_run_id, client_platform_id, business_date, party_id (null if unmatched), external_id, orders_completed, login_at, shift_start, late_minutes, working_minutes, online_minutes, accepted, rejected, cancelled, earnings (money), cod (money), metrics JSONB (all other columns), is_current | A re-import inserts new rows and flips `is_current` on the old ones, so history is kept and the job is idempotent |
| `unmatched_identifier` | S | client_platform_id, external_id, first_seen, last_seen, status (open, linked, created, ignored), resolved_party_id | |
| `tracking_entry` | S | party_id, business_date, status_code, reason_id, effective_date, note, caller_user_id | One row per change; current = latest. History is never overwritten. |
| `id_operator_period` | S | party_identifier_id, owner_party_id, operator_party_id, operator_name, operator_phone, from_date, to_date, cod_at_handover (money), orders_at_handover | "Another person" working the ID (SPEC 3.3) |
| `call_log` | A | party_id, business_date, caller_user_id, outcome_id (answered, no_answer, switched_off), note, at | |
| `worker_checkin` | A | party_id, business_date, response (working, off), channel (app, whatsapp), at | [P9] pre-fills tracking |

### 3.12 `inventory` [P5]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `item` | S | code, name JSONB, category_id, has_sizes, unit, low_stock_threshold, default_loss_fine (money), active | Seed: T-shirt, pants, thermal bag, helmet ... |
| `item_variant` | S | item_id, size_code, sku | |
| `stock_location` | S+B | name, kind (office, warehouse) | |
| `stock_movement` | A | number, movement_date, type (received_from_client, issued, returned_by_employee, lost, damaged, returned_to_client, adjustment), item_variant_id, quantity (signed), location_id, holder_party_id, client_platform_id, handover_slip_id, reference, note, reversal_of_id | Stock is always derived from this table |
| `handover_slip` | S | number, party_id, issue_date, generated_document_id, signed_file_id, status (generated, signed) | |
| `loss_record` | S | stock_movement_id, party_id, fine_charged, fine (money), deduct_from_salary, suggested_deduction_id | Flows to payroll as a suggestion |

### 3.13 `fleet` [P5]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `vehicle` | S+B | vehicle_type_id (bike, car), make, model, year, colour, plate_number, chassis_number, owner_kind (company, third_party, worker), owner_party_id, status_code, custom_fields JSONB | Documents use `people.document` with owner_type = vehicle |
| `vehicle_terms` | S | vehicle_id, valid_from/to, rent (money), service_charge (money), payee_party_id, due_day, terms_note, charge_to_worker (formula ref) | Effective-dated |
| `vehicle_assignment` | S | vehicle_id, party_id, from_date, to_date | Exclusion constraint allows one current user; reassigning closes the previous period |
| `maintenance_log` | S | vehicle_id, date, odometer_km, work_done, cost (money), workshop_party_id, next_due_date, next_due_km, journal_id | |
| `vehicle_due` | S | vehicle_id, period (YYYY-MM), kind (rent, service_charge), amount (money), payee_party_id, due_date, status (derived: due, partial, paid) | Unique (vehicle, period, kind) |
| `vehicle_due_payment` | A | vehicle_due_id, paid_on, amount (money), method_id, reference, receipt_file_id, cash_location_id, journal_id, reversal_of_id | |
| `traffic_violation` | S | vehicle_id, violation_at, reference_no, authority, description, amount (money), attributed_party_id, attribution (auto, manual), dispute_status, paid_status, deduct_from_salary, suggested_deduction_id, journal_id | Attributed to the assignment active on the violation date |
| `incident` | S+B | number, occurred_at, place, geo, vehicle_id, description, police_report_file_id, insurance_claim_status, repair_cost (money), liability_decision, recovery (money), suggested_deduction_id | |
| `incident_party` | S | incident_id, party_id, role (driver, third_party, witness) | |

### 3.14 `commercial`: rates and charges [P6]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `commercial_profile` | S | party_id, valid_from/to, office_charge_kind (fixed, per_order, percent), office_charge_value, accommodation_borne_by (company, worker), notes | One profile per employee, effective-dated |
| `commercial_rate_line` | S | profile_id, client_platform_id, vehicle_type_id, slab_min, slab_max, rate (money) | The person's order rate |
| `company_borne_cost` | S | party_id, expense_type_id, amount (money), recurrence (one_time, monthly), valid_from/to | |
| `sim_card` | S | number, provider, plan, monthly_amount (money), status | |
| `sim_assignment` | S | sim_card_id, party_id, from_date, to_date | |
| `sim_bill` | S | sim_card_id, period, amount (money), raw_input_id, journal_id | Monthly bill entry |

### 3.15 `loans`: loans, fund, investors and cash book [P6; loan application in P9]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `borrower` | S | party_id, borrower_type (employee, office_staff, external, company), notes | Party role with its own attributes |
| `loan` | S | number (L0001 ...), borrower_id, loan_date, principal (money), monthly_interest_pct NUMERIC(9,6), term_months, purpose_id, note, repayment_plan (instalment, free), instalment (money), origin (manual, application, negative_salary, imported), lifecycle (draft, awaiting_signature, posted, reversed), interest_amount, total_payable, due_date, loan_paper_document_id, signed_file_id, application_id, journal_id, posted_at | Interest, total and due date are fixed at posting. The status (Paid, Overdue ...) is derived and never stored. |
| `loan_adjustment` | A | loan_id, kind (discount, write_off), date, amount (money), reason, approved_by, journal_id, reversal_of_id | Permission-controlled |
| `loan_payment` | A | number, borrower_id, payment_date, amount (money), method_id, note, receipt_file_id, source (manual, salary, import), payslip_id, cash_location_id, duplicate_acknowledged, journal_id, reversal_of_id | |
| `loan_payment_allocation` | A | loan_payment_id, loan_id, amount, principal_part, interest_part | Chosen loan, or oldest first with splitting |
| `loan_application` | S | number, applicant_party_id, amount (money), purpose_id, preferred_repayment, approved_amount, status_code, workflow_instance_id, loan_id, risk_snapshot JSONB | Worker portal |
| `investor` | S | party_id, notes, user_account_id (optional read-only login) | |
| `investor_transaction` | A | investor_id, date, kind (deposit, withdraw), amount (money), note, file_id, cash_location_id, journal_id, reversal_of_id | |
| `cash_transfer` | A | from_location_id, to_location_id, date, amount (money), note, journal_id, reversal_of_id | |
| `petty_cash_entry` | A | cash_location_id, date, kind (collection, cost), source_or_reason, category_id, amount (money), receipt_file_id, journal_id, reversal_of_id | |
| `cash_count` | A | cash_location_id, counted_at, counted (money), system_balance (money), difference (money), note, journal_id | |
| `workbook_import` | S | raw_input_id, status (staged, matched, reconciled, confirmed, discarded), staged JSONB, workbook_totals JSONB, system_totals JSONB, confirmed_by | One-time import (SPEC 4.6) |
| `workbook_import_match` | S | workbook_import_id, sheet_row, workbook_name, workbook_snoonu_id, party_id, borrower_type, status | Manual matching of borrowers |

### 3.16 `payroll`: payroll and payments [P7]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `pay_component` | S | key, name JSONB, kind (earning, deduction, employer_cost, information), calc_order, formula_id, data_source_key, posting_event_key, show_on_slip, allows_exceptional, recovery_priority, carry_forward_target (loan, cod, none), file_aliases TEXT[], valid_from/to | Seeded with every column in SPEC 4.7 |
| `pay_policy` | S | valid_from/to, min_take_home_formula_id, max_deduction_formula_id, tolerance (money), negative_net_handling (carry_to_loan) | |
| `pay_period` | S | year, month, client_platform_id (nullable, see section 6), start_date, end_date, status (open, closed) | |
| `payroll_run` | S | number, pay_period_id, run_type (regular, final_settlement, bonus, correction, simulation), status (draft, reviewed, approved, posted, paid, reversed), calculated_at, rules_snapshot JSONB, source_upload_id, journal_id, reversal_of_id, exit_case_id | A partial unique index allows one live regular run per period |
| `payslip` | S | number, payroll_run_id, party_id, label (for example "second ID"), profession, falcon_id_snapshot, per_order_rate, total_earnings, total_deductions, net, net_payable, carried_forward, currency, status (draft, generated, approved, paid), approved_by, reopened_reason, pdf_document_id, paid_on, payment_method | Approved payslips are locked |
| `payslip_line` | S | payslip_id, pay_component_id, amount, source (engine, excel, manual, suggested), inputs JSONB, formula_version_id, trace JSONB, is_exceptional, reason, overridden_value, override_reason | "How was this calculated" |
| `salary_upload` | S | pay_period_id, raw_input_id, mapping_id, status (previewed, confirmed, discarded), file_totals JSONB, computed_totals JSONB, issues JSONB | |
| `salary_upload_row` | A | salary_upload_id, row_no, external_id, party_id, raw JSONB, normalised JSONB, issues JSONB | |
| `payroll_comparison` | S | payroll_run_id, payslip_id, pay_component_id, engine, excel, client, difference, explained, explanation, resolved_by | Three-way check |
| `suggested_deduction` | S | party_id, source_module, source_type, source_id, pay_component_key, amount (money), target_period, status (pending, applied, waived), payslip_line_id, waive_reason | Inbound queue fed by inventory, fleet, accommodation, revenue and tracking |
| `payment_batch` | S | number, payroll_run_id, method (wps, bank, cash, wallet), company_bank_account_id, status (draft, validated, file_generated, sent, reconciled), file_document_id, validation_errors JSONB | |
| `payment_instruction` | S | payment_batch_id, payslip_id, party_id, amount (money), bank_account_id, status (pending, paid, failed, returned), paid_at, bank_reference, receipt_confirmed_at, signature_id, journal_id | One person's pay can be split across several instructions |
| `bank_file_template` | S | kind (wps_sif, bulk_transfer, result_import), bank, version, layout JSONB, valid_from | Configurable layouts |
| `bank_result_import` | S | payment_batch_id, raw_input_id, matched, failed, status | |
| `company_expense` | S | number, date, category_id, purpose, amount (money), paid_from_location_id, receipt_file_id, journal_id, reversal_of_id, status | Seeded categories: Office Rent, Utility, Government Fees, Marketing, Other |
| `other_income` | S | date, category_id, description, amount (money), journal_id | |
| `legacy_payroll_import` | S | raw_input_id, pay_period_id, status, stats JSONB | Import from the old app's tables |

### 3.17 `revenue`: contracts, invoicing and receivables [P8]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `client_contract` | S | client_platform_id, number, start_date, end_date, renewal_notice_days, status, file_id | |
| `rate_card` | S | client_contract_id, version, valid_from/to, status | |
| `rate_card_item` | S | rate_card_id, component (per_order, bonus, penalty, fixed_fee, minimum_guarantee), formula_version_id, dims JSONB | Rates are formulas |
| `billing_period` | S | client_platform_id, start_date, end_date, status | |
| `expected_revenue_line` | S | billing_period_id, party_id, component, quantity, rate, amount (money), trace JSONB | |
| `client_invoice` | S | number, client_platform_id, billing_period_id, issue_date, due_date, total (money), status (draft, issued, part_paid, paid, credited), document_id, journal_id, credit_of_id | |
| `client_invoice_line` | S | invoice_id, description, quantity, rate, amount, tax_code_id | |
| `client_statement` | S | client_platform_id, billing_period_id, raw_input_id, status | |
| `client_statement_line` | S | statement_id, external_id, party_id, orders, rate, bonus, penalty, cod_adjustment, amount (money) | |
| `statement_recon_line` | S | statement_id, party_id, component, expected, statement, difference, reason_code, dispute_id | |
| `dispute` | S | number, client_platform_id, amount (money), status_code, notes, resolved_at | |
| `client_receipt` | A | date, client_platform_id, amount (money), bank_statement_line_id, journal_id, reversal_of_id | |
| `receipt_allocation` | A | client_receipt_id, invoice_id, amount | |

### 3.18 `accounting`: payables [P8]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `supplier_bill` | S | number, payee_party_id, bill_date, due_date, total (money), status (draft, submitted, approved, posted, part_paid, paid), workflow_instance_id, journal_id | Vehicle owners, landlords, garages, telecom, government fees |
| `supplier_bill_line` | S | bill_id, account_id, expense_type_id, amount, tax_code_id, dims JSONB | |
| `recurring_bill` | S | payee_party_id, template JSONB, cron, next_run_on, active | |
| `payable_payment` | A | bill_id, date, amount (money), cash_location_id, method_id, journal_id, reversal_of_id | |

### 3.19 `operations`: onboarding, agents, accommodation, HR, exit, workforce [P10]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `pipeline` | S | key, name | |
| `pipeline_stage` | S | pipeline_id, code, name JSONB, order_no, target_days, required_items JSONB, is_final | Default: Interview ... Active |
| `candidate` | S+B | party_id, pipeline_id, stage_id, entered_stage_at, agent_party_id, profession, target_platform_id, converted_employee_id | |
| `candidate_stage_history` | A | candidate_id, from_stage_id, to_stage_id, moved_by, moved_at | |
| `candidate_item` | S | candidate_id, stage_id, item_key, done, file_id | |
| `agent_deposit` | S | agent_party_id, worker_party_id, agreed (money), refund_due_date, status | |
| `agent_deposit_txn` | A | agent_deposit_id, kind (received, refunded), date, amount (money), receipt_file_id, journal_id, reversal_of_id | |
| `accommodation` | S+B | name, building, address, landlord_party_id, lease_start, lease_expiry, monthly_rent (money), status | Lease expiry uses the expiry engine |
| `room` | S | accommodation_id, name, capacity | |
| `occupancy` | S | room_id, party_id, move_in, move_out | |
| `accommodation_bill` | S | accommodation_id, period, kind_id (rent, electricity, water ...), amount (money), supplier_bill_id | |
| `cost_allocation_run` | S | period, status, journal_id | Pro-rated by days stayed |
| `cost_allocation_line` | A | run_id, accommodation_id, party_id, days, share (money), borne_by (company, worker), suggested_deduction_id | |
| `leave_type` | S | code, name JSONB, accrual_formula_id, paid, affects_tracking_status | |
| `leave_ledger` | A | party_id, leave_type_id, date, days (signed), source | Balances are derived |
| `leave_request` | S | number, party_id, leave_type_id, from_date, to_date, expected_return, workflow_instance_id, status_code | |
| `passport_custody` | S | party_id, handed_in_on, handed_out_on, reason, received_by | |
| `disciplinary_record` | S | party_id, kind (warning, client_complaint, quality_violation), date, details, acknowledged_at, signature_id | |
| `exit_case` | S | number, employee_id, exit_type_id, reason, last_working_day, status_code, workflow_instance_id, settlement_run_id, clearance_document_id, rehire_eligible | |
| `exit_clearance_item` | S | exit_case_id, department, kind (loan, cod, merchandise, vehicle, fines, sim, accommodation, deposit, salary, penalty), amount_snapshot (money), status, task_id, note | |
| `platform_id_deactivation` | S | party_identifier_id, exit_case_id, requested_on, confirmed_on | |
| `headcount_target` | S | client_platform_id, org_unit_id, profession, period_start, period_end, target | |
| `visa_quota` | S | category, nationality_code, total, used, valid_to | |
| `shift` | S | client_platform_id, org_unit_id, date, start_time, end_time, capacity | |
| `shift_assignment` | S | shift_id, party_id, status | |
| `shift_swap_request` | S | from_assignment_id, to_party_id, status, workflow_instance_id | |

### 3.20 `esign` [P9]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `signature_request` | S | generated_document_id, signer_party_id, method (drawn_otp, paper), status (pending, signed, declined, expired), expires_at | |
| `signature` | A | request_id, signer_party_id, signed_at, ip, device, geo, image_file_id, document_sha256, stamped_file_id, otp_challenge_id | |

### 3.21 `risk` [P11]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `risk_rule` | S | key, name, formula_id, severity, weight, evaluation (event, nightly), active | Seeded with the 11 rules in SPEC 5.14 |
| `risk_signal` | A, partitioned | rule_id, party_id, subject_user_id, observed_on, value, factors JSONB | |
| `risk_score` | S | party_id, source (rules, model:<key>), score, as_of, factors JSONB | Several sources are supported |
| `risk_case` | S | number, party_id, rule_id, owner_user_id, status_code, outcome | |
| `risk_case_note` | A | case_id, kind (note, action), body, by | |

### 3.22 `ai` [P11]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `ai_conversation` | S | user_id, language, title | |
| `ai_message` | A | conversation_id, role, content, tokens_in, tokens_out, cost (money) | |
| `ai_tool_call` | A, partitioned | message_id, tool_key, params JSONB, result_summary, row_count, duration_ms, at | Also written to the audit log |
| `ai_action_proposal` | S | conversation_id, api_method, api_path, payload JSONB, status (proposed, confirmed, rejected, executed), executed_request_id | Confirmed by a human, then run through the normal API |
| `ai_usage` | A | period, user_id, tokens, cost (money) | |

### 3.23 `telematics` and `privacy` [P11; privacy registers in P12]

| Table | Tag | Key columns | Relations and notes |
| --- | --- | --- | --- |
| `telemetry_device` | S | kind, external_id, vehicle_id, party_id, adapter_config_id | |
| `location_point` | A, partitioned | device_id, party_id, vehicle_id, recorded_at, lat, lon, speed, heading, accuracy, source | Accepted only within consent and working hours |
| `consent_record` | S | party_id, purpose_key, granted_at, revoked_at, evidence_file_id | |
| `processing_purpose` | S | key, data_categories TEXT[], legal_basis, retention_policy_id | Processing register |
| `data_subject_request` | S | number, party_id, kind (access, correction, deletion), status, due_on, outcome | Deletion means anonymisation (see section 6) |
| `compliance_rule` | S | key, formula_id, severity | WPS on time, deduction limits, valid documents |
| `compliance_breach` | S | rule_id, party_id, detected_on, status, note | |

### 3.24 `reporting` schema (read-only, refreshed by jobs)

Materialised views, which are also the base of the semantic layer and the AI tools:

- Performance and staff: `mv_performance_daily`, `mv_performance_monthly`, `mv_headcount`, `mv_document_compliance`
- Balances: `mv_party_balance` (per party and control account), `mv_loan_balance` (principal, interest, paid and balance per loan), `mv_fund_cash_book`
- Payroll, revenue and costs: `mv_payroll_summary`, `mv_platform_margin`, `mv_vehicle_cost`
- Star schema for BI: `dim_party`, `dim_date`, `fact_orders`, `fact_ledger`

A separate `fibrex_bi` role has `SELECT` on this schema only.

---

## 4. Folder structure

```
fibrex/
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ main.ts                    # HTTP server bootstrap
│  │  │  ├─ worker.ts                  # BullMQ workers: jobs, outbox relay, PDF rendering
│  │  │  ├─ kernel/                    # shared layers that every module gets for free
│  │  │  │  ├─ config/                 # env schema (Zod), feature flags
│  │  │  │  ├─ db/                     # Prisma client, tenant context (SET LOCAL), unit of work, soft-delete extension, optimistic lock
│  │  │  │  ├─ auth/                   # JWT, refresh rotation, sessions, MFA, OTP, impersonation
│  │  │  │  ├─ permissions/            # can(user, action, resource), scope resolution, route middleware
│  │  │  │  ├─ audit/                  # AuditService, request context, hash-chain sealing
│  │  │  │  ├─ events/                 # outbox writer, relay, consumer registry
│  │  │  │  ├─ jobs/                   # queue factory, schedules, job monitor
│  │  │  │  ├─ files/                  # upload, versioned attachments, signed URLs
│  │  │  │  ├─ crypto/                 # envelope encryption, blind index, masking
│  │  │  │  ├─ http/                   # error handler, idempotency, rate limit, Helmet, CORS, CSRF, OpenAPI registry
│  │  │  │  ├─ money/                  # Decimal helpers, currency conversion
│  │  │  │  ├─ observability/          # OpenTelemetry, pino logger, request id
│  │  │  │  ├─ realtime/               # Socket.IO with Redis adapter
│  │  │  │  ├─ search/                 # SearchService interface + Postgres implementation
│  │  │  │  ├─ crud/                   # generic list/get/create/update/delete/restore/history/export controller factory
│  │  │  │  └─ module-registry/        # loads manifests: routes, permissions, menus, events, reports, widgets, settings
│  │  │  ├─ adapters/                  # one folder per adapter kind: interface.ts, stub.ts, <provider>.ts
│  │  │  │  ├─ client-report/  (snoonu-sheet)   ├─ messaging/ (smtp, whatsapp, sms, push)
│  │  │  │  ├─ ocr/  ├─ llm/  ├─ esign/  ├─ storage/ (s3)  ├─ bank-file/  ├─ accounting/
│  │  │  │  ├─ kms/  ├─ maps/  └─ identity/
│  │  │  └─ modules/                   # one folder per module; only index.ts is importable by others
│  │  │     ├─ platform/  iam/  audit/  notifications/  party/  files/
│  │  │     ├─ lookups/  entities/  formulas/  workflow/  state-machines/  templates/
│  │  │     ├─ numbering/  automation/  service-catalog/  reports/  integration/  ledger/
│  │  │     ├─ people/  performance/  tracking/  inventory/  fleet/  commercial/
│  │  │     ├─ loans/  payroll/  payments/  revenue/  accounting/
│  │  │     ├─ onboarding/  agents/  accommodation/  hr/  exit/  workforce/
│  │  │     ├─ esign/  portal/  dashboard/  risk/  analytics/  ai/  telematics/  privacy/
│  │  │     └─ <module>/                # layout of every module:
│  │  │        ├─ manifest.ts           # routes, permissions, menu, events, reports, widgets, settings, automation triggers
│  │  │        ├─ index.ts              # public typed service interface + event contracts
│  │  │        ├─ routes.ts  controller.ts  service.ts  repository.ts
│  │  │        ├─ posting.ts            # (money modules) builds posting requests for the ledger service
│  │  │        ├─ jobs/  reports/  seeds/
│  │  │        └─ __tests__/            # unit + integration tests
│  │  ├─ prisma/
│  │  │  ├─ schema/                    # multi-file Prisma schema, one file per module
│  │  │  ├─ migrations/                # Prisma migrations + hand-written SQL (RLS, partitions, triggers, exclusion constraints)
│  │  │  └─ seed/                      # synthetic seed data only (5,000-worker generator for load tests)
│  │  └─ test/                         # integration test harness (Testcontainers Postgres + Redis)
│  └─ web/
│     ├─ src/
│     │  ├─ app/                       # router, providers, app shell (sidebar, top bar, Ctrl+K search)
│     │  ├─ design-system/             # tokens, theme (light/dark), shadcn/ui components
│     │  ├─ components/                # DataTable, EntityForm, HistoryTab, ReportPage, Kanban, FileUpload, SignaturePad
│     │  ├─ lib/                       # API client, can(), i18n setup, query client, offline queue
│     │  ├─ features/<module>/         # pages, page-config, hooks (no business logic)
│     │  ├─ portal/                    # worker PWA routes (mobile-first)
│     │  └─ locales/<lang>/            # en, bn, ar (RTL), ur, hi, ne
│     ├─ public/  (manifest.webmanifest, icons)
│     └─ e2e/                          # Playwright journeys
├─ packages/
│  ├─ shared/                          # Zod schemas per module, permission keys, event contracts, Decimal money, enums
│  ├─ formula/                         # sandboxed expression engine wrapper (used by the API and by the admin preview)
│  ├─ eslint-config/                   # includes module-boundary rules
│  └─ tsconfig/
├─ infra/
│  ├─ docker/                          # Dockerfiles (api, worker, web), Postgres init (roles)
│  ├─ terraform/                       # staging and production (once hosting is chosen)
│  └─ runbooks/
├─ docs/                               # SPEC, PLAN, PROGRESS, DECISIONS, ARCHITECTURE, ADDING_A_MODULE, ADDING_A_REPORT, ER diagram, ADRs, data dictionary
├─ reference/                          # real files, ignored by Git
├─ .github/workflows/                  # ci.yml (lint, typecheck, test, scans, migration check), deploy-staging.yml, deploy-prod.yml
├─ docker-compose.yml                  # web, api, worker, postgres, redis, minio, mailpit
├─ pnpm-workspace.yaml  package.json  .env.example  CLAUDE.md
```

Rules enforced by tooling:

- ESLint `boundaries` rules stop a module from importing another module's files except through its `index.ts`.
- No business logic is allowed in controllers or React components.

---

## 5. API endpoints per module

### 5.1 Conventions

- Base path `/api/v1`. JSON bodies, validated by Zod schemas from `packages/shared`. OpenAPI is generated from the same schemas and served at `/api/v1/openapi.json` and `/api/docs`.
- Headers:
  - `Authorization: Bearer <access token>`, or `X-Api-Key` for integrations
  - `X-Company-Id` selects the company context
  - `Idempotency-Key` is required on every POST, PUT, PATCH and DELETE
  - `If-Match: <version>` is required on updates
- **CRUD+ pattern.** Resources marked CRUD+ get all of the following from the kernel's CRUD factory, each with a permission check, audit and soft delete:

| Method and path | Purpose |
| --- | --- |
| `GET /x` | Search, filters, sort, page, `columns` |
| `POST /x` | Create |
| `GET /x/:id` | Read one |
| `PATCH /x/:id` | Update |
| `DELETE /x/:id` | Soft delete, reason required |
| `POST /x/:id/restore` | Restore |
| `GET /x/:id/history` | History tab |
| `GET /x/export?format=xlsx\|pdf\|csv` | Export |
| `POST /x/import` | Import (where the resource is marked importable) |

- Resources marked **posted-only** (immutable financial documents) support `GET`, `POST` and `POST /:id/reverse`. They have no PATCH and no DELETE.

### 5.2 Health, documentation and system [P1]

| Method and path | Purpose |
| --- | --- |
| `GET /health`, `GET /ready` | Health checks |
| `GET /openapi.json` | OpenAPI document |
| `GET /search?q=` | Global Ctrl+K search: employees, vehicles, Falcon IDs, plates |
| `GET /jobs/queues`, `GET /jobs/:queue/:state`, `POST /jobs/:queue/:id/retry` | Job monitor |
| `GET /admin/tenants`, `POST /admin/tenants`, `GET /admin/plans`, `GET /admin/usage`, `GET /admin/integration-health` | Platform operator console |

### 5.3 Auth and IAM [P1]

| Method and path | Purpose |
| --- | --- |
| `POST /auth/login` | Username or phone + password |
| `POST /auth/otp/request`, `POST /auth/otp/verify` | Phone one-time code |
| `POST /auth/mfa/verify` | TOTP step |
| `POST /auth/refresh` | Rotating refresh cookie |
| `POST /auth/logout` | |
| `POST /auth/password/change`, `POST /auth/password/forgot`, `POST /auth/password/reset` | |
| `POST /auth/mfa/totp/setup`, `POST /auth/mfa/totp/confirm`, `DELETE /auth/mfa/totp` | |
| `POST /auth/reauth` | Step-up for sensitive actions |
| `POST /oauth/token` | Client credentials for integrations |
| `GET /me`, `GET /me/permissions`, `POST /me/switch-company` | |
| `GET /me/sessions`, `DELETE /me/sessions/:id`, `GET /me/login-history` | |
| `/users` CRUD+ | |
| `POST /users/:id/lock`, `/unlock`, `/reset-password`, `/force-logout` | |
| `GET /users/:id/sessions`, `GET /users/:id/login-history` | |
| `PUT /users/:id/memberships` | Companies and roles |
| `GET/PUT /users/:id/permission-overrides`, `GET/PUT /users/:id/scopes` | |
| `/roles` CRUD+, `GET/PUT /roles/:id/grantable-roles`, `GET/PUT /roles/:id/scopes` | |
| `GET /permissions` | Catalogue |
| `GET /permission-matrix`, `PUT /permission-matrix` | Bulk tick-box save |
| `POST /impersonations`, `DELETE /impersonations/current` | |
| `/api-clients` CRUD+, `POST /api-clients/:id/keys`, `DELETE /api-clients/:id/keys/:keyId` | |

### 5.4 Platform and companies [P1]

| Method and path | Purpose |
| --- | --- |
| `/companies` CRUD+, `GET/PUT /companies/:id/settings`, `GET/PUT /companies/:id/modules` | Feature flags |
| `/branches` CRUD+, `/org-units` CRUD+ (zones and teams), `/number-sequences` CRUD+ | |
| `GET /settings/:key`, `PUT /settings/:key` | Tenant, company or user scope |
| `GET /currencies` | |

### 5.5 Audit and recycle bin [P1]

| Method and path | Purpose |
| --- | --- |
| `GET /audit-log` | Filters: user, module, action, date range |
| `GET /audit-log/export`, `GET /audit-log/verify` | Export; hash-chain check |
| `GET /history/:entityType/:entityId` | |
| `GET /recycle-bin?module=&entityType=` | |
| `POST /recycle-bin/:entityType/:id/restore` | |

### 5.6 Notifications [P1; channels and broadcasts in P9]

| Method and path | Purpose |
| --- | --- |
| `GET /notifications`, `GET /notifications/unread-count` | |
| `POST /notifications/:id/read`, `POST /notifications/read-all` | |
| `GET/PUT /me/notification-preferences` | |
| `/notification-rules` CRUD+, `POST /notification-rules/:id/test` | |
| `GET/PUT /channel-fallback` | |
| `POST /push-subscriptions`, `DELETE /push-subscriptions/:id` | |
| Socket.IO namespace `/realtime` | Rooms per user and per company |
| `/broadcasts` CRUD+, `POST /broadcasts/:id/preview`, `/schedule`, `/send` | [P9] |
| `GET /inbox`, `POST /inbox/:id/assign`, `/attach`, `/resolve` | [P9] staff inbox |
| `GET /parties/:id/messages`, `/opt-ins` CRUD+ | [P9] |
| `POST /webhooks/inbound/:provider` | [P9] signed provider callbacks |

### 5.7 Party [P1]

| Method and path | Purpose |
| --- | --- |
| `/parties` CRUD+ | Search by name, phone, ID |
| `GET/POST /parties/:id/roles`, `PATCH /party-roles/:id` | Close a role period |
| `/parties/:id/identifiers` CRUD+, `GET /identifiers/lookup?type=&value=` | |
| `/parties/:id/contacts`, `/addresses`, `/relationships` CRUD+ | |
| `/parties/:id/bank-accounts` CRUD+, `POST /bank-accounts/:id/verify`, `POST /bank-accounts/:id/approve` | The second person approves |
| `GET /party-duplicates`, `POST /party-duplicates/:id/dismiss` | |
| `POST /party-merges/preview`, `POST /party-merges` | |

### 5.8 Files [P1]

| Method and path | Purpose |
| --- | --- |
| `POST /files/upload-url`, `POST /files/complete` | Checksum and type checks |
| `GET /files/:id/download-url` | Permission check + audit, short-lived |
| `GET /attachments?entityType=&entityId=`, `POST /attachments` | |
| `POST /attachments/:id/versions`, `GET /attachments/:id/versions` | |

### 5.9 Engines [P2]

| Area | Method and path |
| --- | --- |
| Lookups | `/lookup-types` CRUD+, `/lookup-types/:key/values` CRUD+, `GET /lookups/:key` (cached dropdown) |
| Entities | `/entity-definitions` CRUD+, `POST /entity-definitions/:id/publish`, `/entity-definitions/:id/fields` CRUD+, `POST /fields/:id/promote` |
| Custom records | `/records/:entityKey` CRUD+ (importable), `POST /records/:entityKey/:id/transition` |
| Formulas | `/formulas` CRUD+, `/formulas/:id/versions` CRUD+, `POST /formulas/:id/versions/:vid/test`, `POST /formulas/:id/versions/:vid/activate`, `POST /formulas/evaluate` (preview with explanation) |
| Rate tables | `/rate-tables` CRUD+, `/rate-tables/:id/rows` CRUD+, `GET /rate-tables/:key/resolve?dims=&date=` |
| State machines | `/state-machines` CRUD+ (states and transitions), `POST /transitions/:entityType/:id`, `GET /state-history/:entityType/:id` |
| Workflow | `/workflow-definitions` CRUD+, `POST /workflow-definitions/:id/versions/publish`, `/workflow-bindings` CRUD+ |
| | `GET /tasks` (my inbox), `POST /tasks/:id/approve`, `/reject`, `/send-back`, `/comment`, `/delegate` |
| | `GET /workflow-instances/:id` (timeline), `/delegations` CRUD+ |
| Templates | `/templates` CRUD+, `/templates/:id/versions` CRUD+, `POST /templates/:id/versions/:vid/preview` (PDF), `POST /templates/:id/versions/:vid/publish` |
| | `GET /generated-documents/:id`, `GET /generated-documents/:id/pdf` |
| Reports | `GET /reports` (permitted definitions), `GET /reports/:key/meta`, `POST /reports/:key/run`, `POST /reports/:key/export` |
| | `/saved-reports` CRUD+, `/report-schedules` CRUD+ |
| Retention | `/retention-policies` CRUD+, `GET /retention-runs` |

### 5.10 Integration [P2]

| Method and path | Purpose |
| --- | --- |
| `GET /event-types`, `GET /events?type=&from=` | Admin outbox browser |
| `/webhook-subscriptions` CRUD+, `GET /webhook-deliveries`, `POST /webhook-deliveries/:id/retry` | |
| `/import-mappings` CRUD+ | |
| `POST /imports` | Upload + entity key |
| `GET /imports/:id/preview`, `PUT /imports/:id/mapping`, `POST /imports/:id/commit`, `POST /imports/:id/rollback` | |
| `POST /exports`, `GET /exports/:id` | Bulk async |
| `GET /adapters`, `PUT /adapters/:kind`, `POST /adapters/:kind/health-check` | |

### 5.11 Ledger [P2]

| Method and path | Purpose |
| --- | --- |
| `/accounts` CRUD+ (tree), `/cost-centres` CRUD+, `/tax-codes` CRUD+, `/exchange-rates` CRUD+ | |
| `/fiscal-years` CRUD+, `POST /fiscal-periods/:id/close`, `/lock`, `/reopen` | Reopen needs permission and a reason |
| `/posting-rules` CRUD+ (versioned), `POST /posting-rules/:eventKey/simulate` | |
| `GET /journals`, `GET /journals/:id`, `POST /journals/:id/reverse` | |
| `/manual-journals` CRUD+, `POST /manual-journals/:id/post` | |
| `GET /ledger/balances?account=&party=&dims=&asOf=` | Sub-ledger queries |
| `/cash-locations` CRUD+, `/company-bank-accounts` CRUD+ | |
| `POST /bank-statements` | Import |
| `GET /bank-statements/:id/lines`, `POST /bank-statements/:id/auto-match` | |
| `POST /reconciliation-matches`, `DELETE /reconciliation-matches/:id` | |
| `/bank-match-rules` CRUD+ | |
| Reports (report engine) | `ledger.trial_balance`, `ledger.general_ledger`, `ledger.party_statement` |

### 5.12 People and documents [P3]

| Method and path | Purpose |
| --- | --- |
| `/employees` CRUD+ (importable) | |
| `GET /employees/:id/profile`, `GET /employees/:id/tabs/:tab` | Tabs come from other modules through their service interfaces |
| `/employees/:id/placements` CRUD+ | |
| `/document-types` CRUD+, `/document-requirements` CRUD+ | |
| `/documents` CRUD+, `POST /documents/:id/files` | New version |
| `GET /documents/expiring?withinDays=`, `GET /documents/expiry-calendar?month=` | |
| `POST /ocr/jobs`, `GET /ocr/jobs/:id` | |
| `POST /bulk-uploads`, `GET /bulk-uploads/:id`, `POST /bulk-uploads/:id/items/:itemId/confirm`, `/reject` | |
| Reports | `people.missing_documents`, `people.expiring_documents`, `people.headcount` |

### 5.13 Performance and tracking [P4]

| Method and path | Purpose |
| --- | --- |
| `/client-platforms` CRUD+, `/sync-sources` CRUD+ | |
| `/sync-sources/:id/column-mappings` CRUD+, `POST /sync-sources/:id/test` | Reads headers only |
| `POST /sync-sources/:id/run` | Run now |
| `POST /sync-sources/:id/reimport` | Body: `{ from, to }` |
| `GET /sync-runs`, `GET /sync-runs/:id`, `GET /sync-runs/:id/errors`, `GET /sync-runs/:id/raw` | |
| `GET /unmatched-identifiers`, `POST /unmatched-identifiers/:id/link`, `/create-employee`, `/ignore` | |
| `/metric-definitions` CRUD+ | |
| `GET /performance/person/:partyId?from=&to=` | |
| Reports | `performance.daily`, `performance.monthly`, `performance.platform_margin` |
| `GET /tracking?date=` | Rows + summary strip |
| `PUT /tracking/:partyId/status` | Status, reason, effective date |
| `PUT /tracking/:partyId/operator`, `POST /tracking/:partyId/calls`, `GET /tracking/:partyId/history` | |
| `GET /tracking/cross-check?date=` | |

### 5.14 Inventory [P5]

| Method and path | Purpose |
| --- | --- |
| `/items` CRUD+ (with variants), `/stock-locations` CRUD+ | |
| `GET /stock`, `GET /stock/holdings?partyId=`, `GET /stock/movements` | |
| `POST /stock/receipts`, `/issues`, `/returns`, `/losses`, `/damages`, `/returns-to-client`, `/adjustments` | Posted-only movements; each can be reversed |
| `GET /handover-slips/:id/pdf`, `POST /handover-slips/:id/signed-copy` | |
| Report | `inventory.reconciliation` (summary at the top), `inventory.low_stock` |

### 5.15 Fleet and incidents [P5]

| Method and path | Purpose |
| --- | --- |
| `/vehicles` CRUD+ (importable), `/vehicles/:id/terms` CRUD+ | |
| `POST /vehicles/:id/assign`, `POST /vehicles/:id/unassign` | |
| `GET /vehicles/:id/assignments`, `GET /vehicles/:id/holder?at=` | |
| `/maintenance` CRUD+, `GET /maintenance/due` | |
| `GET /vehicle-dues`, `POST /vehicle-dues/generate` | Body: `{ period }` |
| `POST /vehicle-dues/:id/payments`, `POST /vehicle-due-payments/:id/reverse` | |
| `/traffic-violations` CRUD+ (importable), `POST /traffic-violations/:id/reattribute`, `/dispute`, `/mark-paid` | |
| `/incidents` CRUD+ | |
| Reports | `fleet.dues_by_month`, `fleet.dues_by_vehicle`, `fleet.dues_by_payee` |

### 5.16 Commercial [P6]

| Method and path | Purpose |
| --- | --- |
| `/commercial-profiles` CRUD+, `GET /employees/:id/commercial-profile?at=` | |
| `/company-borne-costs` CRUD+ | |
| `/sims` CRUD+, `POST /sims/:id/assign`, `/sim-bills` CRUD+ (importable) | |
| `GET /commercial/overview` | One screen for everyone |

### 5.17 Loans and fund [P6]

| Method and path | Purpose |
| --- | --- |
| `/borrowers` CRUD+, `GET /borrowers/:id/summary` | |
| `/loans` | GET, POST (draft), PATCH (draft only) |
| `POST /loans/:id/paper` | Generates the PDF; status becomes awaiting signature |
| `POST /loans/:id/signed-copy` | Upload, then post |
| `POST /loans/:id/post` | Company or imported loans only |
| `POST /loans/:id/reverse`, `POST /loans/:id/adjustments`, `GET /loans/:id/statement` | |
| `POST /loan-payments/preview-allocation`, `POST /loan-payments`, `GET /loan-payments`, `POST /loan-payments/:id/reverse` | |
| `/investors` CRUD+, `POST /investors/:id/transactions`, `POST /investor-transactions/:id/reverse`, `GET /investors/:id/statement` | |
| `GET /fund/summary` | Cards |
| `GET /fund/cash-book?from=&to=&location=` | |
| `POST /cash-transfers`, `POST /petty-cash`, `POST /cash-counts`, `GET /cash-counts` | |
| `POST /fund-imports` | Workbook upload |
| `GET /fund-imports/:id/preview`, `GET /fund-imports/:id/matches`, `PUT /fund-imports/:id/matches/:rowId` | |
| `GET /fund-imports/:id/reconciliation`, `POST /fund-imports/:id/confirm`, `/discard` | |
| Reports | `loans.outstanding_by_borrower`, `loans.outstanding_by_purpose`, `loans.ageing`, `loans.given_vs_collected`, `loans.recoveries_by_method`, `fund.investor_statement`, `fund.cash_book` |

### 5.18 Payroll and payments [P7]

| Method and path | Purpose |
| --- | --- |
| `/pay-components` CRUD+ (versioned), `GET/PUT /pay-policy` | |
| `/pay-periods` CRUD+, `POST /pay-periods/:id/close` | |
| `POST /payroll-runs`, `GET /payroll-runs`, `GET /payroll-runs/:id` | |
| `POST /payroll-runs/:id/calculate`, `/review`, `/approve`, `/post`, `/reverse` | Lifecycle |
| `POST /payroll-runs/:id/simulate` | Body: `{ overrides }` |
| `GET /payroll-runs/:id/comparison`, `POST /payroll-comparisons/:id/explain` | |
| `GET /payroll-runs/:id/summary.xlsx`, `GET /payroll-runs/:id/payslips.pdf`, `GET /payroll-runs/:id/payslips.zip` | |
| `GET /payslips`, `GET /payslips/:id`, `POST /payslips` | Manual "Create Salary Sheet" |
| `PATCH /payslips/:id` | Draft only |
| `POST /payslips/:id/duplicate` | Body: `{ label }` |
| `POST /payslips/:id/lines`, `PATCH /payslip-lines/:id`, `DELETE /payslip-lines/:id` | Draft only |
| `POST /payslips/:id/approve`, `/reopen`, `GET /payslips/:id/pdf`, `GET /payslips/:id/explain` | |
| `POST /payslips/bulk-approve`, `POST /payslips/bulk-mark-paid` | |
| `GET /salary-uploads/template`, `POST /salary-uploads`, `GET /salary-uploads/:id/preview` | |
| `PUT /salary-uploads/:id/mapping`, `POST /salary-uploads/:id/confirm`, `/discard` | |
| `GET /suggested-deductions`, `POST /suggested-deductions/:id/waive` | |
| `POST /payment-batches`, `GET /payment-batches`, `GET /payment-batches/:id` | |
| `POST /payment-batches/:id/validate`, `/generate-file`, `GET /payment-batches/:id/file`, `POST /payment-batches/:id/results` | |
| `GET /payment-batches/:id/cash-sheet.pdf`, `POST /payment-instructions/:id/mark`, `GET /payment-instructions/failed` | |
| `/bank-file-templates` CRUD+ | |
| `/company-expenses` CRUD+ (posted-only after posting), `/other-income` CRUD+ | |
| `POST /payroll-legacy-imports`, `GET /payroll-legacy-imports/:id/preview`, `POST /payroll-legacy-imports/:id/confirm` | |
| Reports | `payroll.period_summary`, `pnl.operational` (month, quarter, year, previous-period comparison) |

### 5.19 Revenue [P8]

| Method and path | Purpose |
| --- | --- |
| `/client-contracts` CRUD+, `/rate-cards` CRUD+ (items) | |
| `/billing-periods` CRUD+, `POST /billing-periods/:id/compute-expected`, `GET /billing-periods/:id/expected` | |
| `/client-invoices` CRUD+ (draft), `POST /client-invoices/:id/issue`, `/credit-note`, `GET /client-invoices/:id/pdf` | |
| `POST /client-statements`, `GET /client-statements/:id/reconciliation`, `POST /statement-recon-lines/:id/dispute` | |
| `/disputes` CRUD+ (with transitions) | |
| `POST /client-receipts`, `POST /client-receipts/:id/allocate`, `/reverse` | |
| Reports | `revenue.receivables_ageing`, `revenue.margin` |

### 5.20 Accounting [P8]

| Method and path | Purpose |
| --- | --- |
| `/supplier-bills` CRUD+, `POST /supplier-bills/:id/submit`, `/post`, `POST /supplier-bills/:id/payments` | |
| `/recurring-bills` CRUD+ | |
| `/budgets` CRUD+ (lines) | |
| `GET /period-close/:periodId`, `POST /period-close/:periodId/tasks/:taskId/done` | |
| `/fixed-assets` CRUD+, `POST /depreciation/run` | |
| `POST /opening-balances` | Import |
| `GET /accounting-sync`, `POST /accounting-sync/run`, `/external-sync-maps` CRUD+ | |
| Reports | `acct.pnl`, `acct.balance_sheet`, `acct.cash_flow`, `acct.ap_ageing`, `acct.budget_vs_actual` (all with drill-down) |

### 5.21 Worker portal and e-signature [P9]

| Method and path | Purpose |
| --- | --- |
| `GET /me/profile`, `GET /me/documents`, `POST /me/documents/:id/renewal` | |
| `GET /me/items`, `GET /me/vehicle`, `GET /me/performance?from=&to=` | |
| `GET /me/payslips`, `GET /me/payslips/:id/pdf` | |
| `GET /me/loans`, `POST /me/loan-applications`, `GET /me/loan-applications/:id` | Live tracker |
| `POST /me/check-in`, `POST /me/incidents`, `GET /me/notices` | |
| `POST /me/payment-instructions/:id/confirm-receipt`, `PUT /me/language` | |
| `POST /me/service-requests`, `GET /me/service-requests` | |
| `GET /loan-applications`, `POST /loan-applications/:id/disburse` | Manager step; approvals go through `/tasks` |
| `/service-catalog` CRUD+, `GET /service-requests` | |
| `POST /signature-requests`, `GET /signature-requests/:id`, `POST /signature-requests/:id/otp`, `/sign` | |
| `GET /signatures/:id/verify` | |

### 5.22 Operations modules [P10]

| Area | Method and path |
| --- | --- |
| Dashboard | `GET /dashboard/widgets`, `GET /dashboard/widgets/:key/data` |
| Onboarding | `/pipelines` CRUD+ (stages), `/candidates` CRUD+, `GET /candidates/board`, `POST /candidates/:id/move`, `/convert` |
| Agents and deposits | `GET /agents`, `GET /agents/:id/workers`, `GET /agents/:id/deposit-summary`, `/agent-deposits` CRUD+, `POST /agent-deposits/:id/transactions` |
| Accommodation | `/accommodations`, `/rooms`, `/occupancies`, `/accommodation-bills` CRUD+, `POST /cost-allocations/run`, `GET /cost-allocations/:id` |
| HR | `/leave-types` CRUD+, `GET /leave-balances?partyId=`, `/leave-requests` CRUD+, `/passport-custody` CRUD+, `/disciplinary-records` CRUD+, `POST /disciplinary-records/:id/acknowledge` |
| Exit | `/exit-cases` CRUD+, `GET /exit-cases/:id/outstanding`, `POST /exit-cases/:id/settlement`, `/complete`, `GET /exit-cases/:id/certificate.pdf` |
| Workforce | `/headcount-targets` CRUD+, `GET /workforce/gap`, `GET /workforce/forecast`, `/visa-quotas`, `/shifts`, `/shift-assignments`, `/shift-swaps` CRUD+ |

### 5.23 Intelligence [P11]

| Area | Method and path |
| --- | --- |
| Risk | `/risk-rules` CRUD+, `GET /risk-scores/:partyId`, `/risk-cases` CRUD+, `POST /risk-cases/:id/notes`, `GET /risk/loan-assessment/:partyId` |
| Semantic layer and dashboards | `/semantic/measures` and `/semantic/dimensions` CRUD+, `/dashboards` CRUD+ (widgets), `GET /kpis` |
| Automation | `/automation-rules` CRUD+, `POST /automation-rules/:id/test`, `GET /automation-runs` |
| AI | `POST /ai/conversations`, `POST /ai/conversations/:id/messages` (SSE stream), `GET /ai/conversations`, `POST /ai/proposals/:id/confirm`, `/reject`, `GET /ai/usage`, `GET/PUT /ai/settings` |
| Telematics | `POST /telemetry/points` (API key, batch), `/telemetry/devices` CRUD+, `GET /telemetry/live`, `/consents` CRUD+ |

### 5.24 Privacy and compliance [P12]

| Method and path | Purpose |
| --- | --- |
| `/data-subject-requests` CRUD+, `POST /data-subject-requests/:id/fulfil` | |
| `/processing-purposes` CRUD+ | Processing register |
| `/compliance-rules` CRUD+, `GET /compliance/breaches` | |

---

## 6. Conflicts between requirements, with proposed resolutions

| # | Conflict | Proposed resolution |
| --- | --- | --- |
| C1 | **Salary components.** SPEC 4.7 says the Excel formulas add COD to earnings and leave out Bills and Adjustments Minus, while the old app does the opposite. | Already listed in DECISIONS #1. Every component carries a configurable kind (earning, deduction or information). **No payroll rules are coded until the owner answers.** |
| C2 | **Loan model.** SPEC 4.3 describes one running ledger per borrower with transaction types. SPEC 4.6 describes numbered loan records with interest. | SPEC 4.6 wins, as the spec says. The borrower's "running ledger" is a view over `journal_line` filtered by party and loan, ordered by date, with a running balance. Transaction types map to event keys (loan.disbursed, loan.repaid.salary, loan.repaid.cash, loan.negative_salary, loan.adjusted). |
| C3 | **Signature for negative-salary loans.** SPEC 4.4 turns negative net pay into a new advance. SPEC 4.6 says the signed loan paper is mandatory for Employee borrowers. A carry-over has no paper to sign. | Treat `origin = negative_salary` like `imported`: exempt from the signature, but linked to the payslip. **Owner to confirm (Q4).** |
| C4 | **Salary-deduction note.** SPEC 4.4 says "Deducted from salary of [Month Year]"; SPEC 4.6 says "Cut from [Month] salary". | SPEC 4.6 wins. The note comes from a template, defaulting to "Cut from [Month Year] salary". |
| C5 | **Payroll status lists.** SPEC 4.4 uses generated, approved, paid. SPEC 4.7 uses Draft, Generated, Approved. SPEC 5.8 uses Draft, Reviewed, Approved, Posted, Paid. | Two levels. The **run** follows the SPEC 5.8 lifecycle (draft, reviewed, approved, posted, paid, reversed). The **payslip** follows draft, generated, approved, paid. Both are state-machine configuration. Posting happens only at run level, in one transaction (SPEC 4.4). |
| C6 | **Which payroll is primary.** SPEC 4.4 posts from the uploaded Excel. SPEC 5.8 makes the engine primary, with Excel for verification. | Phase 7 delivers both paths on the same run object. A run is calculated by the engine, the Excel upload is attached as the verification source, and lines can be overridden from Excel with a reason. Until the engine's inputs are complete, the "file is the source" mode can be switched on per period, with every override flagged. |
| C7 | **"Upload the same month twice is blocked" (4.4) versus "Duplicate creates a second sheet for the same employee and period" (4.7) versus off-cycle runs (5.8).** | A unique index allows one live *regular* run per period. Duplicates are extra payslips with a label inside that run. Off-cycle runs (final settlement, bonus, correction) are separate run types and are allowed. |
| C8 | **Negative salary (4.4) versus recovery priority and carry-forward to "the correct ledger" (5.8).** | The pay policy applies priority order and a maximum deduction first. Anything not recovered goes back to its own source: an unrecovered loan instalment stays on the loan, unrecovered COD stays on COD. Only a remaining negative net becomes a new advance (4.4). **Defaults to confirm (Q7).** |
| C9 | **"Revenue" in SPEC 4.7.** It defines revenue as (client rate − pay rate) × orders, which is really a gross margin. SPEC 2.9 and 5.15 require profit and loss to come from the ledger. | Post client revenue and worker pay as separate ledger lines. The "operational P&L" report keeps the SPEC 4.7 layout (order margin, office charges, work permit fees, expenses), computed from ledger lines, so it always agrees with the accounting P&L (Phase 7 acceptance). |
| C10 | **Two-factor authentication.** SPEC 2.1 makes TOTP *optional* for Super Admin, Admin and Owner. SPEC 6.5 makes it *mandatory* for privileged roles. | A per-role `mfa_required` setting, defaulting to mandatory for Super Admin, Admin and Owner (6.5 is the later, stricter requirement). **Owner to confirm (Q9).** |
| C11 | **"All tables carry deletedAt" (2.3, CLAUDE.md) versus append-only audit, outbox, journals and ledgers (2.2, 2.9).** | Append-only tables (tag A) have no soft-delete or update columns, and the database blocks UPDATE and DELETE on them. Their "deletion" is a reversal row. Recorded as an explicit exception. |
| C12 | **Deletion requests under the privacy law (6.5) versus "nothing is ever physically deleted" (2.3) and immutable financial records (2.9).** | A deletion request is fulfilled by **anonymisation**: personal fields are replaced and encrypted values have their key destroyed (crypto-shredding). Financial and audit rows are kept with the party anonymised. Wording to be confirmed with the company's legal adviser. |
| C13 | **Global reference data versus "every table has tenant_id and company_id".** | Currencies, the permission catalogue, event types and subscription plans are global (tag G). Users and roles are tenant-level (tag T), because a user spans companies. Everything else is S. |
| C14 | **Recycle bin "for Super Admin and developer role" (2.3)**, but there is no Developer in the built-in role list (2.1). | Seed a custom role "Developer" with `recycle_bin.view` and `recycle_bin.restore`. It can be removed. |
| C15 | **Client platform is a lookup (2.5) and also a party (2.8).** | A `client_platform` table linked to an organisation party. The lookup screen edits this table. |
| C16 | **Zones are a lookup (2.5) and also an organisational level (2.7).** | Zones are `org_unit` rows with kind = zone, edited from the same kind of screen as lookups. |
| C17 | **Partitioned tables need the partition key in the primary key.** This affects "UUIDv7 primary keys" (2.12) and foreign keys to `journal_line`. | Primary key is `(id, date)`. References store both columns. |
| C18 | **Loan status with term 0.** The due date is loan date + 1 month, but the status is "Open (no term)". The precedence between Overdue and Open is not stated. | Replicate the workbook's formula exactly after inspecting it in Phase 6. **Owner to confirm (Q5).** |
| C19 | **Rates are stored in three places:** per-employee rates (4.2), platform and profession defaults with effective dates (4.7), and client rate cards as formulas (5.7). | Pay rate is resolved as: payslip override → file value → employee commercial profile → `pay_rate_per_order` rate table (platform, profession, date). Client rate comes from the contract rate card. Before Phase 8 it falls back to the `client_rate_per_order` rate table. The order is configuration. |
| C20 | **Phase 1 needs "CI/CD and staging", but there is no Git repository, Git remote or hosting yet.** | Phase 1 delivers CI in GitHub Actions and Terraform/compose for staging. The deploy job is enabled once hosting is chosen (Q11). |

---

## 7. Questions for the owner

Items already open in `docs/DECISIONS.md` are referenced by their number there. All open questions are also tracked in `docs/DECISIONS.md`.

**Answered on 2026-11-13** (recorded in `docs/DECISIONS.md`, "Made"):

- **Q2:** yes, the three IDs are the same number.
- **Q9:** two-factor login is mandatory for Super Admin, Admin and Owner.
- **Q10:** the product name is **Fibrex**. Languages are English, Bangla, Urdu, Hindi and Nepali. Arabic is not translated at launch, but RTL support is kept.
- **Q11:** the code goes in a private GitHub repository. Hosting and the email method are decided later.

| # | Question | Needed for |
| --- | --- | --- |
| Q1 | DECISIONS #1: Is COD an earning or a deduction? Are Bills and Adjustments Minus deducted? | P7 |
| Q2 | Are **Falcon ID**, **Falcon Flex ID** and **Snoonu ID** the same number? I assume they are, stored as one identifier type for Snoonu. | P1 seed, P4, P6 |
| Q3 | **Loan interest.** (a) Is a payment applied to interest first, principal first, or in proportion? (b) Is interest income recognised when the loan is given or when it is collected? (c) Is the investor profit share based on interest *charged* on all loans, or interest *collected*? | P6 |
| Q4 | Can a negative-salary advance be recorded without a signed loan paper (C3)? | P6, P7 |
| Q5 | For open-ended loans (term 0), which status wins after one month: Open or Overdue? I propose to copy the workbook's exact rule. | P6 |
| Q6 | **Pay periods per platform.** If one worker works for both Snoonu and Keeta in the same month, do they get one payslip or one per platform? | P7 |
| Q7 | **Deduction limits.** Is there a maximum deduction per month (Qatar law limits deductions as a share of the wage; please confirm the figure with your legal adviser), a minimum take-home amount, and an order of deductions when earnings are not enough? | P7 |
| Q8 | For loans with a "free" repayment plan, should the payroll engine deduct nothing automatically, so the amount comes only from the file or a manual entry? | P7 |
| Q9 | Is two-factor authentication mandatory for Super Admin, Admin and Owner from the first release (C10)? | P1 |
| Q10 | DECISIONS #10: product name, and the interface languages for the first release. | P1 |
| Q11 | **Hosting and code.** Where should staging and production run (for example a single VPS, AWS, Azure, DigitalOcean)? Should the code live in a private GitHub repository? Which email sending method: SMTP account or Gmail API? | P1 |
| Q12 | DECISIONS #9: chart of accounts from your accountant, or approval to seed a standard one for a Qatar service company. Also, which month does your financial year start? | P2 |
| Q13 | DECISIONS #3: the company email list for expiry alerts. | P3 |
| Q14 | **COD outstanding at handover** (SPEC 3.3), when another person works an ID: who owes it for payroll, the ID owner or the operator? | P4, P7 |
| Q15 | **Vehicle rent.** When a worker uses a company-rented vehicle, is any of the rent deducted from their salary, or is it always a company cost? | P5, P7 |
| Q16 | **Old payroll app.** Can you give a database dump (or read-only access) of the old app's PostgreSQL in `C:\Jihan\Fibrex Trading app` for migration? | P7 |
| Q17 | Which currencies are needed at launch besides QAR (BDT for bKash)? Are bKash amounts recorded in BDT or in QAR? | P2, P6 |
| Q18 | Are there existing number formats to keep, for example payslip, invoice or handover slip numbers? | P2 |
| Q19 | **Data retention.** How long should we keep the records of ex-employees and unsuccessful candidates? (A legal adviser should confirm.) | P2, P12 |
| Q20 | DECISIONS #5: should "Fibrex Delivery Service" loans stay as Company-type borrower entries or become company expenses? | P6 |

---

## 8. Technical assumptions to approve

1. **Repository and tooling.**
   - pnpm workspaces; Node 20 LTS; TypeScript strict
   - Vitest for unit and integration tests; Testcontainers for real Postgres and Redis in integration tests; Playwright for end-to-end
   - GitHub Actions for CI
   - `git init` is done at the start of Phase 1 (the folder is not a Git repository yet)
2. **Prisma.** Use the multi-file schema and the multi-schema feature (one Postgres schema per module). Write RLS, partitions, triggers, exclusion constraints and materialised views as hand-written SQL inside Prisma migrations. Use typed raw SQL (`$queryRawTyped` / TypedSQL) for partitioned and reporting queries.
3. **Formula engine.** CEL (Common Expression Language) through a maintained TypeScript implementation, running in a decimal-only context with no I/O and a time and step limit. The exact library is chosen with a short spike in Phase 2 and recorded in DECISIONS, with JSONLogic as the fallback. Never `eval`.
4. **Templates and PDF.**
   - Handlebars with escaping and only whitelisted helpers
   - PDFs rendered from HTML by headless Chromium (Playwright) in the worker container. This gives real text PDFs with correct Arabic and Bangla shaping.
5. **Audit.** Data changes are captured by database triggers (section 2.3). Semantic events come from `AuditService`. A sealing job builds the hash chain.
6. **Login tokens.**
   - Access JWT: 15 minutes, held in memory
   - Refresh token: httpOnly SameSite=Strict cookie, rotated with reuse detection
   - CSRF double-submit token on cookie endpoints
7. **Local development services.** Email goes to Mailpit in docker compose. MinIO stands in for S3. The KMS, OCR, LLM, WhatsApp, SMS and e-signature adapters are clearly named stubs, listed in `docs/PROGRESS.md` until replaced.
8. **OpenAPI.** Generated from the Zod schemas (`@asteasolutions/zod-to-openapi`), so documentation cannot drift from validation.
9. **Seeds.** Synthetic data only. Fixtures derived from `reference/` files are anonymised before they are committed. The real workbooks stay in the ignored `reference/` folder and are used only in local reconciliation runs.
10. **Single-language store, multi-language labels.** User-entered business data is stored as typed. Configurable labels (lookups, components, templates) are stored as i18n JSONB.

---

## 9. What happens next

1. You review this plan. The questions needed before Phase 1 (Q2, Q9, Q10, Q11) are answered. The rest are needed only in later phases.
2. On approval, I record the accepted design choices in `docs/DECISIONS.md` and start Phase 1 using the prompt in `docs/phases/phase-01.md`. Phase 1 creates only the Phase 1 tables (sections 3.1–3.6).
3. Payroll rules (Phase 7) and loan money rules (Phase 6) will not be coded until the related questions are answered, as CLAUDE.md requires.
