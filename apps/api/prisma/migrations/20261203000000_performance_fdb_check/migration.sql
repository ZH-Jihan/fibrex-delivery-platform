-- Phase 4, row 4.9: Snoonu FDB report check.
--
-- Additive: two new tables and three permission keys; nothing existing is changed.
--   * performance.fdb_check: one row per check run (insert-only). It keeps what the FDB tab said
--     (`rows`, the parsed rows as read, before any comparison) so a later question about what
--     Snoonu showed on that day can be answered, plus the counts.
--   * performance.fdb_difference: one row per difference found by a run, with the review state
--     staff set (open, reviewed, ignored). The check never changes an employee, a document or a
--     status: staff change those on the employee profile.
--   * Permissions performance.fdb_check.read / .run / .review. The running code declares them
--     too (syncPermissionCatalogue at start-up); they are inserted here so the grants below can
--     refer to them. read goes to roles that already see performance reports; run and review go
--     to roles that already run a sync.

CREATE TABLE performance.fdb_check (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,
  company_id         uuid        NOT NULL,
  client_platform_id uuid        NOT NULL,
  -- The sync source whose reader was used; NULL for an uploaded file.
  sync_source_id     uuid,
  source             text        NOT NULL CHECK (source IN ('sheet', 'upload')),
  file_object_id     uuid,
  business_date      date        NOT NULL,
  snapshot_sha256    text        NOT NULL,
  rows_read          integer     NOT NULL CHECK (rows_read >= 0),
  matched            integer     NOT NULL CHECK (matched >= 0),
  unmatched          integer     NOT NULL CHECK (unmatched >= 0),
  differences_count  integer     NOT NULL CHECK (differences_count >= 0),
  -- The tab as parsed (identifier, name, statuses, dates as text): the raw record of the run.
  rows               jsonb       NOT NULL DEFAULT '[]',
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  CONSTRAINT fdb_check_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT fdb_check_platform_fk FOREIGN KEY (company_id, client_platform_id) REFERENCES performance.client_platform (company_id, id),
  CONSTRAINT fdb_check_source_fk FOREIGN KEY (company_id, sync_source_id) REFERENCES performance.sync_source (company_id, id),
  CONSTRAINT fdb_check_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX fdb_check_platform_idx ON performance.fdb_check (company_id, client_platform_id, created_at DESC);
SELECT app.setup_table('performance', 'fdb_check', 'company_append');

CREATE TABLE performance.fdb_difference (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,
  company_id         uuid        NOT NULL,
  fdb_check_id       uuid        NOT NULL,
  client_platform_id uuid        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN (
                       'unmatched_id', 'no_employee', 'not_in_fdb', 'status_differs',
                       'expiry_differs', 'missing_ours', 'missing_theirs')),
  -- A document type code (qid, passport ...) for the document kinds, NULL otherwise.
  field              text        CHECK (field ~ '^[a-z][a-z0-9_]{0,59}$'),
  party_id           uuid,
  external_id        text,
  display_name       text,
  -- What each side shows, as text (a date, a status); NULL when that side has nothing.
  ours_value         text,
  theirs_value       text,
  review_status      text        NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'reviewed', 'ignored')),
  review_note        text,
  reviewed_at        timestamptz,
  reviewed_by        uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer     NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  deleted_by         uuid,
  delete_reason      text,
  CONSTRAINT fdb_difference_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT fdb_difference_check_fk FOREIGN KEY (company_id, fdb_check_id) REFERENCES performance.fdb_check (company_id, id),
  CONSTRAINT fdb_difference_platform_fk FOREIGN KEY (company_id, client_platform_id) REFERENCES performance.client_platform (company_id, id),
  CONSTRAINT fdb_difference_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT fdb_difference_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX fdb_difference_check_idx ON performance.fdb_difference (company_id, fdb_check_id);
CREATE INDEX fdb_difference_party_idx ON performance.fdb_difference (company_id, party_id) WHERE party_id IS NOT NULL;
SELECT app.setup_table('performance', 'fdb_difference', 'company');

INSERT INTO iam.permission (key, module_key, action, resource, description) VALUES
  ('performance.fdb_check.read', 'performance', 'read', 'performance.fdb_check',
   'See the Snoonu FDB report check and its differences'),
  ('performance.fdb_check.run', 'performance', 'run', 'performance.fdb_check',
   'Run the Snoonu FDB report check (from the sheet or an uploaded Excel file)'),
  ('performance.fdb_check.review', 'performance', 'review', 'performance.fdb_check',
   'Mark an FDB report difference as reviewed or ignored')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, action = EXCLUDED.action,
      resource = EXCLUDED.resource, description = EXCLUDED.description, is_active = true;

INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
SELECT DISTINCT rp.tenant_id, rp.role_id, np.id
  FROM iam.role_permission rp
  JOIN iam.permission op ON op.id = rp.permission_id AND op.key = 'performance.report.view'
  JOIN iam.permission np ON np.key = 'performance.fdb_check.read'
 WHERE rp.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
SELECT DISTINCT rp.tenant_id, rp.role_id, np.id
  FROM iam.role_permission rp
  JOIN iam.permission op ON op.id = rp.permission_id AND op.key = 'performance.sync_run.run'
  JOIN iam.permission np ON np.key IN ('performance.fdb_check.run', 'performance.fdb_check.review')
 WHERE rp.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING;
