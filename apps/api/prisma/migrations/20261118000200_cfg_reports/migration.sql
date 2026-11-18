-- =============================================================================
-- Migration: report engine base (Phase 2, row 2.13)
--
-- PLAN 3.7 `report_definition` and `saved_report`.
--
--   * cfg.report_definition is a global catalogue (like notify.event_type): modules declare
--     reports in code (ModuleManifest.reports, kernel reports) and the API writes them here
--     at start-up (kernel/reports/report-sync.ts). The table tells the database and the
--     admin screens which reports exist; the query itself stays in code. A report that code
--     stops declaring is left in place (saved reports still point at it) and is simply not
--     offered, because the API lists only what is registered in code.
--   * cfg.saved_report is a person's saved filters and column choice for one report. It is
--     tenant-wide (kind T): the owner may share it with named users.
--
-- Differences from PLAN 3.7 (recorded in DECISIONS):
--   * saved_report points at the report by `report_key` (unique, stable, readable), not by
--     `report_definition_id`.
--   * `report_schedule` is not created here; scheduled delivery is a later row.
-- =============================================================================

CREATE TABLE cfg.report_definition (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  key            text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module_key     text        NOT NULL CHECK (length(module_key) BETWEEN 1 AND 60),
  label          text        NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  description    text        NOT NULL DEFAULT '',
  source         text        NOT NULL DEFAULT 'code' CHECK (source IN ('code')),
  -- Columns and filters as the code declared them (for administrators and documentation).
  config         jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  permission_key text        NOT NULL,
  is_system      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1
);
SELECT app.setup_table('cfg', 'report_definition', 'global_catalog');

CREATE TABLE cfg.saved_report (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  report_key     text        NOT NULL,
  owner_user_id  uuid        NOT NULL,
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  filters        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  columns        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(columns) = 'array'),
  -- JSON array of user ids who may open it (they still need the report's own permission).
  shared_with    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(shared_with) = 'array'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT saved_report_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT saved_report_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT saved_report_definition_fk FOREIGN KEY (report_key) REFERENCES cfg.report_definition (key)
);
CREATE UNIQUE INDEX saved_report_name_uq
  ON cfg.saved_report (tenant_id, owner_user_id, report_key, name) WHERE deleted_at IS NULL;
CREATE INDEX saved_report_owner_idx ON cfg.saved_report (tenant_id, report_key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'saved_report', 'tenant');
