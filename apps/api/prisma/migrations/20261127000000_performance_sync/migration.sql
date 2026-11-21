-- Phase 4, row 4.3: sync engine.
--
-- performance.scheduled_sync_sources() is SECURITY DEFINER: the scheduler serves every tenant
-- and must know which sources to schedule (and with which cron and time zone) before it can
-- open a unit of work for any of them. It returns ids and schedule settings only, never the
-- sealed adapter settings or any figures. Excel sources are upload-only, so they are left out.
--
-- Additive: one new function, no table change.

CREATE FUNCTION performance.scheduled_sync_sources()
RETURNS TABLE (tenant_id uuid, company_id uuid, sync_source_id uuid, schedule_cron text, time_zone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT s.tenant_id, s.company_id, s.id, s.schedule_cron, s.time_zone
    FROM performance.sync_source s
    JOIN performance.client_platform p ON p.id = s.client_platform_id
   WHERE s.deleted_at IS NULL
     AND s.active
     AND s.adapter_kind <> 'excel'
     AND p.deleted_at IS NULL
     AND p.status = 'active'
$$;

REVOKE ALL ON FUNCTION performance.scheduled_sync_sources() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION performance.scheduled_sync_sources() TO fibrex_app;
