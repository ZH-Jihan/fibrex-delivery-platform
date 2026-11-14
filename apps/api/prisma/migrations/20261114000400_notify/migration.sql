-- =============================================================================
-- Migration: notify schema (Phase 1, commit 9)
--
-- Tables from docs/phases/phase-01-plan.md section 3. Conventions as in the platform_iam
-- migration (T = 'tenant', A = 'tenant_append', G = 'global_catalog').
--
-- Design notes:
--   * notification and notification_delivery are insert-only and monthly partitioned. A
--     notification is a fact (this was sent to this user); who read it, and what happened
--     to each delivery attempt, are further insert-only rows, never updates.
--   * Reading is recorded in notify.notification_read (one row per user and notification).
--     Unread = no row. This keeps the big partitioned table immutable.
--   * Rules store a short Handlebars title/body with merge fields (Phase 1 simplification;
--     Phase 2 adds template_key, additively).
-- =============================================================================

CREATE SCHEMA notify;
GRANT USAGE ON SCHEMA notify TO fibrex_app;

-- Event types that modules register at start-up (like the permission catalogue).
CREATE TABLE notify.event_type (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  key          text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module_key   text        NOT NULL,
  label        text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer     NOT NULL DEFAULT 1
);
SELECT app.setup_table('notify', 'event_type', 'global_catalog');

-- When <event_type> happens, tell <recipients> through <channels> with this text.
-- recipients: {"userIds": [uuid], "roleKeys": [text], "payloadUserFields": [text]}
CREATE TABLE notify.notification_rule (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid,
  name            text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  event_type_key  text        NOT NULL,
  channels        text[]      NOT NULL DEFAULT '{in_app}'
                  CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['in_app', 'email']),
  recipients      jsonb       NOT NULL DEFAULT '{}',
  title_template  text        NOT NULL CHECK (length(title_template) BETWEEN 1 AND 500),
  body_template   text        NOT NULL DEFAULT '' CHECK (length(body_template) <= 5000),
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT notification_rule_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT notification_rule_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id)
);
CREATE INDEX notification_rule_event_idx ON notify.notification_rule (tenant_id, event_type_key)
  WHERE deleted_at IS NULL AND is_active;
SELECT app.setup_table('notify', 'notification_rule', 'tenant');

CREATE TABLE notify.notification (
  id              uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid,
  user_id         uuid        NOT NULL,
  event_type_key  text        NOT NULL,
  rule_id         uuid,
  title           text        NOT NULL,
  body            text        NOT NULL DEFAULT '',
  data            jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX notification_user_idx ON notify.notification (tenant_id, user_id, created_at DESC);
SELECT app.setup_table('notify', 'notification', 'tenant_append');
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('notify.notification'::regclass, '2026-11-01', 3);

-- Read marks: one row when a user reads a notification. Insert-only.
CREATE TABLE notify.notification_read (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  notification_id  uuid        NOT NULL,
  read_at          timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT notification_read_uq UNIQUE (user_id, notification_id)
);
SELECT app.setup_table('notify', 'notification_read', 'tenant_append');

-- Every step of a delivery (queued, sent, failed) is its own row; the latest row per
-- (notification_id, channel) is the current state.
CREATE TABLE notify.notification_delivery (
  id               uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  notification_id  uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  channel          text        NOT NULL CHECK (channel IN ('in_app', 'email')),
  status           text        NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempt          integer     NOT NULL DEFAULT 1,
  address          text,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX notification_delivery_n_idx ON notify.notification_delivery (tenant_id, notification_id);
SELECT app.setup_table('notify', 'notification_delivery', 'tenant_append');
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('notify.notification_delivery'::regclass, '2026-11-01', 3);

-- A user's choice per event type ('*' = every event) and channel.
CREATE TABLE notify.notification_preference (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  event_type_key  text        NOT NULL DEFAULT '*',
  channel         text        NOT NULL CHECK (channel IN ('in_app', 'email')),
  enabled         boolean     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT notification_preference_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT notification_preference_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE UNIQUE INDEX notification_preference_uq
  ON notify.notification_preference (user_id, event_type_key, channel)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('notify', 'notification_preference', 'tenant');

SELECT app.maintain_partitions();
