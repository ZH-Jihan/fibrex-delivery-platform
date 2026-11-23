-- Phase 4, row 4.9b: take document expiry dates from the Snoonu FDB check.
--
-- Expand-only; nothing existing is changed or removed:
--   * people.document.source: where a document row came from. Null for every existing row
--     (entered by staff or confirmed from a scan); 'snoonu_fdb' for a date taken from the FDB
--     tab. A document with that source and no file attached is "date only, file missing": the
--     missing-documents report still asks for the scan, the expiry engine still uses the date.
--   * performance.fdb_difference.review_status also accepts 'applied' (the date was taken into
--     our records). The check constraint is replaced by a wider one.
--   * Permission performance.fdb_check.apply. Granted only to roles that already hold both
--     performance.fdb_check.run and people.document.update, so nobody gains the right to write
--     documents that they could not write before.

ALTER TABLE people.document ADD COLUMN source text
  CHECK (source IS NULL OR source IN ('snoonu_fdb'));

ALTER TABLE performance.fdb_difference DROP CONSTRAINT IF EXISTS fdb_difference_review_status_check;
ALTER TABLE performance.fdb_difference ADD CONSTRAINT fdb_difference_review_status_check
  CHECK (review_status IN ('open', 'reviewed', 'ignored', 'applied'));

INSERT INTO iam.permission (key, module_key, action, resource, description) VALUES
  ('performance.fdb_check.apply', 'performance', 'apply', 'performance.fdb_check',
   'Take expiry dates from the Snoonu FDB check into our employee documents')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, action = EXCLUDED.action,
      resource = EXCLUDED.resource, description = EXCLUDED.description, is_active = true;

INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
SELECT DISTINCT a.tenant_id, a.role_id, np.id
  FROM iam.role_permission a
  JOIN iam.permission pa ON pa.id = a.permission_id AND pa.key = 'performance.fdb_check.run'
  JOIN iam.role_permission b ON b.role_id = a.role_id AND b.deleted_at IS NULL
  JOIN iam.permission pb ON pb.id = b.permission_id AND pb.key = 'people.document.update'
  JOIN iam.permission np ON np.key = 'performance.fdb_check.apply'
 WHERE a.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING;
