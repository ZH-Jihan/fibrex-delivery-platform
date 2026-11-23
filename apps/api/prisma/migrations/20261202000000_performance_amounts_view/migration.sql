-- Phase 4 row 4.8c: permission performance.amounts.view.
--
-- It lets a person see the COD (pending amount) and balance amount that the platform sheet
-- shows for each rider or driver, on the call sheet details, the employee profile and the call
-- sheet export. Without it the amounts are never sent to the browser.
--
-- Roles that already see performance reports (performance.report.view) get it, so nobody sees
-- less than before and no role sees amounts it could not see before this row. The running code
-- also declares the key (syncPermissionCatalogue at start-up); it is inserted here so the grant
-- below can refer to it.
--
-- Expand-only: one permission row and role grants; nothing is changed or removed.

INSERT INTO iam.permission (key, module_key, action, resource, description) VALUES
  ('performance.amounts.view', 'performance', 'view', 'performance.amounts',
   'See the COD (pending amount) and balance amount of a person from the platform sheet')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, action = EXCLUDED.action,
      resource = EXCLUDED.resource, description = EXCLUDED.description, is_active = true;

INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
SELECT DISTINCT rp.tenant_id, rp.role_id, np.id
  FROM iam.role_permission rp
  JOIN iam.permission op ON op.id = rp.permission_id AND op.key = 'performance.report.view'
  JOIN iam.permission np ON np.key = 'performance.amounts.view'
 WHERE rp.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING;
