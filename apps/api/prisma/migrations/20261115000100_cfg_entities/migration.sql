-- =============================================================================
-- Migration: cfg schema, entity and field definitions (Phase 2, row 2.4)
--
-- PLAN 3.7 `entity_definition` and `field_definition`: the record types an administrator
-- defines without a release (SPEC 2.10 entity and form builder), and the custom fields added
-- to built-in record types. All three tables are tenant-wide (every company of the tenant
-- shares the record types).
--
-- Design notes:
--   * Draft and publish: edits to a definition or its fields change nothing for users until
--     "publish". Publishing generates the JSON Schema, raises `published_version` by one and
--     writes a frozen copy to `entity_definition_version`. Records (row 2.5) are validated
--     against the published schema only.
--   * `version` is the standard optimistic-lock counter of the row. The definition version
--     PLAN 3.7 lists is therefore the column `published_version` (0 = never published).
--   * A key with a dot (`party.party`) is a built-in ("system") record type registered by a
--     module; a key without a dot is a custom type. The CHECK ties `kind` to that shape.
--   * `state_machine_id` has no foreign key yet: `cfg.state_machine` arrives in row 2.10,
--     which adds the constraint (additive).
--   * A field's key, type, lookup list and referenced entity never change (the API refuses
--     it): stored record data is keyed by the field key and typed by the field type.
--   * `promoted_column` is written only by a hand-written migration (docs/PROMOTING_A_FIELD.md).
--   * Composite foreign keys (tenant_id, id) keep every reference inside one tenant.
-- =============================================================================

CREATE TABLE cfg.entity_definition (
  id                       uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                uuid        NOT NULL,
  key                      text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  name                     jsonb       NOT NULL CHECK (jsonb_typeof(name) = 'object'),
  kind                     text        NOT NULL DEFAULT 'custom' CHECK (kind IN ('system', 'custom')),
  json_schema              jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(json_schema) = 'object'),
  list_config              jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(list_config) = 'object'),
  form_layout              jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(form_layout) = 'object'),
  detail_layout            jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail_layout) = 'object'),
  numbering_key            text        CHECK (numbering_key ~ '^[a-z][a-z0-9_]{0,49}$'),
  state_machine_id         uuid,
  permission_module_key    text        NOT NULL CHECK (permission_module_key ~ '^[a-z][a-z0-9_]*$'),
  status                   text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_version        integer     NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  published_at             timestamptz,
  has_unpublished_changes  boolean     NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid,
  version                  integer     NOT NULL DEFAULT 1,
  deleted_at               timestamptz,
  deleted_by               uuid,
  delete_reason            text,
  CONSTRAINT entity_definition_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT entity_definition_published_ck CHECK ((status = 'published') = (published_version > 0)),
  CONSTRAINT entity_definition_kind_key_ck CHECK ((kind = 'system') = (position('.' in key) > 0)),
  CONSTRAINT entity_definition_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT entity_definition_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX entity_definition_key_uq ON cfg.entity_definition (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'entity_definition', 'tenant');

CREATE TABLE cfg.field_definition (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL,
  entity_definition_id  uuid        NOT NULL,
  key                   text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  label                 jsonb       NOT NULL CHECK (jsonb_typeof(label) = 'object'),
  type                  text        NOT NULL CHECK (type IN ('text', 'number', 'decimal', 'date', 'dropdown', 'multi', 'file', 'party_ref', 'entity_ref', 'boolean')),
  validations           jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(validations) = 'object'),
  lookup_type_id        uuid,
  ref_entity_key        text,
  required              boolean     NOT NULL DEFAULT false,
  sort_order            integer     NOT NULL DEFAULT 0,
  promoted_column       text        CHECK (promoted_column ~ '^[a-z][a-z0-9_]{0,62}$'),
  status                text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  delete_reason         text,
  CONSTRAINT field_definition_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- A dropdown or multi-select always names its list; no other type may.
  CONSTRAINT field_definition_lookup_ck CHECK ((type IN ('dropdown', 'multi')) = (lookup_type_id IS NOT NULL)),
  -- A reference to another record type always names it; no other type may.
  CONSTRAINT field_definition_ref_ck CHECK ((type = 'entity_ref') = (ref_entity_key IS NOT NULL)),
  CONSTRAINT field_definition_entity_fk FOREIGN KEY (tenant_id, entity_definition_id) REFERENCES cfg.entity_definition (tenant_id, id),
  CONSTRAINT field_definition_lookup_fk FOREIGN KEY (tenant_id, lookup_type_id) REFERENCES cfg.lookup_type (tenant_id, id),
  CONSTRAINT field_definition_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX field_definition_key_uq ON cfg.field_definition (entity_definition_id, key) WHERE deleted_at IS NULL;
CREATE INDEX field_definition_list_idx ON cfg.field_definition (entity_definition_id, sort_order) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'field_definition', 'tenant');

-- One frozen copy per publish. Insert-only: a published version is never edited, so any
-- record can be read back with the definition it was saved under.
CREATE TABLE cfg.entity_definition_version (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL,
  entity_definition_id  uuid        NOT NULL,
  version_no            integer     NOT NULL CHECK (version_no > 0),
  definition            jsonb       NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  json_schema           jsonb       NOT NULL CHECK (jsonb_typeof(json_schema) = 'object'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  CONSTRAINT entity_definition_version_entity_fk FOREIGN KEY (tenant_id, entity_definition_id) REFERENCES cfg.entity_definition (tenant_id, id),
  CONSTRAINT entity_definition_version_uq UNIQUE (entity_definition_id, version_no)
);
SELECT app.setup_table('cfg', 'entity_definition_version', 'tenant_append');
