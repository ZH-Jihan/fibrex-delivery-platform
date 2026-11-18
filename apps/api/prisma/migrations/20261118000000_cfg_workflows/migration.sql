-- =============================================================================
-- Migration: workflow engine (Phase 2, row 2.11a)
--
-- PLAN 3.7 `workflow_definition`, `workflow_version`, `workflow_step`, `workflow_binding`,
-- `workflow_instance`, `workflow_task`, `workflow_delegation`; PLAN 5.9 "Workflow";
-- SPEC 2.10. Who approves what, in which order, and when, is data an administrator edits.
--
-- Design notes:
--   * A definition (tenant-wide) has numbered versions. A version is a draft until it is
--     published; publishing freezes its graph, writes one `workflow_step` row per step and
--     retires the version published before. A running instance keeps the version it
--     started on, so changing a workflow never changes one already under way.
--   * Steps: approval, parallel_group (approval branches open together), condition (a
--     boolean formula of the formula engine; never an inline expression), notify (an event
--     for the notification rules) and task (reserved, not built yet). Conditions name a
--     formula key, not a version: the version in force on the day is used and recorded in
--     the instance's event log (`workflow_event.detail`).
--   * A binding attaches a definition to an entity type: on create, on a move into a
--     state (`to_state_code`) or manual start; optionally only when a boolean formula is
--     true. `state_transition.workflow_definition_id` (row 2.10) now points here too.
--   * An instance and its tasks belong to the company of the record. Only one instance of
--     a definition runs for one record at a time.
--   * A task belongs to a user or to a role (anyone holding the role in that company may
--     act). `activation_no` separates the rounds of a step that was sent back and opened
--     again; `reminder_at`/`due_at` come from the step's SLA hours and drive the SLA job.
--   * `workflow_event` is insert-only: the timeline of an instance (started, steps,
--     condition results, approvals, comments, delegation, reminders, escalation, end).
--     PLAN 3.7 has no such table; it is added so the timeline is never rebuilt from
--     mutable rows.
--   * `cfg.workflow_sla_due()` is SECURITY DEFINER: the SLA job serves every tenant and
--     must find which (tenant, company) pairs have reminders or escalations due before it
--     can open a unit of work for each. It returns ids only, never task contents.
-- =============================================================================

CREATE TABLE cfg.workflow_definition (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description   text        CHECK (length(description) <= 2000),
  entity_key    text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT workflow_definition_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_definition_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT workflow_definition_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX workflow_definition_key_uq ON cfg.workflow_definition (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'workflow_definition', 'tenant');

CREATE TABLE cfg.workflow_version (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  workflow_definition_id uuid        NOT NULL,
  version_no             integer     NOT NULL CHECK (version_no >= 1),
  graph                  jsonb       NOT NULL CHECK (jsonb_typeof(graph) = 'object'),
  status                 text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at           timestamptz,
  published_by           uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT workflow_version_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_version_published_ck CHECK ((status = 'draft') = (published_at IS NULL)),
  CONSTRAINT workflow_version_definition_fk FOREIGN KEY (tenant_id, workflow_definition_id) REFERENCES cfg.workflow_definition (tenant_id, id),
  CONSTRAINT workflow_version_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX workflow_version_no_uq ON cfg.workflow_version (workflow_definition_id, version_no) WHERE deleted_at IS NULL;
-- One version in force per definition.
CREATE UNIQUE INDEX workflow_version_published_uq ON cfg.workflow_version (workflow_definition_id) WHERE status = 'published' AND deleted_at IS NULL;
SELECT app.setup_table('cfg', 'workflow_version', 'tenant');

CREATE TABLE cfg.workflow_step (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL,
  workflow_version_id   uuid        NOT NULL,
  key                   text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'),
  parent_key            text        CHECK (parent_key ~ '^[a-z][a-z0-9_]{0,49}$'),
  kind                  text        NOT NULL CHECK (kind IN ('approval', 'parallel_group', 'condition', 'notify', 'task')),
  name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  assignee_rule         jsonb,
  quorum                text        CHECK (quorum IN ('any', 'all')),
  condition_formula_key text        CHECK (condition_formula_key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  on_false_step_key     text,
  event_type_key        text,
  sla_hours             integer     CHECK (sla_hours BETWEEN 1 AND 8760),
  reminder_hours        integer     CHECK (reminder_hours BETWEEN 1 AND 8760),
  escalate_to           jsonb,
  allow_self_approval   boolean     NOT NULL DEFAULT false,
  order_no              integer     NOT NULL CHECK (order_no >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  delete_reason         text,
  CONSTRAINT workflow_step_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_step_version_fk FOREIGN KEY (tenant_id, workflow_version_id) REFERENCES cfg.workflow_version (tenant_id, id),
  CONSTRAINT workflow_step_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX workflow_step_key_uq ON cfg.workflow_step (workflow_version_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'workflow_step', 'tenant');

CREATE TABLE cfg.workflow_binding (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  entity_key             text        NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  trigger                text        NOT NULL CHECK (trigger IN ('on_create', 'on_transition', 'manual')),
  to_state_code          text        CHECK (to_state_code ~ '^[a-z][a-z0-9_]{0,49}$'),
  workflow_definition_id uuid        NOT NULL,
  condition_formula_key  text        CHECK (condition_formula_key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  active                 boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT workflow_binding_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_binding_state_ck CHECK ((trigger = 'on_transition') = (to_state_code IS NOT NULL)),
  CONSTRAINT workflow_binding_definition_fk FOREIGN KEY (tenant_id, workflow_definition_id) REFERENCES cfg.workflow_definition (tenant_id, id),
  CONSTRAINT workflow_binding_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX workflow_binding_entity_idx ON cfg.workflow_binding (tenant_id, entity_key, trigger) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'workflow_binding', 'tenant');

-- Row 2.10 left this column without a key; it now names a workflow started by the move.
ALTER TABLE cfg.state_transition
  ADD CONSTRAINT state_transition_workflow_fk FOREIGN KEY (tenant_id, workflow_definition_id)
  REFERENCES cfg.workflow_definition (tenant_id, id);

CREATE TABLE cfg.workflow_instance (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  company_id             uuid        NOT NULL,
  workflow_definition_id uuid        NOT NULL,
  workflow_version_id    uuid        NOT NULL,
  entity_type            text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  entity_id              uuid        NOT NULL,
  trigger                text        NOT NULL CHECK (trigger IN ('on_create', 'on_transition', 'manual')),
  status                 text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'approved', 'rejected', 'cancelled')),
  started_by             uuid,
  current_step_keys      text[]      NOT NULL DEFAULT '{}',
  step_index             integer     NOT NULL DEFAULT 0 CHECK (step_index >= 0),
  activation_no          integer     NOT NULL DEFAULT 0 CHECK (activation_no >= 0),
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT workflow_instance_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_instance_completed_ck CHECK ((status = 'running') = (completed_at IS NULL)),
  CONSTRAINT workflow_instance_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT workflow_instance_definition_fk FOREIGN KEY (tenant_id, workflow_definition_id) REFERENCES cfg.workflow_definition (tenant_id, id),
  CONSTRAINT workflow_instance_version_fk FOREIGN KEY (tenant_id, workflow_version_id) REFERENCES cfg.workflow_version (tenant_id, id),
  CONSTRAINT workflow_instance_starter_fk FOREIGN KEY (tenant_id, started_by) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT workflow_instance_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX workflow_instance_running_uq ON cfg.workflow_instance (workflow_definition_id, entity_type, entity_id) WHERE status = 'running' AND deleted_at IS NULL;
CREATE INDEX workflow_instance_entity_idx ON cfg.workflow_instance (company_id, entity_type, entity_id);
SELECT app.setup_table('cfg', 'workflow_instance', 'company');

CREATE TABLE cfg.workflow_task (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  company_id             uuid        NOT NULL,
  instance_id            uuid        NOT NULL,
  step_key               text        NOT NULL,
  activation_no          integer     NOT NULL CHECK (activation_no >= 1),
  assignee_user_id       uuid,
  assignee_role_id       uuid,
  status                 text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'skipped', 'expired')),
  due_at                 timestamptz,
  reminder_at            timestamptz,
  reminded_at            timestamptz,
  escalated_at           timestamptz,
  escalated_from_task_id uuid,
  acted_by               uuid,
  acted_at               timestamptz,
  action                 text        CHECK (action IN ('approve', 'reject', 'send_back')),
  comment                text        CHECK (length(comment) <= 4000),
  delegated_from_user_id uuid,
  payload                jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT workflow_task_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_task_assignee_ck CHECK ((assignee_user_id IS NULL) <> (assignee_role_id IS NULL)),
  CONSTRAINT workflow_task_done_ck CHECK ((status = 'done') = (action IS NOT NULL)),
  CONSTRAINT workflow_task_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT workflow_task_instance_fk FOREIGN KEY (tenant_id, instance_id) REFERENCES cfg.workflow_instance (tenant_id, id),
  CONSTRAINT workflow_task_user_fk FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT workflow_task_role_fk FOREIGN KEY (tenant_id, assignee_role_id) REFERENCES iam.role (tenant_id, id),
  CONSTRAINT workflow_task_delegated_fk FOREIGN KEY (tenant_id, delegated_from_user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT workflow_task_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX workflow_task_instance_idx ON cfg.workflow_task (instance_id, step_key, activation_no);
CREATE INDEX workflow_task_user_open_idx ON cfg.workflow_task (assignee_user_id) WHERE status = 'open';
CREATE INDEX workflow_task_role_open_idx ON cfg.workflow_task (assignee_role_id) WHERE status = 'open';
CREATE INDEX workflow_task_sla_idx ON cfg.workflow_task (tenant_id, company_id) WHERE status = 'open' AND (reminder_at IS NOT NULL OR due_at IS NOT NULL);
SELECT app.setup_table('cfg', 'workflow_task', 'company');

CREATE TABLE cfg.workflow_event (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL,
  company_id  uuid        NOT NULL,
  instance_id uuid        NOT NULL,
  task_id     uuid,
  kind        text        NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  step_key    text,
  actor_id    uuid,
  detail      jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT workflow_event_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT workflow_event_instance_fk FOREIGN KEY (tenant_id, instance_id) REFERENCES cfg.workflow_instance (tenant_id, id)
);
CREATE INDEX workflow_event_instance_idx ON cfg.workflow_event (instance_id, id);
SELECT app.setup_table('cfg', 'workflow_event', 'company_append');

CREATE TABLE cfg.workflow_delegation (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  delegate_user_id uuid        NOT NULL,
  valid_from       date        NOT NULL,
  valid_to         date        NOT NULL,
  scope            jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(scope) = 'object'),
  note             text        CHECK (length(note) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT workflow_delegation_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT workflow_delegation_people_ck CHECK (user_id <> delegate_user_id),
  CONSTRAINT workflow_delegation_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT workflow_delegation_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT workflow_delegation_delegate_fk FOREIGN KEY (tenant_id, delegate_user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT workflow_delegation_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX workflow_delegation_user_idx ON cfg.workflow_delegation (tenant_id, user_id, valid_from) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'workflow_delegation', 'tenant');

-- The SLA job's one door across tenants: which (tenant, company) pairs have a reminder or
-- an escalation due. Ids only; the job then works under row-level security per pair.
CREATE FUNCTION cfg.workflow_sla_due() RETURNS TABLE (tenant_id uuid, company_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT t.tenant_id, t.company_id
    FROM cfg.workflow_task t
   WHERE t.status = 'open'
     AND t.deleted_at IS NULL
     AND ((t.reminder_at <= now() AND t.reminded_at IS NULL)
       OR (t.due_at <= now() AND t.escalated_at IS NULL))
$$;

REVOKE ALL ON FUNCTION cfg.workflow_sla_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cfg.workflow_sla_due() TO fibrex_app;
