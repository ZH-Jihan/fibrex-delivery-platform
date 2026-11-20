-- Phase 4, row 4.1: the `performance` and `tracking` schemas (PLAN 3.11, phase 4 plan
-- section 4): client platforms and their sync sources, column mappings and metric
-- definitions, the sync run log, daily performance (partitioned by month), unmatched
-- identifiers, and the tracking history (status entries, ID-operator periods, call log).
--
-- Design notes:
--   * Every table: tenant and company, RLS, no DELETE grant, through app.setup_table.
--     Mutable tables ('company') carry audit columns, version, soft delete and the audit
--     trigger; logs ('company_append') are insert-only.
--   * `sync_run` is tagged A in PLAN 3.11 but a run moves from running to its end state and
--     can be superseded, so it is a mutable 'company' table (audited, never deleted).
--   * `daily_performance` is insert-only except one change: a re-import inserts new rows and
--     flips `is_current` from true to false on the rows it replaces (PLAN 3.11), so history
--     is kept and a re-run is idempotent. The grant allows UPDATE of that column only and a
--     trigger refuses any other change. A partial unique index keeps one current row per
--     sheet id (and per matched person) per platform per date.
--   * The same raw snapshot (sha256) for the same source and business date is stored once:
--     a later run with the same hash reuses the earlier `raw_input_id` and is marked
--     `snapshot_reused`; a partial unique index enforces it.
--   * `cycle_start_day` on the platform: Snoonu's performance month runs from the 26th to
--     the 25th (phase 4 plan section 9). 1 means calendar months. Kept to 1..28 so every
--     month has the start day.
--   * Money (`earnings`, `cod`, `cod_at_handover`) is NUMERIC(18,4) with a currency code.
--   * The sheet's own figures are kept: `orders_completed` = Delivered, `working_minutes` =
--     Working Hours x 60, `late_minutes` = Late Log In By Min; every other column goes to
--     `metrics` (phase 4 plan section 9, "raw first").

CREATE SCHEMA performance;
GRANT USAGE ON SCHEMA performance TO fibrex_app;
CREATE SCHEMA tracking;
GRANT USAGE ON SCHEMA tracking TO fibrex_app;

-- =============================================================================
-- performance.client_platform: Snoonu, Keeta, Talabat ... (the client is an organisation
-- party; the API checks the party kind).
-- =============================================================================
CREATE TABLE performance.client_platform (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  party_id         uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  adapter_kind     text        NOT NULL CHECK (adapter_kind IN ('sheet', 'excel', 'api')),
  -- Day of the month the platform's performance month starts (Snoonu: 26). 1 = calendar month.
  cycle_start_day  smallint    NOT NULL DEFAULT 1 CHECK (cycle_start_day BETWEEN 1 AND 28),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT client_platform_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT client_platform_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT client_platform_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT client_platform_company_id_uq UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX client_platform_code_uq ON performance.client_platform (company_id, code) WHERE deleted_at IS NULL;
SELECT app.setup_table('performance', 'client_platform', 'company');

-- =============================================================================
-- performance.sync_source: where a platform's report is read from. The spreadsheet id and
-- tab (or other adapter settings) are sealed with SecretBox in `config_encrypted`.
-- =============================================================================
CREATE TABLE performance.sync_source (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL,
  company_id          uuid        NOT NULL,
  client_platform_id  uuid        NOT NULL,
  name                text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  adapter_kind        text        NOT NULL CHECK (adapter_kind IN ('sheet', 'excel', 'api')),
  -- NULL until the source is configured (an Excel-upload source needs none).
  config_encrypted    bytea,
  schedule_cron       text        NOT NULL DEFAULT '0 4 * * *' CHECK (length(schedule_cron) BETWEEN 9 AND 100),
  time_zone           text        NOT NULL DEFAULT 'Asia/Qatar' CHECK (length(time_zone) BETWEEN 1 AND 64),
  active              boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             integer     NOT NULL DEFAULT 1,
  deleted_at          timestamptz,
  deleted_by          uuid,
  delete_reason       text,
  CONSTRAINT sync_source_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT sync_source_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT sync_source_platform_fk FOREIGN KEY (company_id, client_platform_id) REFERENCES performance.client_platform (company_id, id),
  CONSTRAINT sync_source_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX sync_source_platform_idx ON performance.sync_source (client_platform_id);
SELECT app.setup_table('performance', 'sync_source', 'company');

-- =============================================================================
-- performance.column_mapping: sheet header to field, with aliases. Versioned, so a renamed
-- column is a new mapping version, not a code change. `mapping_version` is the mapping's
-- own number (the `version` column is the row's optimistic-lock counter).
-- =============================================================================
CREATE TABLE performance.column_mapping (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  sync_source_id   uuid        NOT NULL,
  mapping_version  integer     NOT NULL CHECK (mapping_version >= 1),
  mapping          jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(mapping) = 'object'),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT column_mapping_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT column_mapping_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT column_mapping_source_fk FOREIGN KEY (company_id, sync_source_id) REFERENCES performance.sync_source (company_id, id),
  -- Version numbers are never reused, even after a soft delete.
  CONSTRAINT column_mapping_version_uq UNIQUE (sync_source_id, mapping_version)
);
SELECT app.setup_table('performance', 'column_mapping', 'company');

-- =============================================================================
-- performance.metric_definition: every metric a platform's report carries, so the
-- figures beyond the core columns can be shown and aggregated.
-- =============================================================================
CREATE TABLE performance.metric_definition (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL,
  company_id          uuid        NOT NULL,
  client_platform_id  uuid        NOT NULL,
  key                 text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label               jsonb       NOT NULL CHECK (jsonb_typeof(label) = 'object' AND label ? 'en'),
  unit                text        NOT NULL CHECK (unit IN ('count', 'percent', 'hours', 'minutes', 'km', 'money', 'number')),
  aggregation         text        NOT NULL CHECK (aggregation IN ('sum', 'avg', 'max')),
  is_core             boolean     NOT NULL DEFAULT false,
  sort_order          integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             integer     NOT NULL DEFAULT 1,
  deleted_at          timestamptz,
  deleted_by          uuid,
  delete_reason       text,
  CONSTRAINT metric_definition_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT metric_definition_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT metric_definition_platform_fk FOREIGN KEY (company_id, client_platform_id) REFERENCES performance.client_platform (company_id, id)
);
CREATE UNIQUE INDEX metric_definition_key_uq ON performance.metric_definition (client_platform_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('performance', 'metric_definition', 'company');

-- =============================================================================
-- performance.sync_run: one row per run (scheduled, manual, re-import or uploaded file).
-- =============================================================================
CREATE TABLE performance.sync_run (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL,
  company_id            uuid        NOT NULL,
  sync_source_id        uuid        NOT NULL,
  -- The date the run is for (the morning it ran, or the date chosen for an upload).
  business_date         date        NOT NULL,
  trigger               text        NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'reimport', 'upload')),
  status                text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  -- A re-import of a date range; NULL for an ordinary run.
  range_from            date,
  range_to              date,
  rows_read             integer     NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
  matched               integer     NOT NULL DEFAULT 0 CHECK (matched >= 0),
  unmatched             integer     NOT NULL DEFAULT 0 CHECK (unmatched >= 0),
  errors_count          integer     NOT NULL DEFAULT 0 CHECK (errors_count >= 0),
  raw_input_id          uuid        REFERENCES files.raw_input (id),
  snapshot_sha256       text        CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  -- True when this run found the same snapshot already stored and reused its raw_input_id.
  snapshot_reused       boolean     NOT NULL DEFAULT false,
  layout_changed        boolean     NOT NULL DEFAULT false,
  superseded_by_run_id  uuid,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  delete_reason         text,
  CONSTRAINT sync_run_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT sync_run_range_ck CHECK ((range_from IS NULL) = (range_to IS NULL) AND (range_to IS NULL OR range_to >= range_from)),
  CONSTRAINT sync_run_finished_ck CHECK ((status = 'running') = (finished_at IS NULL) AND (finished_at IS NULL OR finished_at >= started_at)),
  CONSTRAINT sync_run_snapshot_ck CHECK ((snapshot_sha256 IS NULL) = (raw_input_id IS NULL)),
  CONSTRAINT sync_run_reused_ck CHECK (NOT snapshot_reused OR raw_input_id IS NOT NULL),
  CONSTRAINT sync_run_not_own_successor_ck CHECK (superseded_by_run_id IS NULL OR superseded_by_run_id <> id),
  CONSTRAINT sync_run_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT sync_run_source_fk FOREIGN KEY (company_id, sync_source_id) REFERENCES performance.sync_source (company_id, id),
  CONSTRAINT sync_run_superseded_fk FOREIGN KEY (company_id, superseded_by_run_id) REFERENCES performance.sync_run (company_id, id),
  CONSTRAINT sync_run_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX sync_run_source_date_idx ON performance.sync_run (sync_source_id, business_date DESC, started_at DESC);
-- The same raw snapshot for the same source and date is stored once; later runs reuse it.
CREATE UNIQUE INDEX sync_run_snapshot_uq ON performance.sync_run (sync_source_id, business_date, snapshot_sha256)
  WHERE snapshot_sha256 IS NOT NULL AND NOT snapshot_reused;
SELECT app.setup_table('performance', 'sync_run', 'company');

-- =============================================================================
-- performance.sync_run_error: what went wrong on which sheet row (insert-only).
-- =============================================================================
CREATE TABLE performance.sync_run_error (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id    uuid        NOT NULL,
  company_id   uuid        NOT NULL,
  sync_run_id  uuid        NOT NULL,
  -- Sheet row number; NULL for an error about the whole sheet (layout, access).
  row_no       integer     CHECK (row_no >= 1),
  code         text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,59}$'),
  message      text        NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT sync_run_error_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT sync_run_error_run_fk FOREIGN KEY (company_id, sync_run_id) REFERENCES performance.sync_run (company_id, id)
);
CREATE INDEX sync_run_error_run_idx ON performance.sync_run_error (sync_run_id, row_no);
SELECT app.setup_table('performance', 'sync_run_error', 'company_append');

-- =============================================================================
-- performance.daily_performance: one row per sheet id per platform per date per run,
-- partitioned by month of business_date.
-- =============================================================================
CREATE TABLE performance.daily_performance (
  id                  uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL,
  company_id          uuid        NOT NULL,
  sync_run_id         uuid        NOT NULL,
  client_platform_id  uuid        NOT NULL,
  business_date       date        NOT NULL,
  -- The person, once the sheet id (Falcon ID) is matched; NULL while unmatched.
  party_id            uuid,
  -- The platform's own id for the person (Snoonu: Public ID = Falcon ID).
  external_id         text        NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 100),
  orders_completed    integer     CHECK (orders_completed >= 0),
  login_at            timestamptz,
  shift_start         time,
  late_minutes        integer     CHECK (late_minutes >= 0),
  working_minutes     integer     CHECK (working_minutes >= 0),
  online_minutes      integer     CHECK (online_minutes >= 0),
  accepted            integer     CHECK (accepted >= 0),
  rejected            integer     CHECK (rejected >= 0),
  cancelled           integer     CHECK (cancelled >= 0),
  earnings            numeric(18, 4),
  cod                 numeric(18, 4),
  currency            char(3)     REFERENCES platform.currency (code),
  -- Every other column of the sheet, by metric key; unknown columns are kept too.
  metrics             jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metrics) = 'object'),
  is_current          boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT daily_performance_pk PRIMARY KEY (id, business_date),
  CONSTRAINT daily_performance_money_ck CHECK ((earnings IS NULL AND cod IS NULL) OR currency IS NOT NULL),
  CONSTRAINT daily_performance_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT daily_performance_run_fk FOREIGN KEY (company_id, sync_run_id) REFERENCES performance.sync_run (company_id, id),
  CONSTRAINT daily_performance_platform_fk FOREIGN KEY (company_id, client_platform_id) REFERENCES performance.client_platform (company_id, id),
  CONSTRAINT daily_performance_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id)
) PARTITION BY RANGE (business_date);
-- One current row per sheet id, and per matched person, per platform per date.
CREATE UNIQUE INDEX daily_performance_current_external_uq
  ON performance.daily_performance (client_platform_id, external_id, business_date) WHERE is_current;
CREATE UNIQUE INDEX daily_performance_current_party_uq
  ON performance.daily_performance (client_platform_id, party_id, business_date) WHERE is_current AND party_id IS NOT NULL;
CREATE INDEX daily_performance_date_idx ON performance.daily_performance (company_id, business_date, party_id);
CREATE INDEX daily_performance_run_idx ON performance.daily_performance (sync_run_id);
SELECT app.setup_table('performance', 'daily_performance', 'company_append');

-- Insert-only, except that a re-import may retire a row: `is_current` true -> false and
-- nothing else. The append-only trigger is replaced by this narrower one, and the app may
-- update that single column.
CREATE FUNCTION performance.tg_daily_performance_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'performance.daily_performance is append-only: DELETE is not allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the true -> false flip; every other column must stay exactly as inserted.
  IF NOT (OLD.is_current AND NOT NEW.is_current)
     OR (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current') THEN
    RAISE EXCEPTION 'performance.daily_performance: only is_current may change, from true to false'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER z_append_only ON performance.daily_performance;
CREATE TRIGGER z_retire_only BEFORE UPDATE OR DELETE ON performance.daily_performance
  FOR EACH ROW EXECUTE FUNCTION performance.tg_daily_performance_guard();
GRANT UPDATE (is_current) ON performance.daily_performance TO fibrex_app;
-- From 2026-01 (room for back-filled history from the sheet) to 3 months ahead.
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('performance.daily_performance'::regclass, '2026-01-01', 3);

-- =============================================================================
-- performance.unmatched_identifier: sheet ids with no person yet (the unmatched queue).
-- =============================================================================
CREATE TABLE performance.unmatched_identifier (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL,
  company_id          uuid        NOT NULL,
  client_platform_id  uuid        NOT NULL,
  external_id         text        NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 100),
  first_seen          date        NOT NULL,
  last_seen           date        NOT NULL,
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'linked', 'created', 'ignored')),
  resolved_party_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             integer     NOT NULL DEFAULT 1,
  deleted_at          timestamptz,
  deleted_by          uuid,
  delete_reason       text,
  CONSTRAINT unmatched_identifier_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT unmatched_identifier_seen_ck CHECK (last_seen >= first_seen),
  -- Linked or created means a person was found or made; open and ignored have none.
  CONSTRAINT unmatched_identifier_resolved_ck CHECK ((status IN ('linked', 'created')) = (resolved_party_id IS NOT NULL)),
  CONSTRAINT unmatched_identifier_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT unmatched_identifier_platform_fk FOREIGN KEY (company_id, client_platform_id) REFERENCES performance.client_platform (company_id, id),
  CONSTRAINT unmatched_identifier_party_fk FOREIGN KEY (company_id, resolved_party_id) REFERENCES party.party (company_id, id)
);
CREATE UNIQUE INDEX unmatched_identifier_external_uq
  ON performance.unmatched_identifier (client_platform_id, external_id) WHERE deleted_at IS NULL;
CREATE INDEX unmatched_identifier_status_idx ON performance.unmatched_identifier (company_id, status, last_seen DESC);
SELECT app.setup_table('performance', 'unmatched_identifier', 'company');

-- =============================================================================
-- tracking.tracking_entry: one row per status change of a person on a date. The current
-- status is the latest row; history is never overwritten.
-- =============================================================================
CREATE TABLE tracking.tracking_entry (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  party_id         uuid        NOT NULL,
  business_date    date        NOT NULL,
  -- A state code of the employee state machine (active, inactive, blocked, terminated ...).
  status_code      text        NOT NULL CHECK (status_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- A value of the `status_reason` lookup.
  reason_id        uuid,
  effective_date   date        NOT NULL,
  note             text        CHECK (length(note) <= 2000),
  caller_user_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT tracking_entry_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- Business rule (SPEC 3.3): taking someone off the road always says why.
  CONSTRAINT tracking_entry_reason_ck CHECK (status_code NOT IN ('inactive', 'blocked', 'terminated') OR reason_id IS NOT NULL),
  CONSTRAINT tracking_entry_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT tracking_entry_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT tracking_entry_reason_fk FOREIGN KEY (tenant_id, reason_id) REFERENCES cfg.lookup_value (tenant_id, id),
  CONSTRAINT tracking_entry_caller_fk FOREIGN KEY (tenant_id, caller_user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE INDEX tracking_entry_party_idx ON tracking.tracking_entry (party_id, business_date DESC, created_at DESC);
CREATE INDEX tracking_entry_date_idx ON tracking.tracking_entry (company_id, business_date);
SELECT app.setup_table('tracking', 'tracking_entry', 'company');

-- =============================================================================
-- tracking.id_operator_period: "another person" working someone's platform id (SPEC 3.3).
-- =============================================================================
CREATE TABLE tracking.id_operator_period (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL,
  company_id           uuid        NOT NULL,
  party_identifier_id  uuid        NOT NULL REFERENCES party.party_identifier (id),
  owner_party_id       uuid        NOT NULL,
  -- The operator, when they are a known person; otherwise name and phone only.
  operator_party_id    uuid,
  operator_name        text        CHECK (length(btrim(operator_name)) BETWEEN 1 AND 200),
  operator_phone       text        CHECK (length(operator_phone) BETWEEN 3 AND 40),
  from_date            date        NOT NULL,
  -- Inclusive: the last day. NULL = still operating.
  to_date              date,
  cod_at_handover      numeric(18, 4),
  currency             char(3)     REFERENCES platform.currency (code),
  orders_at_handover   integer     CHECK (orders_at_handover >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              integer     NOT NULL DEFAULT 1,
  deleted_at           timestamptz,
  deleted_by           uuid,
  delete_reason        text,
  CONSTRAINT id_operator_period_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT id_operator_period_dates_ck CHECK (to_date IS NULL OR to_date >= from_date),
  CONSTRAINT id_operator_period_who_ck CHECK (operator_party_id IS NOT NULL OR operator_name IS NOT NULL),
  CONSTRAINT id_operator_period_not_owner_ck CHECK (operator_party_id IS NULL OR operator_party_id <> owner_party_id),
  CONSTRAINT id_operator_period_money_ck CHECK (cod_at_handover IS NULL OR currency IS NOT NULL),
  CONSTRAINT id_operator_period_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT id_operator_period_owner_fk FOREIGN KEY (company_id, owner_party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT id_operator_period_operator_fk FOREIGN KEY (company_id, operator_party_id) REFERENCES party.party (company_id, id)
);
CREATE INDEX id_operator_period_identifier_idx ON tracking.id_operator_period (party_identifier_id);
CREATE INDEX id_operator_period_owner_idx ON tracking.id_operator_period (owner_party_id);
-- One operator per platform id on any day.
ALTER TABLE tracking.id_operator_period ADD CONSTRAINT id_operator_period_no_overlap EXCLUDE USING gist (
  party_identifier_id WITH =, daterange(from_date, to_date, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('tracking', 'id_operator_period', 'company');

-- =============================================================================
-- tracking.call_log: every call made from the morning call sheet (insert-only).
-- =============================================================================
CREATE TABLE tracking.call_log (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  party_id         uuid        NOT NULL,
  business_date    date        NOT NULL,
  caller_user_id   uuid,
  -- A value of the `call_outcome` lookup.
  outcome_id       uuid        NOT NULL,
  note             text        CHECK (length(note) <= 2000),
  at               timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT call_log_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT call_log_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT call_log_outcome_fk FOREIGN KEY (tenant_id, outcome_id) REFERENCES cfg.lookup_value (tenant_id, id),
  CONSTRAINT call_log_caller_fk FOREIGN KEY (tenant_id, caller_user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE INDEX call_log_party_idx ON tracking.call_log (party_id, business_date DESC);
CREATE INDEX call_log_date_idx ON tracking.call_log (company_id, business_date);
SELECT app.setup_table('tracking', 'call_log', 'company_append');

SELECT app.maintain_partitions();
