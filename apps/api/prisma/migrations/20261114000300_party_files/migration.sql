-- =============================================================================
-- Migration: party and files schemas (Phase 1, commit 8)
--
-- Tables from docs/PLAN.md sections 3.5 (party) and 3.6 (files). Conventions are those of
-- the platform_iam migration (S = 'company' kind, A = 'company_append' kind).
--
-- Files first, because party and later modules point at it.
--
-- Rules the database enforces itself, so application code cannot skip them:
--   * a person or organisation exists once; an identifier (QID, Falcon ID, ...) cannot be
--     held by two parties in overlapping periods (GiST exclusion on the hashed value);
--   * a bank account becomes 'verified' only with an approver who is not the requester
--     (SPEC 5.9, 6.5: second person approves);
--   * file objects, merge records and raw inputs are insert-only (history is kept).
--
-- Sensitive values (identifiers such as QID and passport, bank/IBAN) are stored encrypted
-- (AES-256-GCM through SecretBox), with a keyed hash for exact lookup and a masked form
-- for display. Plain text is kept only for identifier types that are not sensitive.
-- =============================================================================

CREATE SCHEMA files;
CREATE SCHEMA party;
GRANT USAGE ON SCHEMA files, party TO fibrex_app;

-- -----------------------------------------------------------------------------
-- files
-- -----------------------------------------------------------------------------

-- One stored object. Immutable: a replaced file is a new object (and a new attachment
-- version), never an overwrite.
CREATE TABLE files.file_object (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  bucket         text        NOT NULL,
  object_key     text        NOT NULL,
  sha256         text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes     bigint      NOT NULL CHECK (size_bytes > 0),
  mime_type      text        NOT NULL,
  original_name  text        NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  -- Malware scanning arrives with a later phase; until then objects stay 'not_scanned'.
  scan_status    text        NOT NULL DEFAULT 'not_scanned'
                 CHECK (scan_status IN ('not_scanned', 'pending', 'clean', 'infected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT file_object_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT file_object_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT file_object_key_uq UNIQUE (bucket, object_key)
);
CREATE INDEX file_object_sha_idx ON files.file_object (company_id, sha256);
SELECT app.setup_table('files', 'file_object', 'company_append');

-- A file attached to a record of any module (entity_type is '<schema>.<table>').
-- Replacing a file adds a version: version_no + 1, supersedes_id = the previous version.
CREATE TABLE files.file_attachment (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid        NOT NULL,
  entity_type     text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  entity_id       uuid        NOT NULL,
  file_object_id  uuid        NOT NULL,
  purpose         text        NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{1,39}$'),
  version_no      integer     NOT NULL DEFAULT 1 CHECK (version_no >= 1),
  supersedes_id   uuid,
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT file_attachment_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT file_attachment_version_ck CHECK ((supersedes_id IS NULL) = (version_no = 1)),
  CONSTRAINT file_attachment_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT file_attachment_file_fk FOREIGN KEY (company_id, file_object_id) REFERENCES files.file_object (company_id, id),
  CONSTRAINT file_attachment_supersedes_fk FOREIGN KEY (company_id, supersedes_id) REFERENCES files.file_attachment (company_id, id),
  CONSTRAINT file_attachment_company_id_uq UNIQUE (company_id, id)
);
-- A version has at most one successor: the history is a straight line, not a tree.
CREATE UNIQUE INDEX file_attachment_supersedes_uq ON files.file_attachment (supersedes_id)
  WHERE supersedes_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX file_attachment_entity_idx ON files.file_attachment (tenant_id, entity_type, entity_id);
CREATE INDEX file_attachment_file_idx ON files.file_attachment (file_object_id);
SELECT app.setup_table('files', 'file_attachment', 'company');

-- Every raw input (sheet snapshot, bank file, webhook body, ...) is kept forever (SPEC 2.12).
CREATE TABLE files.raw_input (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN
                  ('sheet_snapshot', 'excel_upload', 'bank_file', 'client_statement',
                   'webhook', 'workbook_import', 'legacy_dump')),
  source          text        NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  file_object_id  uuid,
  sha256          text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  meta            jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  CONSTRAINT raw_input_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT raw_input_file_fk FOREIGN KEY (company_id, file_object_id) REFERENCES files.file_object (company_id, id)
);
CREATE INDEX raw_input_kind_idx ON files.raw_input (company_id, kind, received_at DESC);
SELECT app.setup_table('files', 'raw_input', 'company_append');

-- -----------------------------------------------------------------------------
-- party
-- -----------------------------------------------------------------------------

CREATE TABLE party.party (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('person', 'organisation')),
  display_name     text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 300),
  -- Names in each language, for example {"en": "...", "ar": "..."}.
  names            jsonb       NOT NULL DEFAULT '{}',
  date_of_birth    date,
  gender           text        CHECK (gender IN ('female', 'male', 'other')),
  nationality_code text        CHECK (nationality_code ~ '^[A-Z]{2}$'),
  photo_file_id    uuid,
  custom_fields    jsonb       NOT NULL DEFAULT '{}',
  -- Set when this party was merged into another; the row stays (soft deleted) as history.
  merged_into_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT party_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT party_birth_ck CHECK (kind = 'person' OR date_of_birth IS NULL),
  CONSTRAINT party_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT party_tenant_id_uq UNIQUE (tenant_id, id)
);
-- Trigram index: "ali" finds "Mohammed Ali Khan" without a table scan.
CREATE INDEX party_name_trgm_idx ON party.party USING gin (display_name gin_trgm_ops);
CREATE INDEX party_kind_idx ON party.party (company_id, kind);
SELECT app.setup_table('party', 'party', 'company');

-- iam.user_account.party_id was waiting for this table (platform_iam migration).
ALTER TABLE iam.user_account
  ADD CONSTRAINT user_account_party_fk FOREIGN KEY (tenant_id, party_id) REFERENCES party.party (tenant_id, id);

CREATE TABLE party.party_role (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  party_id       uuid        NOT NULL,
  role_type      text        NOT NULL CHECK (role_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  valid_from     date        NOT NULL DEFAULT current_date,
  -- Inclusive: the last day the role applies. NULL = still open.
  valid_to       date,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  attributes     jsonb       NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT party_role_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT party_role_period_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT party_role_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_role_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX party_role_party_idx ON party.party_role (party_id);
CREATE INDEX party_role_type_idx ON party.party_role (company_id, role_type, status);
-- The same role cannot be open twice for one party over the same days.
ALTER TABLE party.party_role ADD CONSTRAINT party_role_no_overlap EXCLUDE USING gist (
  party_id WITH =, role_type WITH =, daterange(valid_from, valid_to, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('party', 'party_role', 'company');

CREATE TABLE party.party_identifier (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,
  company_id         uuid        NOT NULL,
  party_id           uuid        NOT NULL,
  type               text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- The client platform that issued the id (Falcon, Talabat, ...). The platform table
  -- arrives in a later phase; until then this is a plain id.
  client_platform_id uuid,
  value_encrypted    bytea       NOT NULL,
  -- Keyed hash of the normalised value: exact lookup and the overlap rule, no plain text.
  value_hash         text        NOT NULL,
  value_masked       text        NOT NULL,
  -- Only for types that are not sensitive (platform rider ids); NULL for QID, passport...
  value_plain        text,
  valid_from         date        NOT NULL DEFAULT current_date,
  valid_to           date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer     NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  deleted_by         uuid,
  delete_reason      text,
  CONSTRAINT party_identifier_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT party_identifier_period_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT party_identifier_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_identifier_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX party_identifier_party_idx ON party.party_identifier (party_id);
CREATE INDEX party_identifier_lookup_idx ON party.party_identifier (tenant_id, type, value_hash);
-- The same id can move between people over time, but never be held by two people at once.
-- Checked across the whole tenant (even rows the caller cannot see), so a company cannot
-- be used to create a second holder.
ALTER TABLE party.party_identifier ADD CONSTRAINT party_identifier_no_overlap EXCLUDE USING gist (
  tenant_id WITH =,
  type WITH =,
  (coalesce(client_platform_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  value_hash WITH =,
  daterange(valid_from, valid_to, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('party', 'party_identifier', 'company');

CREATE TABLE party.party_contact (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  party_id       uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('phone', 'whatsapp', 'email')),
  value          text        NOT NULL,
  is_primary     boolean     NOT NULL DEFAULT false,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT party_contact_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- Phones in international form, e-mail in lower case (so lookups are case-insensitive).
  CONSTRAINT party_contact_value_ck CHECK (
    CASE WHEN kind = 'email' THEN value = lower(value) AND value ~ '^[^@\s]+@[^@\s]+$'
         ELSE value ~ '^\+[1-9][0-9]{6,14}$' END),
  CONSTRAINT party_contact_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_contact_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX party_contact_party_idx ON party.party_contact (party_id);
CREATE INDEX party_contact_value_idx ON party.party_contact (tenant_id, kind, value);
CREATE UNIQUE INDEX party_contact_primary_uq ON party.party_contact (party_id, kind)
  WHERE is_primary AND deleted_at IS NULL;
SELECT app.setup_table('party', 'party_contact', 'company');

CREATE TABLE party.party_address (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  party_id       uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  lines          text[]      NOT NULL DEFAULT '{}',
  city           text,
  country_code   text        CHECK (country_code ~ '^[A-Z]{2}$'),
  -- {"lat": 25.28, "lng": 51.53}
  geo            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT party_address_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT party_address_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_address_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX party_address_party_idx ON party.party_address (party_id);
SELECT app.setup_table('party', 'party_address', 'company');

CREATE TABLE party.party_relationship (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  from_party_id  uuid        NOT NULL,
  to_party_id    uuid        NOT NULL,
  type           text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{1,39}$'),
  valid_from     date        NOT NULL DEFAULT current_date,
  valid_to       date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT party_relationship_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT party_relationship_period_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT party_relationship_distinct_ck CHECK (from_party_id <> to_party_id),
  CONSTRAINT party_relationship_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_relationship_from_fk FOREIGN KEY (company_id, from_party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT party_relationship_to_fk FOREIGN KEY (company_id, to_party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX party_relationship_from_idx ON party.party_relationship (from_party_id);
CREATE INDEX party_relationship_to_idx ON party.party_relationship (to_party_id);
SELECT app.setup_table('party', 'party_relationship', 'company');

CREATE TABLE party.party_bank_account (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid        NOT NULL,
  party_id        uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('bank', 'wallet')),
  bank_name       text,
  -- IBAN for a bank account, wallet number for a wallet.
  iban_encrypted  bytea       NOT NULL,
  iban_hash       text        NOT NULL,
  iban_masked     text        NOT NULL,
  account_name    text        NOT NULL,
  wallet_provider text,
  -- pending: new or changed, waiting for a second person. verified: approved. rejected.
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  proof_file_id   uuid,
  requested_by    uuid        NOT NULL,
  -- Someone has looked at the proof document (first check).
  proof_checked_by uuid,
  proof_checked_at timestamptz,
  approved_by     uuid,
  approved_at     timestamptz,
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT party_bank_account_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- The two-person rule, at the database: nobody approves their own request.
  CONSTRAINT party_bank_account_two_person_ck CHECK (
    status <> 'verified'
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by <> requested_by)),
  CONSTRAINT party_bank_account_wallet_ck CHECK (kind = 'wallet' OR wallet_provider IS NULL),
  CONSTRAINT party_bank_account_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_bank_account_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX party_bank_account_party_idx ON party.party_bank_account (party_id);
CREATE UNIQUE INDEX party_bank_account_number_uq ON party.party_bank_account (party_id, iban_hash)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('party', 'party_bank_account', 'company');

CREATE TABLE party.party_duplicate_candidate (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  -- Stored with party_a_id < party_b_id so a pair exists once, whichever way it was found.
  party_a_id     uuid        NOT NULL,
  party_b_id     uuid        NOT NULL,
  score          numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  reasons        jsonb       NOT NULL DEFAULT '[]',
  status         text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'merged')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT party_duplicate_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT party_duplicate_order_ck CHECK (party_a_id < party_b_id),
  CONSTRAINT party_duplicate_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_duplicate_a_fk FOREIGN KEY (company_id, party_a_id) REFERENCES party.party (company_id, id),
  CONSTRAINT party_duplicate_b_fk FOREIGN KEY (company_id, party_b_id) REFERENCES party.party (company_id, id)
);
CREATE UNIQUE INDEX party_duplicate_pair_uq ON party.party_duplicate_candidate (party_a_id, party_b_id)
  WHERE deleted_at IS NULL;
CREATE INDEX party_duplicate_status_idx ON party.party_duplicate_candidate (company_id, status, score DESC);
SELECT app.setup_table('party', 'party_duplicate_candidate', 'company');

-- Who was merged into whom, what the merged party looked like, and which rows moved.
CREATE TABLE party.party_merge (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  survivor_id      uuid        NOT NULL,
  merged_id        uuid        NOT NULL,
  snapshot         jsonb       NOT NULL,
  repointed_refs   jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT party_merge_distinct_ck CHECK (survivor_id <> merged_id),
  CONSTRAINT party_merge_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT party_merge_survivor_fk FOREIGN KEY (company_id, survivor_id) REFERENCES party.party (company_id, id),
  CONSTRAINT party_merge_merged_fk FOREIGN KEY (company_id, merged_id) REFERENCES party.party (company_id, id)
);
CREATE UNIQUE INDEX party_merge_merged_uq ON party.party_merge (merged_id);
CREATE INDEX party_merge_survivor_idx ON party.party_merge (survivor_id);
SELECT app.setup_table('party', 'party_merge', 'company_append');
