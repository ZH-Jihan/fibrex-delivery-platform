-- Phase 3, row 3.2: the `people` schema, part two (PLAN 3.10): document_type,
-- document_requirement, document. Expiry alerts, OCR and bulk upload follow in rows 3.4 to 3.7.
--
-- Design notes:
--   * document_type is data, not code (SPEC 2.6): the standard types are seeded per company
--     (is_system = true, cannot be deleted); administrators add their own. A type applies to
--     one owner kind: a person (party), a vehicle or the company itself.
--   * alert_windows: days before expiry that alert (row 3.4). NULL = the company default
--     (14 and 7 days, owner answer 2026-11-19); so does an empty array, which is how the
--     API stores "back to default". The largest window also decides when a
--     document counts as "expiring".
--   * document_requirement says which types a person must hold, optionally only when a
--     condition holds (a sandboxed formula over the employee, for example
--     sponsorship == "outside") or only for one profession. It feeds the missing-documents
--     report.
--   * document.owner_type / owner_id is polymorphic (party, vehicle, company), so the owner
--     is checked by the API; a company document must point at its own company (CHECK).
--   * A document is either of a type or custom with a typed name, never both (CHECK).
--   * The number uses the party identifier vault pattern: AES-GCM ciphertext, keyed hash
--     for exact lookup, and a mask. There is no plain-text column at all, and the mask
--     column can only hold stars plus the last four characters (CHECK).
--   * status (valid, expiring, expired, replaced) is derived by the API on write and by the
--     daily job (row 3.4); no input carries it.
--   * Renewal keeps the old document: it becomes `replaced` and the new one points back at
--     it (replaces_id). An exclusion constraint allows one current (non-replaced, live)
--     document per owner and type (custom documents: per lower-cased name). It is an
--     exclusion constraint rather than an expression index so Prisma leaves it alone.
--   * Files (scans, pages) are file_attachment rows of entity type 'people.document', with
--     versions, through the files module.
--   * Every table: tenant and company, audit columns, version, soft delete, RLS, audit
--     trigger and no DELETE grant, through app.setup_table.

CREATE TABLE people.document_type (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  code           text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Name per language: { "en": "Passport", "ar": "...", "bn": "..." }; English is required.
  name           jsonb       NOT NULL CHECK (jsonb_typeof(name) = 'object' AND name ? 'en'),
  applies_to     text        NOT NULL CHECK (applies_to IN ('party', 'vehicle', 'company')),
  has_expiry     boolean     NOT NULL DEFAULT true,
  has_number     boolean     NOT NULL DEFAULT true,
  multi_page     boolean     NOT NULL DEFAULT false,
  alert_windows  integer[]   CHECK (
                   alert_windows IS NULL OR (
                     cardinality(alert_windows) BETWEEN 0 AND 6
                     AND 0 <= ALL (alert_windows) AND 366 > ALL (alert_windows))),
  is_system      boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT document_type_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- The standard types stay: a system type cannot be deleted.
  CONSTRAINT document_type_system_kept_ck CHECK (NOT is_system OR deleted_at IS NULL),
  CONSTRAINT document_type_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT document_type_company_id_uq UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX document_type_code_uq ON people.document_type (company_id, code) WHERE deleted_at IS NULL;
SELECT app.setup_table('people', 'document_type', 'company');

CREATE TABLE people.document_requirement (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  company_id             uuid        NOT NULL,
  document_type_id       uuid        NOT NULL,
  -- Sandboxed formula (bool) over the employee; NULL = always required.
  condition_expr         text        CHECK (condition_expr IS NULL OR length(condition_expr) BETWEEN 1 AND 500),
  -- Code of the `profession` lookup; NULL = every profession.
  applies_to_profession  text        CHECK (applies_to_profession IS NULL OR applies_to_profession ~ '^[a-z][a-z0-9_]{0,39}$'),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT document_requirement_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT document_requirement_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT document_requirement_type_fk FOREIGN KEY (company_id, document_type_id) REFERENCES people.document_type (company_id, id)
);
CREATE INDEX document_requirement_type_idx ON people.document_requirement (document_type_id);
SELECT app.setup_table('people', 'document_requirement', 'company');

CREATE TABLE people.document (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  company_id        uuid        NOT NULL,
  owner_type        text        NOT NULL CHECK (owner_type IN ('party', 'vehicle', 'company')),
  owner_id          uuid        NOT NULL,
  -- NULL for a custom document, which then has a typed name.
  document_type_id  uuid,
  custom_name       text        CHECK (custom_name IS NULL OR length(custom_name) BETWEEN 1 AND 120),
  -- The number, vault pattern: never in plain text.
  number_encrypted  bytea,
  number_hash       text        CHECK (number_hash IS NULL OR number_hash ~ '^[0-9a-f]{64}$'),
  number_masked     text        CHECK (number_masked IS NULL OR number_masked ~ '^\*+[A-Z0-9/]{0,4}$'),
  issue_date        date,
  expiry_date       date,
  status            text        NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'expiring', 'expired', 'replaced')),
  -- The document this one renews (that one is now `replaced`).
  replaces_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT document_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT document_type_or_custom_ck CHECK ((document_type_id IS NULL) <> (custom_name IS NULL)),
  CONSTRAINT document_number_vault_ck CHECK (
    (number_encrypted IS NULL) = (number_hash IS NULL) AND (number_hash IS NULL) = (number_masked IS NULL)),
  CONSTRAINT document_company_owner_ck CHECK (owner_type <> 'company' OR owner_id = company_id),
  CONSTRAINT document_dates_ck CHECK (issue_date IS NULL OR expiry_date IS NULL OR expiry_date >= issue_date),
  CONSTRAINT document_not_own_renewal_ck CHECK (replaces_id IS NULL OR replaces_id <> id),
  CONSTRAINT document_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT document_type_fk FOREIGN KEY (company_id, document_type_id) REFERENCES people.document_type (company_id, id),
  CONSTRAINT document_replaces_fk FOREIGN KEY (company_id, replaces_id) REFERENCES people.document (company_id, id),
  CONSTRAINT document_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX document_owner_idx ON people.document (owner_type, owner_id);
CREATE INDEX document_expiry_idx ON people.document (company_id, expiry_date) WHERE deleted_at IS NULL AND status <> 'replaced';
CREATE INDEX document_number_hash_idx ON people.document (company_id, number_hash);
-- A document is renewed once: one live successor per document.
CREATE UNIQUE INDEX document_replaces_uq ON people.document (replaces_id) WHERE replaces_id IS NOT NULL AND deleted_at IS NULL;
-- One current document per owner and type (custom: per name).
ALTER TABLE people.document ADD CONSTRAINT document_one_current EXCLUDE USING btree (
  company_id WITH =,
  owner_type WITH =,
  owner_id WITH =,
  (coalesce(document_type_id::text, 'custom:' || lower(custom_name))) WITH =
) WHERE (deleted_at IS NULL AND status <> 'replaced');
SELECT app.setup_table('people', 'document', 'company');
