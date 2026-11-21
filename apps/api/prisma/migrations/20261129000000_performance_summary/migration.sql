-- Phase 4, row 4.6b: the daily performance summary email.
--
-- Additive: one new table and one new function, no change to existing tables.
--   * performance.summary_log: one row per company and summary date once the email has been
--     sent (insert-only). The unique index is the "never send twice" guard: the sender claims
--     the row first and a second sender (retry, second API instance, "Send now" pressed after
--     the schedule ran) finds the date taken and sends nothing.
--   * The settings (recipients, send time, time zone, on/off) are a company row of
--     platform.setting with key 'performance.summary_email', not a table of their own.
--   * performance.summary_companies() is SECURITY DEFINER: the job serves every tenant and must
--     find which (tenant, company) pairs have an active client platform before it can open a
--     unit of work for each. It returns ids only.

CREATE TABLE performance.summary_log (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  -- The business date the figures are for (yesterday in the company's time zone).
  summary_date   date        NOT NULL,
  -- full: the day's figures; incomplete: the "data incomplete" notice (sync failed, partial or missing).
  variant        text        NOT NULL CHECK (variant IN ('full', 'incomplete')),
  -- Why the incomplete variant was sent (no_run, failed, partial, no_figures); NULL for full.
  reason         text        CHECK (reason ~ '^[a-z][a-z0-9_]{0,59}$'),
  trigger        text        NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  recipients     text[]      NOT NULL CHECK (cardinality(recipients) > 0),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT summary_log_reason_ck CHECK ((variant = 'incomplete') = (reason IS NOT NULL)),
  CONSTRAINT summary_log_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
CREATE UNIQUE INDEX summary_log_once_uq ON performance.summary_log (company_id, summary_date);
SELECT app.setup_table('performance', 'summary_log', 'company_append');

CREATE FUNCTION performance.summary_companies() RETURNS TABLE (tenant_id uuid, company_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT p.tenant_id, p.company_id
    FROM performance.client_platform p
   WHERE p.deleted_at IS NULL
     AND p.status = 'active'
$$;

REVOKE ALL ON FUNCTION performance.summary_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION performance.summary_companies() TO fibrex_app;
