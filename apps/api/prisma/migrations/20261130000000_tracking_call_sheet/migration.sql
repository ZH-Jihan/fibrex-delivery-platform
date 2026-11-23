-- Phase 4, row 4.7: tracking API for the morning call sheet (SPEC 3.3, PLAN 3.11).
--
-- Row 4.1 created the three tracking tables (`tracking_entry`, `id_operator_period`,
-- `call_log`) with RLS, the audit trigger and no DELETE grant (app.setup_table). This row
-- makes `tracking_entry` the call sheet's record:
--
--   * One live entry per person per date (partial unique index). The morning call writes
--     the call outcome, the status, reason, effective date and a note on that one row;
--     edits are versioned updates, and every earlier value stays in the audit log.
--   * Status is optional (a call with no status change records the outcome only), so
--     status_code and effective_date become nullable, always together.
--   * A recorded status is applied to the employee status state machine. `status_state`
--     says where that stands: unchanged (the person already had that status), applied (moved
--     now, `state_history_id` is the history row), pending (effective date in the future;
--     the tracking job applies it on that date), failed (the job could not apply it;
--     `status_error` says why), superseded (a later entry replaced a pending change).
--   * `status_set_by` is the user who recorded the status: the job applies a pending change
--     as that user, so the permission check and the audit rows name them.
--   * tracking.due_status_changes(date) is SECURITY DEFINER: the job serves every tenant and
--     must find which (tenant, company, user) groups have pending changes due before it can
--     open a unit of work for each. It returns ids only.
--
-- Permissions: the keys become tracking.entry.view/create/update, tracking.call.create and
-- tracking.status.apply. Roles holding an old key get the matching new keys; the old keys
-- are switched off (is_active = false), never deleted, so role rows keep their history.
--
-- Expand-only: relaxing NOT NULL, new nullable columns, a defaulted column, new indexes,
-- a function. No row is removed. The table has no rows before this row's API exists; the
-- unique index would refuse to build on duplicates rather than drop any.

ALTER TABLE tracking.tracking_entry ALTER COLUMN status_code DROP NOT NULL;
ALTER TABLE tracking.tracking_entry ALTER COLUMN effective_date DROP NOT NULL;

ALTER TABLE tracking.tracking_entry
  -- A value of the `call_outcome` lookup (answered, no answer, switched off ...).
  ADD COLUMN call_outcome_id   uuid,
  ADD COLUMN status_state      text NOT NULL DEFAULT 'none'
    CHECK (status_state IN ('none', 'unchanged', 'applied', 'pending', 'failed', 'superseded')),
  ADD COLUMN status_set_by     uuid,
  ADD COLUMN status_applied_at timestamptz,
  ADD COLUMN state_history_id  uuid REFERENCES cfg.state_history (id),
  ADD COLUMN status_error      text CHECK (length(status_error) <= 1000),
  ADD CONSTRAINT tracking_entry_call_outcome_fk
    FOREIGN KEY (tenant_id, call_outcome_id) REFERENCES cfg.lookup_value (tenant_id, id),
  ADD CONSTRAINT tracking_entry_status_set_by_fk
    FOREIGN KEY (tenant_id, status_set_by) REFERENCES iam.user_account (tenant_id, id),
  -- A status always carries its effective date, and has an apply state; no status, no state.
  ADD CONSTRAINT tracking_entry_status_pair_ck
    CHECK ((status_code IS NULL) = (effective_date IS NULL)),
  ADD CONSTRAINT tracking_entry_status_state_ck
    CHECK ((status_code IS NULL) = (status_state = 'none')),
  -- Applied means a history row and a time; failed means a reason.
  ADD CONSTRAINT tracking_entry_applied_ck
    CHECK ((status_state = 'applied') = (state_history_id IS NOT NULL AND status_applied_at IS NOT NULL)),
  ADD CONSTRAINT tracking_entry_failed_ck
    CHECK ((status_state = 'failed') = (status_error IS NOT NULL));

-- The call sheet's rule: one live entry per person per date.
CREATE UNIQUE INDEX tracking_entry_person_day_uq
  ON tracking.tracking_entry (party_id, business_date) WHERE deleted_at IS NULL;
-- The job's work list.
CREATE INDEX tracking_entry_pending_idx
  ON tracking.tracking_entry (effective_date) WHERE status_state = 'pending' AND deleted_at IS NULL;

CREATE FUNCTION tracking.due_status_changes(p_until date)
RETURNS TABLE (tenant_id uuid, company_id uuid, status_set_by uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT e.tenant_id, e.company_id, e.status_set_by
    FROM tracking.tracking_entry e
   WHERE e.status_state = 'pending'
     AND e.deleted_at IS NULL
     AND e.effective_date <= p_until
$$;

REVOKE ALL ON FUNCTION tracking.due_status_changes(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracking.due_status_changes(date) TO fibrex_app;

-- =============================================================================
-- Permission keys. The running code also declares them (syncPermissionCatalogue at start-up);
-- they are inserted here so the grants below can refer to them.
-- =============================================================================
INSERT INTO iam.permission (key, module_key, action, resource, description) VALUES
  ('tracking.entry.view',   'tracking', 'view',   'tracking.entry',  'See the morning call sheet, its cross-check and each person''s tracking history'),
  ('tracking.entry.create', 'tracking', 'create', 'tracking.entry',  'Record a call sheet entry or an ID-operator period'),
  ('tracking.entry.update', 'tracking', 'update', 'tracking.entry',  'Change a call sheet entry or an ID-operator period'),
  ('tracking.call.create',  'tracking', 'create', 'tracking.call',   'Log a call'),
  ('tracking.status.apply', 'tracking', 'apply',  'tracking.status', 'Change a person''s status from the call sheet (also needs the employee status permission)')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, action = EXCLUDED.action,
      resource = EXCLUDED.resource, description = EXCLUDED.description, is_active = true;

-- Roles that held an old key get the new keys that replace it.
WITH mapping (old_key, new_key) AS (
  VALUES ('tracking.entry.read', 'tracking.entry.view'),
         ('tracking.entry.create', 'tracking.entry.update'),
         ('tracking.entry.create', 'tracking.status.apply'),
         ('tracking.id_operator_period.read', 'tracking.entry.view'),
         ('tracking.id_operator_period.create', 'tracking.entry.create'),
         ('tracking.id_operator_period.update', 'tracking.entry.update'),
         ('tracking.call_log.read', 'tracking.entry.view'),
         ('tracking.call_log.create', 'tracking.call.create')
)
INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
SELECT DISTINCT rp.tenant_id, rp.role_id, np.id
  FROM iam.role_permission rp
  JOIN iam.permission op ON op.id = rp.permission_id
  JOIN mapping m ON m.old_key = op.key
  JOIN iam.permission np ON np.key = m.new_key
 WHERE rp.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING;

UPDATE iam.permission SET is_active = false
 WHERE key IN ('tracking.entry.read',
               'tracking.id_operator_period.read', 'tracking.id_operator_period.create',
               'tracking.id_operator_period.update', 'tracking.id_operator_period.delete',
               'tracking.id_operator_period.restore',
               'tracking.call_log.read', 'tracking.call_log.create')
   AND is_active;
