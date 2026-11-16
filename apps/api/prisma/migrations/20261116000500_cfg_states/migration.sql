-- =============================================================================
-- Migration: state machines (Phase 2, row 2.10)
--
-- PLAN 3.7 `state_machine` (S), `state` (S), `state_transition` (S), `state_history` (A);
-- SPEC 2.10 "State machines". The statuses a record can have and the moves between them
-- are data an administrator edits, not code.
--
-- Design notes:
--   * A machine is tenant-wide and belongs to one entity type (`entity_key`): the key of a
--     custom record type (`vehicle_request`) or a built-in type (`party.party`). One live
--     machine per entity type; that is how the machine of a record is found.
--   * A state has a code that never changes (records and history hold it), labels, a
--     category for reports (open, active, closed), and may be the one initial state or a
--     final state (no move leaves a final state; the API enforces it).
--   * A transition is one allowed move from one state to another, with the permission it
--     needs (empty = the entity's own update permission), the fields that must be filled
--     in first, and whether a reason is needed (from a lookup list, or a note).
--     `workflow_definition_id` has no foreign key yet: workflows arrive in row 2.11.
--   * `state_history` is insert-only: every move with its effective date (the day it
--     counts from, which may be earlier than the day it was keyed), reason, note and who
--     did it. `from_code` is NULL for the row written when a record gets its first state.
-- =============================================================================

CREATE TABLE cfg.state_machine (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  entity_key    text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description   text        CHECK (length(description) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT state_machine_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT state_machine_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT state_machine_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX state_machine_entity_uq ON cfg.state_machine (tenant_id, entity_key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'state_machine', 'tenant');

CREATE TABLE cfg.state (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  state_machine_id uuid        NOT NULL,
  code             text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,49}$'),
  labels           jsonb       NOT NULL CHECK (jsonb_typeof(labels) = 'object' AND labels ? 'en'),
  category         text        NOT NULL DEFAULT 'open' CHECK (category IN ('open', 'active', 'closed')),
  is_initial       boolean     NOT NULL DEFAULT false,
  is_final         boolean     NOT NULL DEFAULT false,
  colour           text        CHECK (colour ~ '^#[0-9a-f]{6}$'),
  sort_order       integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT state_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT state_initial_final_ck CHECK (NOT (is_initial AND is_final)),
  CONSTRAINT state_machine_fk FOREIGN KEY (tenant_id, state_machine_id) REFERENCES cfg.state_machine (tenant_id, id),
  CONSTRAINT state_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX state_code_uq ON cfg.state (state_machine_id, code) WHERE deleted_at IS NULL;
-- A record starts in exactly one place.
CREATE UNIQUE INDEX state_initial_uq ON cfg.state (state_machine_id) WHERE is_initial AND deleted_at IS NULL;
SELECT app.setup_table('cfg', 'state', 'tenant');

CREATE TABLE cfg.state_transition (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  state_machine_id       uuid        NOT NULL,
  from_code              text        NOT NULL CHECK (from_code ~ '^[a-z][a-z0-9_]{0,49}$'),
  to_code                text        NOT NULL CHECK (to_code ~ '^[a-z][a-z0-9_]{0,49}$'),
  permission_key         text        CHECK (permission_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  required_fields        text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(required_fields) <= 50),
  reason_lookup_type_id  uuid,
  reason_required        boolean     NOT NULL DEFAULT false,
  workflow_definition_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT state_transition_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT state_transition_moves_ck CHECK (from_code <> to_code),
  CONSTRAINT state_transition_machine_fk FOREIGN KEY (tenant_id, state_machine_id) REFERENCES cfg.state_machine (tenant_id, id),
  CONSTRAINT state_transition_reason_list_fk FOREIGN KEY (tenant_id, reason_lookup_type_id) REFERENCES cfg.lookup_type (tenant_id, id),
  CONSTRAINT state_transition_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX state_transition_move_uq ON cfg.state_transition (state_machine_id, from_code, to_code) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'state_transition', 'tenant');

CREATE TABLE cfg.state_history (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  entity_type    text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  entity_id      uuid        NOT NULL,
  from_code      text,
  to_code        text        NOT NULL,
  effective_date date        NOT NULL DEFAULT CURRENT_DATE,
  reason_id      uuid,
  note           text        CHECK (length(note) <= 2000),
  actor_id       uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT state_history_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT state_history_reason_fk FOREIGN KEY (tenant_id, reason_id) REFERENCES cfg.lookup_value (tenant_id, id)
);
CREATE INDEX state_history_entity_idx ON cfg.state_history (company_id, entity_type, entity_id, id);
SELECT app.setup_table('cfg', 'state_history', 'company_append');
