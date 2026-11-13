-- =============================================================================
-- Migration: foundation helpers (Phase 1, commit 3)
--
-- Purpose: database-level building blocks every module table relies on, so that the
-- rules in CLAUDE.md hold even if application code has a bug:
--   * UUIDv7 primary keys (SPEC 2.12)
--   * request context (tenant, companies, user) read by row-level security (SPEC 2.7)
--   * row stamping: created/updated columns and the optimistic-lock version (SPEC 2.2)
--   * tenant and company of a row can never change after insert
--   * append-only tables refuse UPDATE and DELETE (SPEC 2.2, 2.9)
--   * monthly partition maintenance (SPEC 2.12)
--   * one function that applies triggers, grants and RLS policies to a table, so every
--     table is set up the same way
--
-- Runs as fibrex_owner. Hand-written; Prisma applies it with `prisma migrate deploy`.
-- =============================================================================

CREATE SCHEMA app;          -- helper functions, owned by fibrex_owner
CREATE SCHEMA partitions;   -- monthly partitions live here, outside the Prisma-managed schemas

GRANT USAGE ON SCHEMA app TO fibrex_app, fibrex_bi;
REVOKE ALL ON SCHEMA partitions FROM PUBLIC;

-- Functions are executable by PUBLIC by default; Fibrex grants execution explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- UUIDv7: 48-bit Unix millisecond timestamp, then random bits (RFC 9562).
-- Time-ordered keys keep B-tree inserts at the right-hand edge of the index.
-- PostgreSQL 16 has no built-in uuidv7(); the API also generates v7 ids itself.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  unix_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bytes   bytea  := gen_random_bytes(16);
BEGIN
  -- Bytes 0-5: timestamp (int8send gives 8 big-endian bytes; skip the top 2).
  bytes := overlay(bytes PLACING substring(int8send(unix_ms) FROM 3) FROM 1 FOR 6);
  -- Byte 6 high nibble: version 7. Byte 8 top two bits: RFC variant 10.
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  RETURN encode(bytes, 'hex')::uuid;
END;
$$;
GRANT EXECUTE ON FUNCTION app.uuid_generate_v7() TO fibrex_app;

-- -----------------------------------------------------------------------------
-- Request context. The API runs every request inside a transaction that starts with
--   SET LOCAL app.tenant_id = '<uuid>';
--   SET LOCAL app.company_ids = '{<uuid>,<uuid>}';
--   SET LOCAL app.user_id = '<uuid>';           (absent for system jobs)
--   SET LOCAL app.impersonator_id = '<uuid>';   (only while impersonating)
-- Missing settings return NULL / an empty array, so policies fail closed: no context,
-- no rows.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_company_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[], '{}'::uuid[]) $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_company_ids(), app.current_user_id()
  TO fibrex_app, fibrex_bi;

-- -----------------------------------------------------------------------------
-- Row stamping for mutable tables.
-- INSERT: created_* and updated_* filled, version starts at 1.
-- UPDATE: created_* cannot be changed; updated_* refreshed; version + 1.
-- The repository layer performs `UPDATE ... WHERE id = $1 AND version = $2`; zero rows
-- updated means somebody else saved first (SPEC 2.2 optimistic locking).
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.tg_row_stamp() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := coalesce(NEW.created_by, app.current_user_id());
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    NEW.version    := 1;
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := coalesce(app.current_user_id(), NEW.updated_by);
    NEW.version    := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Tenant and company of a row are fixed at insert. RLS WITH CHECK already stops moving a
-- row to a tenant or company outside the session; this also stops moving it between two
-- companies the session can see. Uses jsonb so one function serves tables with and
-- without company_id.
CREATE FUNCTION app.tg_tenancy_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
BEGIN
  IF (o -> 'tenant_id') IS DISTINCT FROM (n -> 'tenant_id')
     OR (o -> 'company_id') IS DISTINCT FROM (n -> 'company_id') THEN
    RAISE EXCEPTION 'tenant_id and company_id cannot change after insert (%.%)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Insert stamp for append-only tables (they have no updated_* or version columns).
CREATE FUNCTION app.tg_insert_stamp() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.created_by := coalesce(NEW.created_by, app.current_user_id());
  RETURN NEW;
END;
$$;

-- Append-only tables are immutable facts (audit, journals, movements, login events).
-- Grants already withhold UPDATE and DELETE from fibrex_app; this trigger also stops the
-- owner role, so even a mistaken migration cannot rewrite history.
CREATE FUNCTION app.tg_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: % is not allowed; post a reversal instead',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- -----------------------------------------------------------------------------
-- app.setup_table: applies the standard triggers, grants and RLS policy to one table.
--
-- Kinds (docs/PLAN.md section 2.1):
--   company          S tables: tenant + company scoped, mutable, soft delete
--   tenant           T tables: tenant scoped, mutable, soft delete
--   company_append   A tables with company_id: insert-only
--   tenant_append    A tables without company_id: insert-only
--   global           G reference data: read-only for the app (written by migrations/seed)
--   global_catalog   G catalogues that module manifests register at start-up
--
-- Notes:
--   * fibrex_app never gets DELETE or TRUNCATE on any table: no physical deletes.
--   * RLS is enabled but not FORCED: the owner role runs migrations and seeds; the app
--     never connects as owner.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.setup_table(p_schema text, p_table text, p_kind text) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  t text := format('%I.%I', p_schema, p_table);
  tenant_rule  text := 'tenant_id = app.current_tenant_id()';
  company_rule text := 'tenant_id = app.current_tenant_id() AND company_id = ANY (app.current_company_ids())';
BEGIN
  IF p_kind NOT IN ('company', 'tenant', 'company_append', 'tenant_append', 'global', 'global_catalog') THEN
    RAISE EXCEPTION 'unknown table kind %', p_kind;
  END IF;

  -- Triggers
  IF p_kind IN ('company', 'tenant') THEN
    EXECUTE format('CREATE TRIGGER a_row_stamp BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.tg_row_stamp()', t);
    EXECUTE format('CREATE TRIGGER b_tenancy_immutable BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.tg_tenancy_immutable()', t);
  ELSIF p_kind IN ('company_append', 'tenant_append') THEN
    EXECUTE format('CREATE TRIGGER a_insert_stamp BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION app.tg_insert_stamp()', t);
    EXECUTE format('CREATE TRIGGER z_append_only BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION app.tg_append_only()', t);
  ELSIF p_kind = 'global_catalog' THEN
    EXECUTE format('CREATE TRIGGER a_row_stamp BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.tg_row_stamp()', t);
  END IF;

  -- Grants
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', t);
  IF p_kind IN ('company', 'tenant', 'global_catalog') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO fibrex_app', t);
  ELSIF p_kind IN ('company_append', 'tenant_append') THEN
    EXECUTE format('GRANT SELECT, INSERT ON %s TO fibrex_app', t);
  ELSE
    EXECUTE format('GRANT SELECT ON %s TO fibrex_app', t);
  END IF;

  -- Row-level security
  IF p_kind IN ('company', 'company_append') THEN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_company_isolation ON %s USING (%s) WITH CHECK (%s)', t, company_rule, company_rule);
  ELSIF p_kind IN ('tenant', 'tenant_append') THEN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (%s) WITH CHECK (%s)', t, tenant_rule, tenant_rule);
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Monthly partitions (SPEC 2.12).
--
-- Partitioned parents are registered in app.partitioned_table. app.maintain_partitions()
-- creates any missing monthly partition from `start_month` up to `months_ahead` months
-- after the current month. It is idempotent and runs:
--   * in the migration that registers a table, and
--   * daily from the job scheduler (Phase 1, commit 9), as fibrex_app.
-- It is SECURITY DEFINER (runs as the owner, because creating tables needs ownership),
-- with a fixed search_path, and only ever touches registered parents.
--
-- There is deliberately no DEFAULT partition: a row outside every partition fails loudly
-- instead of landing in a catch-all that would later block creating the real partition.
-- -----------------------------------------------------------------------------
CREATE TABLE app.partitioned_table (
  parent        regclass PRIMARY KEY,
  start_month   date     NOT NULL CHECK (start_month = date_trunc('month', start_month)::date),
  months_ahead  integer  NOT NULL DEFAULT 3 CHECK (months_ahead BETWEEN 1 AND 24)
);
REVOKE ALL ON app.partitioned_table FROM PUBLIC;
GRANT SELECT ON app.partitioned_table TO fibrex_app;

CREATE FUNCTION app.maintain_partitions() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r        record;
  m        date;
  last_m   date;
  part     text;
  lower_b  text;
  upper_b  text;
  created  integer := 0;
BEGIN
  FOR r IN SELECT p.parent, p.start_month, p.months_ahead, c.relname, n.nspname,
                  format_type(a.atttypid, a.atttypmod) AS key_type
           FROM app.partitioned_table p
           JOIN pg_class c ON c.oid = p.parent
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_partitioned_table pt ON pt.partrelid = p.parent
           JOIN pg_attribute a ON a.attrelid = p.parent AND a.attnum = pt.partattrs[0]
  LOOP
    IF r.key_type NOT IN ('date', 'timestamp with time zone') THEN
      RAISE EXCEPTION 'partition key of % must be date or timestamptz, found %', r.parent, r.key_type;
    END IF;
    m := r.start_month;
    -- Months are calendar months in UTC (timestamps are stored in UTC, SPEC 1).
    last_m := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => r.months_ahead))::date;
    WHILE m <= last_m LOOP
      part := format('%s_%s_%s', r.nspname, r.relname, to_char(m, 'YYYY_MM'));
      IF to_regclass(format('partitions.%I', part)) IS NULL THEN
        -- Bounds are written as explicit literals so the session time zone cannot shift
        -- them: '2026-11-01' for date keys, '2026-11-01 00:00:00+00' for timestamptz keys.
        IF r.key_type = 'date' THEN
          lower_b := to_char(m, 'YYYY-MM-DD');
          upper_b := to_char((m + interval '1 month')::date, 'YYYY-MM-DD');
        ELSE
          lower_b := to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00';
          upper_b := to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00';
        END IF;
        EXECUTE format('CREATE TABLE partitions.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                       part, r.parent, lower_b, upper_b);
        created := created + 1;
      END IF;
      m := (m + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN created;
END;
$$;
GRANT EXECUTE ON FUNCTION app.maintain_partitions() TO fibrex_app;
