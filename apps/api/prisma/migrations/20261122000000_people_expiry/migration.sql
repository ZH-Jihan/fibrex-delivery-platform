-- Phase 3, row 3.4: the document expiry engine (SPEC 3.2, PLAN 3.10 `expiry_alert_log`).
--
-- Design notes:
--   * expiry_alert_log is insert-only (kind company_append): one row per document, alert
--     window and expiry date. The unique index is what makes the daily job idempotent: a
--     second run in the same day, a retry, or a second API instance finds the row and sends
--     nothing. The expiry date is part of the key so a corrected expiry date alerts again
--     (a renewal is a new document anyway).
--   * window_days -1 records the one in-app alert for an expired document (owner answer
--     2026-11-19: expired documents are shown in the app only, never emailed).
--   * channels records what the run actually used (email, in_app).
--   * The alert settings (email list, default windows) are a company row of
--     platform.setting with key 'people.expiry_alerts', not a table of their own.
--   * people.expiry_companies() is SECURITY DEFINER: the daily job serves every tenant and
--     must find which (tenant, company) pairs hold documents with an expiry date before it
--     can open a unit of work for each. It returns ids only, never document contents.

CREATE TABLE people.expiry_alert_log (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  document_id   uuid        NOT NULL,
  window_days   integer     NOT NULL CHECK (window_days BETWEEN -1 AND 365),
  expiry_date   date        NOT NULL,
  alerted_on    date        NOT NULL,
  channels      text[]      NOT NULL CHECK (channels <@ ARRAY['email', 'in_app']::text[] AND cardinality(channels) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT expiry_alert_log_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT expiry_alert_log_document_fk FOREIGN KEY (company_id, document_id) REFERENCES people.document (company_id, id)
);
CREATE UNIQUE INDEX expiry_alert_log_once_uq ON people.expiry_alert_log (document_id, window_days, expiry_date);
CREATE INDEX expiry_alert_log_company_idx ON people.expiry_alert_log (company_id, alerted_on);
SELECT app.setup_table('people', 'expiry_alert_log', 'company_append');

CREATE FUNCTION people.expiry_companies() RETURNS TABLE (tenant_id uuid, company_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT d.tenant_id, d.company_id
    FROM people.document d
   WHERE d.deleted_at IS NULL
     AND d.status <> 'replaced'
     AND d.expiry_date IS NOT NULL
$$;

REVOKE ALL ON FUNCTION people.expiry_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION people.expiry_companies() TO fibrex_app;
