-- =============================================================================
-- Migration: bulk export jobs (Phase 2, row 2.8b)
--
-- PLAN 3.8 `export_job` (S): one row per bulk export of any record type to CSV or Excel.
-- The file itself is an ordinary files.file_object (downloaded through the audited files
-- endpoint); the job records who exported what, with which filters, and how many rows,
-- because an export is data leaving the system.
--
-- Statuses: `completed` or `failed`. The export is built inside the request (capped at
-- 20,000 rows), so a job is written only in its final state; the values `queued` and
-- `running` are allowed so a later move of big exports to the queue needs no migration.
-- =============================================================================

CREATE TABLE integration.export_job (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  entity_key     text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  format         text        NOT NULL CHECK (format IN ('csv', 'xlsx')),
  filters        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  status         text        NOT NULL DEFAULT 'completed'
                 CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  row_count      integer     NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  file_object_id uuid,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT export_job_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT export_job_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT export_job_file_fk FOREIGN KEY (company_id, file_object_id) REFERENCES files.file_object (company_id, id)
);
CREATE INDEX export_job_company_idx ON integration.export_job (company_id, id DESC) WHERE deleted_at IS NULL;
SELECT app.setup_table('integration', 'export_job', 'company');
