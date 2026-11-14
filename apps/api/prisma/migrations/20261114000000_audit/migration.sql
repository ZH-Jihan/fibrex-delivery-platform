-- =============================================================================
-- Migration: audit schema (Phase 1, commit 6)
--
-- Purpose (docs/PLAN.md section 2.3, SPEC 2.1-2.3):
--   * audit.audit_log   every data change and every semantic event, insert-only, monthly
--                       partitions
--   * audit.audit_seal  the tamper-evidence hash chain over audit_log, per tenant
--   * audit.export_log  who exported what (also read by the "mass export" risk rule later)
--   * a generic trigger on every mutable business table (kinds 'company' and 'tenant'),
--     so a module cannot forget to audit, including in raw SQL
--
-- How tamper evidence works, and why this way:
--   1. A writer only INSERTs its audit row, with seq = NULL. It takes no shared lock and
--      computes no hash, so auditing never makes business transactions wait on each other.
--   2. audit.seal_pending() runs afterwards (a scheduled job). Per tenant, under an
--      advisory lock, it numbers the committed rows that have no seq yet (gap-free:
--      1, 2, 3, ...), then hashes them in seq order into a chain:
--         h(0)   = hash of the previous seal (32 zero bytes for the first seal)
--         h(i)   = sha256( h(i-1) || canonical text of row i )
--         seal   = (from_seq, to_seq, prev_hash, h(last))
--      Numbering at seal time, not at insert time, is what makes the numbers gap-free and
--      in a fixed order without a lock: a transaction that commits late simply gets later
--      numbers.
--   3. audit.verify_chain() recomputes everything. A changed row changes its seal's hash;
--      a removed row leaves a gap in seq; a removed or reordered seal breaks prev_hash.
--   Limit, by design: cutting off the newest seals together with their rows cannot be seen
--   from inside the database. That is what the export of sealed batches to write-once
--   storage (audit_seal.worm_object_key, filled once the storage adapter exists) is for.
--
-- Runs as fibrex_owner. Hand-written; Prisma applies it with `prisma migrate deploy`.
-- =============================================================================

CREATE SCHEMA audit;
GRANT USAGE ON SCHEMA audit TO fibrex_app;

-- -----------------------------------------------------------------------------
-- More request context for the audit trail. Set by the unit of work with
-- set_config(..., true) next to app.tenant_id / app.user_id; all optional.
-- A malformed value reads as NULL / empty: context must never make a business write fail.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.current_impersonator_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.impersonator_id', true), '')::uuid $$;

CREATE FUNCTION app.current_request_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT left(nullif(current_setting('app.request_id', true), ''), 100) $$;

CREATE FUNCTION app.current_ip() RETURNS inet
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN nullif(current_setting('app.ip', true), '')::inet;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE FUNCTION app.current_role_keys() RETURNS text[]
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN coalesce(nullif(current_setting('app.role_keys', true), '')::text[], '{}'::text[]);
EXCEPTION WHEN others THEN
  RETURN '{}'::text[];
END;
$$;

REVOKE ALL ON FUNCTION app.current_impersonator_id(), app.current_request_id(),
  app.current_ip(), app.current_role_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_impersonator_id(), app.current_request_id(),
  app.current_ip(), app.current_role_keys() TO fibrex_app;

-- =============================================================================
-- audit.audit_log
-- =============================================================================
CREATE TABLE audit.audit_log (
  id               uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid,                 -- NULL for tenant-level rows (users, roles, settings)
  seq              bigint,               -- per tenant, gap-free; NULL until sealed
  at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id          uuid,                 -- NULL for system jobs
  impersonator_id  uuid,                 -- the real user while impersonating
  role_keys        text[]      NOT NULL DEFAULT '{}',
  ip               inet,
  request_id       text,
  module_key       text        NOT NULL,
  entity_type      text        NOT NULL, -- '<schema>.<table>' for data changes
  entity_id        uuid,
  action           text        NOT NULL, -- create, update, delete, restore, login, export ...
  diff             jsonb,                -- { "<column>": { "old": ..., "new": ... } }
  meta             jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  PRIMARY KEY (id, at),
  -- New kinds of event are data, not schema: any lower-case key is accepted.
  CONSTRAINT audit_log_action_ck CHECK (action ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT audit_log_seq_ck CHECK (seq IS NULL OR seq >= 1)
) PARTITION BY RANGE (at);

-- Activity Log (newest first), History tab, per-user view.
CREATE INDEX audit_log_tenant_at_idx ON audit.audit_log (tenant_id, at DESC);
CREATE INDEX audit_log_entity_idx ON audit.audit_log (tenant_id, entity_type, entity_id, at DESC);
CREATE INDEX audit_log_user_idx ON audit.audit_log (tenant_id, user_id, at DESC);
-- Sealing and verification walk rows in seq order; the partial index finds unsealed rows.
CREATE INDEX audit_log_seq_idx ON audit.audit_log (tenant_id, seq);
CREATE INDEX audit_log_pending_idx ON audit.audit_log (tenant_id, at, id) WHERE seq IS NULL;

-- Who, from where: always taken from the transaction's context, never from the caller, so
-- application code cannot write an audit row in somebody else's name. `seq` is forced to
-- NULL (only sealing numbers rows) and `at` must be "now" (no backdating; it is not simply
-- overwritten because a BEFORE trigger may not move a row to another partition).
CREATE FUNCTION audit.tg_audit_log_stamp() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF abs(extract(epoch FROM clock_timestamp() - NEW.at)) > 300 THEN
    RAISE EXCEPTION 'audit.audit_log.at must be the current time'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.seq             := NULL;
  NEW.user_id         := app.current_user_id();
  NEW.impersonator_id := app.current_impersonator_id();
  NEW.role_keys       := app.current_role_keys();
  NEW.ip              := app.current_ip();
  NEW.request_id      := app.current_request_id();
  NEW.created_at      := NEW.at;
  NEW.created_by      := NEW.user_id;
  RETURN NEW;
END;
$$;

-- Insert-only, with exactly one exception: sealing may fill `seq` once (NULL -> number)
-- while every other column stays byte-for-byte the same. DELETE is never allowed. This
-- binds the owner role too, so a mistaken migration cannot rewrite history.
CREATE FUNCTION audit.tg_audit_log_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.seq IS NULL AND NEW.seq IS NOT NULL
     AND (to_jsonb(OLD) - 'seq') = (to_jsonb(NEW) - 'seq') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit.audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER a_stamp BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_log_stamp();
CREATE TRIGGER z_guard BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_log_guard();

REVOKE ALL ON audit.audit_log FROM PUBLIC;
GRANT SELECT, INSERT ON audit.audit_log TO fibrex_app;

-- A session sees its tenant's rows for the companies it may use, plus tenant-level rows.
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_company_isolation ON audit.audit_log
  USING (tenant_id = app.current_tenant_id()
         AND (company_id IS NULL OR company_id = ANY (app.current_company_ids())))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (company_id IS NULL OR company_id = ANY (app.current_company_ids())));

INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('audit.audit_log'::regclass, '2026-11-01', 3);
SELECT app.maintain_partitions();

-- =============================================================================
-- Generic data-change trigger (AFTER INSERT OR UPDATE on every 'company' and 'tenant'
-- table). Runs as the calling role: the insert into audit_log passes the same RLS check
-- the business row just passed.
--
-- Steps:
--   1. Compare old and new row column by column (as jsonb, so one function serves every
--      table). Stamp columns (created_*, updated_*, version) change on every write and are
--      left out.
--   2. Values of columns that hold secrets (name contains password, secret, hash, token or
--      encrypted) are replaced by "[redacted]": the log shows THAT they changed, never the
--      value.
--   3. An UPDATE that changed nothing else writes no audit row.
--   4. The action is derived from deleted_at: NULL -> set is 'delete', set -> NULL is
--      'restore', anything else 'update'.
-- =============================================================================
CREATE FUNCTION audit.tg_audit_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  n         jsonb := to_jsonb(NEW);
  o         jsonb;
  noise     constant text[] := ARRAY['created_at', 'created_by', 'updated_at', 'updated_by', 'version'];
  secret    constant text   := '(password|secret|hash|token|encrypted)';
  redacted  constant jsonb  := '"[redacted]"'::jsonb;
  v_action  text;
  v_diff    jsonb;
  v_meta    jsonb;
  v_tenant  uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'create';
    SELECT jsonb_object_agg(e.key, jsonb_build_object(
             'old', NULL,
             'new', CASE WHEN e.key ~ secret THEN redacted ELSE e.value END))
      INTO v_diff
      FROM jsonb_each(n) e
     WHERE e.value <> 'null'::jsonb AND e.key <> ALL (noise);
  ELSE
    o := to_jsonb(OLD);
    SELECT jsonb_object_agg(e.key, jsonb_build_object(
             'old', CASE WHEN e.key ~ secret AND (o -> e.key) <> 'null'::jsonb THEN redacted ELSE o -> e.key END,
             'new', CASE WHEN e.key ~ secret AND e.value <> 'null'::jsonb THEN redacted ELSE e.value END))
      INTO v_diff
      FROM jsonb_each(n) e
     WHERE e.value IS DISTINCT FROM (o -> e.key) AND e.key <> ALL (noise);
    IF v_diff IS NULL THEN
      RETURN NULL;
    END IF;
    v_action := CASE
      WHEN (o -> 'deleted_at') = 'null'::jsonb AND (n -> 'deleted_at') <> 'null'::jsonb THEN 'delete'
      WHEN (o -> 'deleted_at') <> 'null'::jsonb AND (n -> 'deleted_at') = 'null'::jsonb THEN 'restore'
      ELSE 'update'
    END;
    IF v_action = 'delete' THEN
      v_meta := jsonb_build_object('reason', n -> 'delete_reason');
    END IF;
  END IF;

  -- platform.tenant is the root: its own id is the tenant.
  v_tenant := coalesce(
    n ->> 'tenant_id',
    CASE WHEN TG_TABLE_SCHEMA = 'platform' AND TG_TABLE_NAME = 'tenant' THEN n ->> 'id' END)::uuid;

  INSERT INTO audit.audit_log (tenant_id, company_id, module_key, entity_type, entity_id, action, diff, meta)
  VALUES (v_tenant, (n ->> 'company_id')::uuid, TG_TABLE_SCHEMA,
          TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, (n ->> 'id')::uuid, v_action, v_diff, v_meta);
  RETURN NULL;
END;
$$;

-- From now on app.setup_table attaches the audit trigger to every 'company' and 'tenant'
-- table. Same body as in the foundation migration plus the zz_audit line.
CREATE OR REPLACE FUNCTION app.setup_table(p_schema text, p_table text, p_kind text) RETURNS void
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
    EXECUTE format('CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row()', t);
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

-- Attach the audit trigger to the tables that already exist. Every 'company' and 'tenant'
-- table carries the b_tenancy_immutable trigger, which identifies them reliably.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT format('%I.%I', n.nspname, c.relname) AS t
             FROM pg_catalog.pg_trigger tg
             JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE tg.tgname = 'b_tenancy_immutable' AND NOT tg.tgisinternal
            ORDER BY 1
  LOOP
    EXECUTE format('CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row()', r.t);
  END LOOP;
END;
$$;
-- platform.tenant was set up by hand (it is not tenant-scoped by a tenant_id column).
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE ON platform.tenant
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_row();

-- =============================================================================
-- audit.audit_seal: one row per sealed batch. The app can only read it; rows are written
-- by audit.seal_pending() (SECURITY DEFINER).
-- =============================================================================
CREATE TABLE audit.audit_seal (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL REFERENCES platform.tenant (id),
  from_seq         bigint      NOT NULL,
  to_seq           bigint      NOT NULL,
  prev_hash        bytea       NOT NULL,
  hash             bytea       NOT NULL,
  sealed_at        timestamptz NOT NULL DEFAULT now(),
  worm_object_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT audit_seal_range_ck CHECK (from_seq >= 1 AND to_seq >= from_seq),
  CONSTRAINT audit_seal_hash_ck CHECK (octet_length(prev_hash) = 32 AND octet_length(hash) = 32),
  CONSTRAINT audit_seal_from_uq UNIQUE (tenant_id, from_seq),
  CONSTRAINT audit_seal_to_uq UNIQUE (tenant_id, to_seq)
);

-- Insert-only, except that the write-once storage key may be filled once after export.
CREATE FUNCTION audit.tg_audit_seal_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.worm_object_key IS NULL AND NEW.worm_object_key IS NOT NULL
     AND (to_jsonb(OLD) - 'worm_object_key') = (to_jsonb(NEW) - 'worm_object_key') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit.audit_seal is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER z_guard BEFORE UPDATE OR DELETE ON audit.audit_seal
  FOR EACH ROW EXECUTE FUNCTION audit.tg_audit_seal_guard();

REVOKE ALL ON audit.audit_seal FROM PUBLIC;
GRANT SELECT ON audit.audit_seal TO fibrex_app;
GRANT UPDATE (worm_object_key) ON audit.audit_seal TO fibrex_app;
ALTER TABLE audit.audit_seal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.audit_seal
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- audit.seal_pending: numbers and seals every committed, not yet sealed row, for every
-- tenant, at most p_batch rows per seal. Returns one row per seal written.
--
-- SECURITY DEFINER because it must see all companies of a tenant and fill `seq`, which the
-- app role may not do. It takes no arguments that select data, so calling it can only ever
-- do the one thing it is for. TimeZone is pinned to UTC because the canonical text of a
-- row (to_jsonb) renders timestamps in the session time zone; verification pins it too.
--
-- Steps per tenant:
--   1. Take a per-tenant advisory lock (held to the end of the transaction): two sealing
--      runs can never number the same rows.
--   2. Read where the chain ends (last to_seq and hash; 0 and 32 zero bytes at the start).
--   3. Number the oldest unsealed rows last+1 .. last+n in (at, id) order.
--   4. Hash those rows in seq order, each hash feeding the next, and store the seal.
--   5. Repeat while full batches remain.
-- -----------------------------------------------------------------------------
CREATE FUNCTION audit.seal_pending(p_batch integer DEFAULT 5000)
RETURNS TABLE (sealed_tenant_id uuid, sealed_from_seq bigint, sealed_to_seq bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $$
DECLARE
  t       uuid;
  v_last  bigint;
  v_prev  bytea;
  v_hash  bytea;
  v_n     bigint;
  r       record;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 100000 THEN
    RAISE EXCEPTION 'p_batch must be between 1 and 100000';
  END IF;

  FOR t IN SELECT DISTINCT l.tenant_id FROM audit.audit_log l WHERE l.seq IS NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtext('fibrex.audit_seal'), hashtext(t::text));
    LOOP
      SELECT s.to_seq, s.hash INTO v_last, v_prev
        FROM audit.audit_seal s WHERE s.tenant_id = t ORDER BY s.to_seq DESC LIMIT 1;
      IF NOT FOUND THEN
        v_last := 0;
        v_prev := decode(repeat('00', 32), 'hex');
      END IF;

      WITH pending AS (
        SELECT l.id, l.at, row_number() OVER (ORDER BY l.at, l.id) AS rn
          FROM audit.audit_log l
         WHERE l.tenant_id = t AND l.seq IS NULL
         ORDER BY l.at, l.id
         LIMIT p_batch
      )
      UPDATE audit.audit_log l SET seq = v_last + p.rn
        FROM pending p WHERE l.id = p.id AND l.at = p.at;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      EXIT WHEN v_n = 0;

      v_hash := v_prev;
      FOR r IN SELECT to_jsonb(l)::text AS canonical
                 FROM audit.audit_log l
                WHERE l.tenant_id = t AND l.seq > v_last AND l.seq <= v_last + v_n
                ORDER BY l.seq
      LOOP
        v_hash := sha256(v_hash || convert_to(r.canonical, 'UTF8'));
      END LOOP;

      INSERT INTO audit.audit_seal (tenant_id, from_seq, to_seq, prev_hash, hash)
      VALUES (t, v_last + 1, v_last + v_n, v_prev, v_hash);

      sealed_tenant_id := t;
      sealed_from_seq  := v_last + 1;
      sealed_to_seq    := v_last + v_n;
      RETURN NEXT;
      EXIT WHEN v_n < p_batch;
    END LOOP;
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- audit.verify_chain: recomputes the chain of the tenant in the transaction's context and
-- reports the first problem, if any. Always returns exactly one row.
--
-- Checks, seal by seal in order:
--   * the seal starts right after the previous one ends (no missing or overlapping seal);
--   * its prev_hash is the previous seal's hash;
--   * it covers exactly to_seq - from_seq + 1 rows (none removed);
--   * hashing those rows again gives the stored hash (none changed).
-- Finally, no row may carry a seq beyond the last seal.
-- -----------------------------------------------------------------------------
CREATE FUNCTION audit.verify_chain()
RETURNS TABLE (ok boolean, seals_checked integer, rows_checked bigint, unsealed_rows bigint,
               failed_seal_id uuid, failed_from_seq bigint, failure text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $$
DECLARE
  t       uuid   := app.current_tenant_id();
  s       record;
  r       record;
  v_prev  bytea  := decode(repeat('00', 32), 'hex');
  v_next  bigint := 1;
  v_hash  bytea;
  v_n     bigint;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'audit.verify_chain needs a tenant in the transaction context';
  END IF;
  ok := true;
  seals_checked := 0;
  rows_checked := 0;
  SELECT count(*) INTO unsealed_rows FROM audit.audit_log l WHERE l.tenant_id = t AND l.seq IS NULL;

  FOR s IN SELECT a.id, a.from_seq, a.to_seq, a.prev_hash, a.hash
             FROM audit.audit_seal a WHERE a.tenant_id = t ORDER BY a.from_seq
  LOOP
    failure := CASE
      WHEN s.from_seq <> v_next THEN 'A seal is missing or seals overlap.'
      WHEN s.prev_hash <> v_prev THEN 'The seal does not continue from the previous seal.'
    END;
    IF failure IS NULL THEN
      v_hash := s.prev_hash;
      v_n := 0;
      FOR r IN SELECT to_jsonb(l)::text AS canonical
                 FROM audit.audit_log l
                WHERE l.tenant_id = t AND l.seq BETWEEN s.from_seq AND s.to_seq
                ORDER BY l.seq
      LOOP
        v_hash := sha256(v_hash || convert_to(r.canonical, 'UTF8'));
        v_n := v_n + 1;
      END LOOP;
      rows_checked := rows_checked + v_n;
      IF v_n <> s.to_seq - s.from_seq + 1 THEN
        failure := 'Audit rows are missing from a sealed range.';
      ELSIF v_hash <> s.hash THEN
        failure := 'Audit rows were changed after they were sealed.';
      END IF;
    END IF;
    IF failure IS NOT NULL THEN
      ok := false;
      failed_seal_id := s.id;
      failed_from_seq := s.from_seq;
      RETURN NEXT;
      RETURN;
    END IF;
    seals_checked := seals_checked + 1;
    v_prev := s.hash;
    v_next := s.to_seq + 1;
  END LOOP;

  IF EXISTS (SELECT 1 FROM audit.audit_log l WHERE l.tenant_id = t AND l.seq >= v_next) THEN
    ok := false;
    failed_from_seq := v_next;
    failure := 'Audit rows are numbered but not covered by any seal.';
  END IF;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION audit.seal_pending(integer), audit.verify_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.seal_pending(integer), audit.verify_chain() TO fibrex_app;

-- =============================================================================
-- audit.export_log: one row per export a user ran (SPEC 2.3).
-- =============================================================================
CREATE TABLE audit.export_log (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id    uuid        NOT NULL REFERENCES platform.tenant (id),
  user_id      uuid,
  entity_type  text        NOT NULL,
  filters      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  row_count    integer     NOT NULL CHECK (row_count >= 0),
  format       text        NOT NULL CHECK (format ~ '^[a-z0-9]{2,10}$'),
  file_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid
);
CREATE INDEX export_log_user_idx ON audit.export_log (tenant_id, user_id, created_at DESC);
SELECT app.setup_table('audit', 'export_log', 'tenant_append');
