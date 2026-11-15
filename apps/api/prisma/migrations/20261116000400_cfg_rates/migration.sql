-- =============================================================================
-- Migration: rate tables and their rows (Phase 2, row 2.9b)
--
-- PLAN 3.7 `rate_table` (S) and `rate_table_row` (S); SPEC 2.10 "Rules and formula engine"
-- and "Effective dating everywhere". Parameter tables that formulas read with
-- rate("<key>", {"<dimension>": value}) and that `/rate-tables/{key}/resolve` answers.
--
-- Design notes:
--   * A table is tenant-wide: a key (for example `pay_rate_per_order`), a name and its
--     dimensions, most important first (for example platform, profession, vehicle_type,
--     zone, slab). The order matters for picking a row (packages/shared/src/rates), so the
--     API only lets dimensions be added at the end, never removed or moved.
--   * A row gives one value (NUMERIC(18,4) with its currency, SPEC 2.9) for some of the
--     dimensions (`dims`, JSON name -> text); a dimension it leaves out matches any value.
--   * Effective dates: two live rows of one table with the same dims may not cover the same
--     day. jsonb equality ignores key order, and dims::text is jsonb's canonical text, so
--     md5(dims::text) is equal exactly when the dims are equal.
--   * Rows in force are frozen except for closing them (valid_to), so a past month can be
--     recomputed exactly as it was. That rule lives in the API (kernel/rates).
-- =============================================================================

CREATE TABLE cfg.rate_table (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description   text        CHECK (length(description) <= 2000),
  dimensions    text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(dimensions) <= 8),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT rate_table_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT rate_table_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT rate_table_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX rate_table_key_uq ON cfg.rate_table (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'rate_table', 'tenant');

CREATE TABLE cfg.rate_table_row (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL,
  rate_table_id uuid          NOT NULL,
  dims          jsonb         NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(dims) = 'object'),
  value         numeric(18,4) NOT NULL,
  currency      text          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from    date          NOT NULL,
  valid_to      date,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer       NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT rate_table_row_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT rate_table_row_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT rate_table_row_table_fk FOREIGN KEY (tenant_id, rate_table_id)
    REFERENCES cfg.rate_table (tenant_id, id),
  CONSTRAINT rate_table_row_tenant_id_uq UNIQUE (tenant_id, id)
);
-- The same dims cannot have two values on one day.
ALTER TABLE cfg.rate_table_row ADD CONSTRAINT rate_table_row_no_overlap EXCLUDE USING gist (
  rate_table_id WITH =, md5(dims::text) WITH =, daterange(valid_from, valid_to, '[]') WITH &&
) WHERE (deleted_at IS NULL);
CREATE INDEX rate_table_row_resolve_idx ON cfg.rate_table_row (rate_table_id, valid_from)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'rate_table_row', 'tenant');
