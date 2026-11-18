-- =============================================================================
-- Migration: event outbox and webhooks (Phase 2, row 2.12)
--
-- PLAN 3.8 `outbox_event`, `event_consumption`, `webhook_subscription`, `webhook_delivery`.
--
-- How events flow (kernel/events):
--   1. A service writes its event to integration.outbox_event in the SAME transaction as
--      the change (EventOutbox.record). A rolled-back change therefore never announces
--      anything, and a committed change always does.
--   2. The relay (a recurring job, and a nudge after each commit) lists events no relay
--      has handed on yet through integration.outbox_pending(), queues one BullMQ job per
--      consumer, and records the hand-over as an event_consumption row with the consumer
--      key 'outbox.relay'.
--   3. Each consumer (notifications, webhooks) inserts its own event_consumption row in the
--      transaction that does its work; the unique (consumer_key, event_id) makes a second
--      delivery of the same job a no-op.
--
-- Differences from PLAN 3.8 (recorded in DECISIONS):
--   * outbox_event has no `published_at` / `attempts` columns. The table is insert-only
--     (tag A), and those columns would need UPDATE. "Published" is the relay's
--     event_consumption row; retries are counted by BullMQ and by webhook_delivery rows.
--   * company_id of an event is optional (tenant-level events such as a user change). The
--     policy therefore lets a caller see tenant-level events and the events of their own
--     companies, not every company of the tenant.
--   * webhook_delivery has `status`, `manual` and `company_id`; one row per attempt.
-- =============================================================================

CREATE TABLE integration.outbox_event (
  id              uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid,
  event_type_key  text        NOT NULL CHECK (event_type_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  event_version   integer     NOT NULL DEFAULT 1 CHECK (event_version >= 1),
  aggregate_type  text        NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  aggregate_id    uuid,
  payload         jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX outbox_event_tenant_idx ON integration.outbox_event (tenant_id, occurred_at DESC);
CREATE INDEX outbox_event_type_idx ON integration.outbox_event (tenant_id, event_type_key, occurred_at DESC);
SELECT app.setup_table('integration', 'outbox_event', 'tenant_append');
-- Replace the tenant-wide policy: tenant-level events, or events of the caller's companies.
DROP POLICY tenant_isolation ON integration.outbox_event;
CREATE POLICY tenant_company_isolation ON integration.outbox_event
  USING (tenant_id = app.current_tenant_id()
         AND (company_id IS NULL OR company_id = ANY (app.current_company_ids())))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (company_id IS NULL OR company_id = ANY (app.current_company_ids())));
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('integration.outbox_event'::regclass, '2026-11-01', 3);

-- One row per (consumer, event) that has been handled. Insert-only.
CREATE TABLE integration.event_consumption (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  consumer_key  text        NOT NULL CHECK (consumer_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  event_id      uuid        NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT event_consumption_uq UNIQUE (consumer_key, event_id)
);
SELECT app.setup_table('integration', 'event_consumption', 'tenant_append');

CREATE TABLE integration.webhook_subscription (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  name             text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  url              text        NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 2000),
  -- AES-256-GCM under DATA_ENCRYPTION_KEY (kernel/crypto/secret-box), context
  -- 'webhook_subscription:<id>'. Shown once when created or rotated.
  secret_encrypted bytea       NOT NULL,
  -- Event type keys, or '*' for every event.
  event_type_keys  text[]      NOT NULL CHECK (cardinality(event_type_keys) BETWEEN 1 AND 100),
  active           boolean     NOT NULL DEFAULT true,
  api_client_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT webhook_subscription_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT webhook_subscription_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT webhook_subscription_api_client_fk FOREIGN KEY (company_id, api_client_id) REFERENCES iam.api_client (company_id, id)
);
CREATE INDEX webhook_subscription_company_idx ON integration.webhook_subscription (company_id)
  WHERE deleted_at IS NULL AND active;
SELECT app.setup_table('integration', 'webhook_subscription', 'company');

-- One row per delivery attempt. The latest row of (subscription, event) is the outcome.
CREATE TABLE integration.webhook_delivery (
  id              uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid        NOT NULL,
  subscription_id uuid        NOT NULL,
  event_id        uuid        NOT NULL,
  event_type_key  text        NOT NULL,
  attempt         integer     NOT NULL CHECK (attempt >= 1),
  status          text        NOT NULL CHECK (status IN ('succeeded', 'failed')),
  status_code     integer,
  response_ms     integer     CHECK (response_ms >= 0),
  error           text        CHECK (length(error) <= 2000),
  next_retry_at   timestamptz,
  manual          boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX webhook_delivery_subscription_idx
  ON integration.webhook_delivery (company_id, subscription_id, created_at DESC);
CREATE INDEX webhook_delivery_event_idx ON integration.webhook_delivery (event_id);
SELECT app.setup_table('integration', 'webhook_delivery', 'company_append');
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('integration.webhook_delivery'::regclass, '2026-11-01', 3);

-- The relay serves every tenant and must find events not handed on yet before it can open
-- a unit of work per tenant. Returns ids only, never payloads. Events older than seven
-- days are left alone (an outage that long needs a person, not a silent replay).
CREATE FUNCTION integration.outbox_pending(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, company_id uuid, occurred_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT e.id, e.tenant_id, e.company_id, e.occurred_at
    FROM integration.outbox_event e
   WHERE e.occurred_at > now() - interval '7 days'
     AND NOT EXISTS (SELECT 1
                       FROM integration.event_consumption c
                      WHERE c.consumer_key = 'outbox.relay' AND c.event_id = e.id)
   ORDER BY e.occurred_at, e.id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION integration.outbox_pending(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.outbox_pending(integer) TO fibrex_app;

SELECT app.maintain_partitions();
