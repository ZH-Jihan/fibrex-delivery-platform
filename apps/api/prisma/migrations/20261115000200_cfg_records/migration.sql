-- =============================================================================
-- Migration: custom records and record links (Phase 2, row 2.5)
--
-- PLAN 3.7 `custom_record` (S+B) and `record_link` (S): the records of the record types an
-- administrator defines (row 2.4), and relations from such a record to any other record.
-- Both tables belong to a company (unlike the definitions, which the whole tenant shares).
--
-- Design notes:
--   * `data` holds the field values keyed by field key. It is validated by the API against
--     the published definition; `definition_version` is the version it was last saved under,
--     so a record can always be read back with the definition that judged it.
--   * `number` comes from the numbering service when the record type has a numbering key,
--     otherwise it is NULL. The unique index has no `deleted_at` condition on purpose: a
--     number is never reused, not even after its record was deleted (PLAN 2.1).
--   * The GIN index uses `jsonb_path_ops`: list filters are containment tests
--     (`data @> '{"colour": "red"}'`), which is the one operator that index class serves,
--     with a smaller and faster index than the default class.
--   * `state_code` stays NULL until state machines arrive (row 2.10).
--   * `record_link` names both ends by entity key: a custom type's key (`vehicle_inspection`)
--     or a built-in type's key (`party.party`). There is no foreign key on the ids because
--     the target lives in whichever table its type says; the API checks that it exists.
--   * Composite foreign keys keep every reference inside one tenant and one company.
-- =============================================================================

CREATE TABLE cfg.custom_record (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL,
  company_id            uuid        NOT NULL,
  branch_id             uuid,
  entity_definition_id  uuid        NOT NULL,
  definition_version    integer     NOT NULL CHECK (definition_version > 0),
  number                text        CHECK (length(number) BETWEEN 1 AND 100),
  data                  jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  state_code            text        CHECK (state_code ~ '^[a-z][a-z0-9_]{0,49}$'),
  party_id              uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  delete_reason         text,
  CONSTRAINT custom_record_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT custom_record_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT custom_record_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES platform.branch (company_id, id),
  CONSTRAINT custom_record_entity_fk FOREIGN KEY (tenant_id, entity_definition_id) REFERENCES cfg.entity_definition (tenant_id, id),
  CONSTRAINT custom_record_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT custom_record_company_id_uq UNIQUE (company_id, id)
);
-- NULL numbers (types without numbering) do not collide: NULLs are distinct in a unique index.
CREATE UNIQUE INDEX custom_record_number_uq ON cfg.custom_record (company_id, entity_definition_id, number);
CREATE INDEX custom_record_list_idx ON cfg.custom_record (company_id, entity_definition_id, id) WHERE deleted_at IS NULL;
CREATE INDEX custom_record_data_idx ON cfg.custom_record USING gin (data jsonb_path_ops);
CREATE INDEX custom_record_party_idx ON cfg.custom_record (company_id, party_id);
SELECT app.setup_table('cfg', 'custom_record', 'company');

CREATE TABLE cfg.record_link (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  company_id        uuid        NOT NULL,
  from_entity_type  text        NOT NULL CHECK (from_entity_type ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  from_id           uuid        NOT NULL,
  to_entity_type    text        NOT NULL CHECK (to_entity_type ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  to_id             uuid        NOT NULL,
  relation_key      text        NOT NULL CHECK (relation_key ~ '^[a-z][a-z0-9_]{0,49}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT record_link_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- A record is not related to itself.
  CONSTRAINT record_link_not_self_ck CHECK (from_entity_type <> to_entity_type OR from_id <> to_id),
  CONSTRAINT record_link_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
CREATE UNIQUE INDEX record_link_uq ON cfg.record_link (company_id, from_entity_type, from_id, relation_key, to_entity_type, to_id) WHERE deleted_at IS NULL;
CREATE INDEX record_link_to_idx ON cfg.record_link (company_id, to_entity_type, to_id);
SELECT app.setup_table('cfg', 'record_link', 'company');
