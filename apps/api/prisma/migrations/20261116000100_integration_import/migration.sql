-- =============================================================================
-- Migration: integration schema, generic import (Phase 2, row 2.8a)
--
-- PLAN 3.8 `import_mapping` (S), `import_job` (S), `import_row` (A). A fourth table,
-- `import_result` (A), is added: PLAN puts `created_entity_id` on import_row, but import_row
-- is insert-only (what was read and judged at preview must never change), while the id of
-- the row a commit created is only known later. The result therefore goes in its own
-- insert-only table, written at commit and read by rollback.
--
-- Design notes:
--   * The file itself is kept in files.raw_input (kind excel_upload) for ever; the job only
--     points at it. Nothing here copies the file's bytes.
--   * A job takes a snapshot of the mapping it was previewed with (`mapping`), so editing or
--     deleting a saved mapping later never changes what an old job did.
--   * Each preview of a job is numbered (`preview_no`). Preview rows are never rewritten or
--     removed: a second preview adds a new numbered set, and commit uses the latest set.
--   * Statuses: uploaded -> previewed -> queued -> committed | failed; committed ->
--     rolled_back. A failed commit changed nothing (it ran in one transaction); the job can
--     be previewed again.
-- =============================================================================

CREATE SCHEMA integration;
GRANT USAGE ON SCHEMA integration TO fibrex_app;

CREATE TABLE integration.import_mapping (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  entity_key    text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  column_map    jsonb       NOT NULL CHECK (jsonb_typeof(column_map) = 'object'),
  transforms    jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(transforms) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT import_mapping_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT import_mapping_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT import_mapping_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX import_mapping_name_uq
  ON integration.import_mapping (tenant_id, entity_key, name) WHERE deleted_at IS NULL;
SELECT app.setup_table('integration', 'import_mapping', 'tenant');

CREATE TABLE integration.import_job (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  entity_key    text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  raw_input_id  uuid        NOT NULL,
  mapping_id    uuid,
  mapping       jsonb       CHECK (jsonb_typeof(mapping) = 'object'),
  status        text        NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded', 'previewed', 'queued', 'committed', 'rolled_back', 'failed')),
  preview_no    integer     NOT NULL DEFAULT 0 CHECK (preview_no >= 0),
  stats         jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stats) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT import_job_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT import_job_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT import_job_raw_input_fk FOREIGN KEY (raw_input_id) REFERENCES files.raw_input (id),
  CONSTRAINT import_job_mapping_fk FOREIGN KEY (tenant_id, mapping_id) REFERENCES integration.import_mapping (tenant_id, id),
  CONSTRAINT import_job_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX import_job_status_idx ON integration.import_job (company_id, status, id DESC) WHERE deleted_at IS NULL;
SELECT app.setup_table('integration', 'import_job', 'company');

-- What the file said and how the engine judged it, one row per data row per preview.
CREATE TABLE integration.import_row (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  import_job_id uuid        NOT NULL,
  preview_no    integer     NOT NULL CHECK (preview_no > 0),
  row_no        integer     NOT NULL CHECK (row_no > 0),
  raw           jsonb       NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  normalised    jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(normalised) = 'object'),
  errors        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT import_row_job_fk FOREIGN KEY (company_id, import_job_id) REFERENCES integration.import_job (company_id, id),
  CONSTRAINT import_row_no_uq UNIQUE (import_job_id, preview_no, row_no)
);
SELECT app.setup_table('integration', 'import_row', 'company_append');

-- The record each committed row became; rollback soft-deletes exactly these.
CREATE TABLE integration.import_result (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  company_id        uuid        NOT NULL,
  import_job_id     uuid        NOT NULL,
  row_no            integer     NOT NULL CHECK (row_no > 0),
  created_entity_id uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  CONSTRAINT import_result_job_fk FOREIGN KEY (company_id, import_job_id) REFERENCES integration.import_job (company_id, id),
  CONSTRAINT import_result_row_uq UNIQUE (import_job_id, row_no)
);
SELECT app.setup_table('integration', 'import_result', 'company_append');
