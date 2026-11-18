-- =============================================================================
-- Migration: reserved tables, retention and adapter configuration (Phase 2, row 2.18)
--
-- PLAN 3.7 (automation, service catalogue, report schedule, dashboards, semantic layer,
-- retention) and PLAN 3.8 (`adapter_config`, `integration_health`).
--
-- Most of these tables are created now and used by later phases (automation in P11, the
-- service catalogue in P9, dashboards and the semantic layer in P11). No engine reads
-- them yet. Only retention (policies, dry-run runs) and the table definitions of adapters
-- have behaviour in this row.
--
-- Design notes:
--   * Tenant-wide configuration tables use kind `tenant`; service_request holds business
--     data and is company-scoped. Runs and health checks are insert-only.
--   * Cross-references to tables owned by other engines (entity definition, workflow
--     definition, template, party, file) are plain uuid columns with no foreign key: those
--     engines may soft-delete or version rows, and a reserved table must not block them.
--     References inside this migration (rule -> run, dashboard -> widget, policy -> run,
--     adapter -> health, catalogue item -> request) are real foreign keys.
--   * semantic_measure.sql_ref is `view.column` in a registered reporting view, never SQL.
--
-- RETENTION SAFETY (recorded in DECISIONS):
--   * A retention policy may never name audit, ledger (gl), journal or payroll data. The
--     CHECK `retention_policy_protected_ck` refuses those entity keys in the database, so
--     no code path can create such a policy. The API and the job check the same rule.
--   * New policies start in `dry_run` mode. A dry run counts what would be affected and
--     writes a `retention_run` row; it changes no data.
--   * The application role has no DELETE grant on any table, so retention can only
--     archive or anonymise (UPDATE) and never hard-deletes.
--   * `cfg.retention_due_tenants()` is SECURITY DEFINER: the job serves every tenant and
--     must find which have an active policy. It returns tenant ids only.
-- =============================================================================

-- ----- automation (P11) ------------------------------------------------------

CREATE TABLE cfg.automation_rule (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  event_type_key text        NOT NULL CHECK (event_type_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  condition_expr text        CHECK (length(condition_expr) <= 4000),
  actions        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(actions) = 'array'),
  active         boolean     NOT NULL DEFAULT false,
  run_as_user_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT automation_rule_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT automation_rule_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT automation_rule_tenant_id_uq UNIQUE (tenant_id, id)
);
SELECT app.setup_table('cfg', 'automation_rule', 'tenant');

CREATE TABLE cfg.automation_run (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL,
  rule_id     uuid        NOT NULL,
  event_id    uuid,
  result      text        NOT NULL CHECK (result IN ('success', 'skipped', 'failed')),
  error       text        CHECK (length(error) <= 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT automation_run_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT automation_run_rule_fk FOREIGN KEY (tenant_id, rule_id) REFERENCES cfg.automation_rule (tenant_id, id)
);
CREATE INDEX automation_run_rule_idx ON cfg.automation_run (tenant_id, rule_id, id);
SELECT app.setup_table('cfg', 'automation_run', 'tenant_append');

-- ----- service catalogue (P9) ------------------------------------------------

CREATE TABLE cfg.service_catalog_item (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  key                    text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,59}$'),
  name                   jsonb       NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  entity_definition_id   uuid,
  workflow_definition_id uuid,
  template_id            uuid,
  audience_roles         text[]      NOT NULL DEFAULT '{}',
  active                 boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT service_catalog_item_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT service_catalog_item_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT service_catalog_item_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX service_catalog_item_key_uq ON cfg.service_catalog_item (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'service_catalog_item', 'tenant');

CREATE TABLE cfg.service_request (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL,
  company_id           uuid        NOT NULL,
  number               text        NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 60),
  catalog_item_id      uuid        NOT NULL,
  requester_party_id   uuid,
  custom_record_id     uuid,
  status               text        NOT NULL DEFAULT 'draft' CHECK (length(btrim(status)) BETWEEN 1 AND 60),
  workflow_instance_id uuid,
  output_document_id   uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              integer     NOT NULL DEFAULT 1,
  deleted_at           timestamptz,
  deleted_by           uuid,
  delete_reason        text,
  CONSTRAINT service_request_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT service_request_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT service_request_item_fk FOREIGN KEY (tenant_id, catalog_item_id) REFERENCES cfg.service_catalog_item (tenant_id, id)
);
CREATE UNIQUE INDEX service_request_number_uq ON cfg.service_request (company_id, number) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'service_request', 'company');

-- ----- report schedule -------------------------------------------------------

CREATE TABLE cfg.report_schedule (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  saved_report_id uuid        NOT NULL,
  cron            text        NOT NULL CHECK (length(btrim(cron)) BETWEEN 9 AND 100),
  time_zone       text        NOT NULL DEFAULT 'UTC' CHECK (length(btrim(time_zone)) BETWEEN 1 AND 60),
  recipients      jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(recipients) = 'array'),
  format          text        NOT NULL DEFAULT 'pdf' CHECK (format IN ('csv', 'xlsx', 'pdf')),
  active          boolean     NOT NULL DEFAULT false,
  last_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT report_schedule_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT report_schedule_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT report_schedule_saved_report_fk FOREIGN KEY (saved_report_id) REFERENCES cfg.saved_report (id)
);
CREATE INDEX report_schedule_report_idx ON cfg.report_schedule (tenant_id, saved_report_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'report_schedule', 'tenant');

-- ----- dashboards and the semantic layer (P11) ------------------------------

CREATE TABLE cfg.dashboard (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,59}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  role_key      text        CHECK (length(role_key) <= 60),
  owner_user_id uuid,
  layout        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(layout) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT dashboard_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT dashboard_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT dashboard_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX dashboard_key_uq ON cfg.dashboard (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'dashboard', 'tenant');

CREATE TABLE cfg.dashboard_widget (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  dashboard_id   uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('kpi', 'chart', 'table')),
  measure_keys   text[]      NOT NULL DEFAULT '{}',
  dimension_keys text[]      NOT NULL DEFAULT '{}',
  filters        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  drill_link     text        CHECK (length(drill_link) <= 500),
  sort_order     integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT dashboard_widget_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT dashboard_widget_dashboard_fk FOREIGN KEY (tenant_id, dashboard_id) REFERENCES cfg.dashboard (tenant_id, id)
);
CREATE INDEX dashboard_widget_dashboard_idx ON cfg.dashboard_widget (tenant_id, dashboard_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'dashboard_widget', 'tenant');

CREATE TABLE cfg.semantic_measure (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  key            text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  label          jsonb       NOT NULL CHECK (jsonb_typeof(label) = 'object'),
  -- A registered reporting view and one of its columns: `view_name.column_name`. Never SQL.
  sql_ref        text        NOT NULL CHECK (sql_ref ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  aggregation    text        NOT NULL CHECK (aggregation IN ('sum', 'count', 'avg', 'min', 'max', 'count_distinct')),
  format         text        NOT NULL DEFAULT 'number' CHECK (format IN ('number', 'money', 'percent', 'duration')),
  permission_key text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT semantic_measure_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT semantic_measure_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id)
);
CREATE UNIQUE INDEX semantic_measure_key_uq ON cfg.semantic_measure (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'semantic_measure', 'tenant');

CREATE TABLE cfg.semantic_dimension (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  label         jsonb       NOT NULL CHECK (jsonb_typeof(label) = 'object'),
  sql_ref       text        NOT NULL CHECK (sql_ref ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  type          text        NOT NULL CHECK (type IN ('text', 'date', 'number', 'boolean', 'lookup', 'party')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT semantic_dimension_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT semantic_dimension_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id)
);
CREATE UNIQUE INDEX semantic_dimension_key_uq ON cfg.semantic_dimension (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'semantic_dimension', 'tenant');

-- ----- retention -------------------------------------------------------------

CREATE TABLE cfg.retention_policy (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  entity_key    text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  keep_months   integer     NOT NULL CHECK (keep_months BETWEEN 1 AND 1200),
  action        text        NOT NULL CHECK (action IN ('archive', 'anonymise')),
  legal_basis   text        NOT NULL CHECK (length(btrim(legal_basis)) BETWEEN 1 AND 2000),
  -- A new policy only counts (dry_run). `live` is the only mode that may change data, and
  -- it also needs a registered target for the entity type (see kernel/retention).
  mode          text        NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'live')),
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT retention_policy_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- Audit, ledger (gl), journal and payroll data is never subject to retention.
  CONSTRAINT retention_policy_protected_ck
    CHECK (entity_key !~ '(^|[._])(audit|gl|ledger|journal|payroll)([._]|$)'),
  CONSTRAINT retention_policy_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT retention_policy_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX retention_policy_entity_uq ON cfg.retention_policy (tenant_id, entity_key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'retention_policy', 'tenant');

CREATE TABLE cfg.retention_run (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  policy_id       uuid        NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  dry_run         boolean     NOT NULL DEFAULT true,
  status          text        NOT NULL CHECK (status IN ('completed', 'skipped', 'failed')),
  rows_affected   integer     NOT NULL DEFAULT 0 CHECK (rows_affected >= 0),
  archive_file_id uuid,
  note            text        CHECK (length(note) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  -- A dry run changes nothing, so it can never report affected rows or an archive file.
  CONSTRAINT retention_run_dry_ck CHECK (NOT dry_run OR (rows_affected = 0 AND archive_file_id IS NULL)),
  CONSTRAINT retention_run_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT retention_run_policy_fk FOREIGN KEY (tenant_id, policy_id) REFERENCES cfg.retention_policy (tenant_id, id)
);
CREATE INDEX retention_run_policy_idx ON cfg.retention_run (tenant_id, policy_id, id);
SELECT app.setup_table('cfg', 'retention_run', 'tenant_append');

CREATE FUNCTION cfg.retention_due_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT p.tenant_id FROM cfg.retention_policy p WHERE p.active AND p.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION cfg.retention_due_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cfg.retention_due_tenants() TO fibrex_app;

-- ----- adapters (PLAN 3.8) ---------------------------------------------------

CREATE TABLE integration.adapter_config (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,
  adapter_kind       text        NOT NULL CHECK (adapter_kind IN (
    'client_report', 'messaging_email', 'whatsapp', 'sms', 'ocr', 'llm', 'esign', 'storage',
    'bank_file', 'accounting', 'maps', 'kms', 'identity')),
  provider           text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,59}$'),
  -- Sealed with the secret box (kernel/crypto); never returned by any endpoint.
  settings_encrypted text,
  active             boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer     NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  deleted_by         uuid,
  delete_reason      text,
  CONSTRAINT adapter_config_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT adapter_config_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT adapter_config_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX adapter_config_provider_uq ON integration.adapter_config (tenant_id, adapter_kind, provider) WHERE deleted_at IS NULL;
-- One active provider per kind.
CREATE UNIQUE INDEX adapter_config_active_uq ON integration.adapter_config (tenant_id, adapter_kind) WHERE active AND deleted_at IS NULL;
SELECT app.setup_table('integration', 'adapter_config', 'tenant');

CREATE TABLE integration.integration_health (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  adapter_config_id uuid        NOT NULL,
  checked_at        timestamptz NOT NULL DEFAULT now(),
  status            text        NOT NULL CHECK (status IN ('ok', 'degraded', 'down')),
  latency_ms        integer     CHECK (latency_ms >= 0),
  error             text        CHECK (length(error) <= 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  CONSTRAINT integration_health_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT integration_health_adapter_fk FOREIGN KEY (tenant_id, adapter_config_id) REFERENCES integration.adapter_config (tenant_id, id)
);
CREATE INDEX integration_health_adapter_idx ON integration.integration_health (tenant_id, adapter_config_id, id);
SELECT app.setup_table('integration', 'integration_health', 'tenant_append');
