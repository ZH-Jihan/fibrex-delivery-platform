-- =============================================================================
-- Migration: cfg schema, lookups (Phase 2, row 2.3)
--
-- PLAN 3.7 `lookup_type` and `lookup_value`: the dropdown lists the business may change
-- without a release (vehicle types, loan purposes, payment methods ...). Both tables are
-- tenant-wide (kind S, scope 'tenant'): every company of the tenant shares the lists.
--
-- Design notes:
--   * A value is never deleted by the app; "active = false" hides it from new dropdowns while
--     old records keep showing it. Soft delete (recycle bin) is for mistakes.
--   * labels is a JSONB object keyed by language ({"en": "Motorbike", "bn": "..."}); the API
--     requires at least "en" and falls back to the code when a language is missing.
--   * parent_id builds a tree only when the type has allow_hierarchy (checked in the API,
--     together with "same type" and "no cycle").
--   * Composite foreign keys (tenant_id, id) keep every reference inside one tenant.
-- =============================================================================

CREATE SCHEMA cfg;
GRANT USAGE ON SCHEMA cfg TO fibrex_app;

CREATE TABLE cfg.lookup_type (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  key              text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  is_system        boolean     NOT NULL DEFAULT false,
  allow_hierarchy  boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT lookup_type_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT lookup_type_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT lookup_type_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX lookup_type_key_uq ON cfg.lookup_type (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'lookup_type', 'tenant');

CREATE TABLE cfg.lookup_value (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  lookup_type_id  uuid        NOT NULL,
  code            text        NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$'),
  labels          jsonb       NOT NULL CHECK (jsonb_typeof(labels) = 'object'),
  parent_id       uuid,
  sort_order      integer     NOT NULL DEFAULT 0,
  active          boolean     NOT NULL DEFAULT true,
  meta            jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT lookup_value_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT lookup_value_type_fk FOREIGN KEY (tenant_id, lookup_type_id) REFERENCES cfg.lookup_type (tenant_id, id),
  CONSTRAINT lookup_value_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES cfg.lookup_value (tenant_id, id),
  CONSTRAINT lookup_value_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT lookup_value_not_own_parent_ck CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX lookup_value_code_uq ON cfg.lookup_value (lookup_type_id, code) WHERE deleted_at IS NULL;
CREATE INDEX lookup_value_list_idx ON cfg.lookup_value (lookup_type_id, sort_order) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'lookup_value', 'tenant');
