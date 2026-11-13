-- =============================================================================
-- Migration: platform and iam schemas (Phase 1, commit 3)
--
-- Tables from docs/PLAN.md sections 3.1 (platform) and 3.2 (iam). Column conventions
-- (docs/PLAN.md section 2.1):
--   * S (kind 'company'): id, tenant_id, company_id, created_*, updated_*, version, deleted_*
--   * T (kind 'tenant') : the same without company_id
--   * A (kind '*_append'): id, tenant_id, [company_id], created_at, created_by; insert-only
--   * G (kind 'global*'): no tenant
-- Audit columns (created_by, updated_by, deleted_by) hold user ids without a foreign key:
-- system jobs write NULL, and a foreign key from every table to user_account would make
-- the user table impossible to partition or archive later.
--
-- Soft delete: deleted_at and delete_reason are set together (CHECK). Unique keys are
-- partial (WHERE deleted_at IS NULL) so a deleted code can be reused.
--
-- Effective dating: valid_to is INCLUSIVE (the last day the row applies; NULL = open).
-- Overlaps are blocked by GiST exclusion constraints on daterange(valid_from, valid_to, '[]').
--
-- Login names and e-mail addresses are stored in lower case (CHECK), so plain unique
-- indexes are case-insensitive without the citext extension.
-- =============================================================================

CREATE SCHEMA platform;
CREATE SCHEMA iam;
GRANT USAGE ON SCHEMA platform, iam TO fibrex_app;

-- =============================================================================
-- platform
-- =============================================================================

CREATE TABLE platform.currency (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  code         char(3)     NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3}$'),
  name         text        NOT NULL,
  minor_units  smallint    NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4),
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer     NOT NULL DEFAULT 1
);
SELECT app.setup_table('platform', 'currency', 'global');

-- Root of everything. Not tenant-scoped itself; RLS lets a session see only its own tenant.
CREATE TABLE platform.tenant (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  name                   text        NOT NULL,
  slug                   text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  data_residency_region  text,
  onboarded_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT tenant_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL))
);
CREATE UNIQUE INDEX tenant_slug_uq ON platform.tenant (slug) WHERE deleted_at IS NULL;
CREATE TRIGGER a_row_stamp BEFORE INSERT OR UPDATE ON platform.tenant
  FOR EACH ROW EXECUTE FUNCTION app.tg_row_stamp();
REVOKE ALL ON platform.tenant FROM PUBLIC;
GRANT SELECT, UPDATE ON platform.tenant TO fibrex_app;
ALTER TABLE platform.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON platform.tenant
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());

CREATE TABLE platform.subscription_plan (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  code        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  limits      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     integer     NOT NULL DEFAULT 1
);
SELECT app.setup_table('platform', 'subscription_plan', 'global');

CREATE TABLE platform.tenant_subscription (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id),
  plan_id        uuid        NOT NULL REFERENCES platform.subscription_plan (id),
  valid_from     date        NOT NULL,
  valid_to       date,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'cancelled', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT tenant_subscription_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT tenant_subscription_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT tenant_subscription_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (deleted_at IS NULL)
);
SELECT app.setup_table('platform', 'tenant_subscription', 'tenant');

CREATE TABLE platform.usage_counter (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id),
  metric         text        NOT NULL,
  period         date        NOT NULL CHECK (period = date_trunc('month', period)::date),
  value          bigint      NOT NULL DEFAULT 0 CHECK (value >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT usage_counter_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL))
);
CREATE UNIQUE INDEX usage_counter_uq ON platform.usage_counter (tenant_id, metric, period) WHERE deleted_at IS NULL;
SELECT app.setup_table('platform', 'usage_counter', 'tenant');

CREATE TABLE platform.company (
  id                       uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                uuid        NOT NULL REFERENCES platform.tenant (id),
  legal_name               text        NOT NULL,
  trade_name               text,
  country_code             char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  base_currency            char(3)     NOT NULL REFERENCES platform.currency (code),
  time_zone                text        NOT NULL DEFAULT 'Asia/Qatar',
  -- Qatar's usual working week is Sunday to Thursday; configurable per company (SPEC 2.7).
  working_week             jsonb       NOT NULL DEFAULT '["sun","mon","tue","wed","thu"]'::jsonb,
  fiscal_year_start_month  smallint    NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  logo_file_id             uuid,
  letterhead               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                   text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid,
  version                  integer     NOT NULL DEFAULT 1,
  deleted_at               timestamptz,
  deleted_by               uuid,
  delete_reason            text,
  CONSTRAINT company_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT company_time_zone_ck CHECK (now() AT TIME ZONE time_zone IS NOT NULL),
  -- Target of the composite foreign keys below: a company-scoped row must belong to a
  -- company of the same tenant.
  CONSTRAINT company_tenant_id_uq UNIQUE (tenant_id, id)
);
SELECT app.setup_table('platform', 'company', 'tenant');

CREATE TABLE platform.branch (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid        NOT NULL,
  code            text        NOT NULL,
  name            text        NOT NULL,
  address         text,
  is_head_office  boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT branch_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT branch_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT branch_company_id_uq UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX branch_code_uq ON platform.branch (company_id, code) WHERE deleted_at IS NULL;
SELECT app.setup_table('platform', 'branch', 'company');

-- Zones and teams (docs/PLAN.md conflict C16).
CREATE TABLE platform.org_unit (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  branch_id      uuid,
  kind           text        NOT NULL CHECK (kind IN ('zone', 'team')),
  code           text        NOT NULL,
  name           text        NOT NULL,
  parent_id      uuid        REFERENCES platform.org_unit (id),
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT org_unit_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT org_unit_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT org_unit_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES platform.branch (company_id, id),
  CONSTRAINT org_unit_not_own_parent_ck CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX org_unit_code_uq ON platform.org_unit (company_id, kind, code) WHERE deleted_at IS NULL;
CREATE INDEX org_unit_parent_idx ON platform.org_unit (parent_id);
SELECT app.setup_table('platform', 'org_unit', 'company');

-- Feature flags per company (SPEC 2.13).
CREATE TABLE platform.company_module (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  module_key       text        NOT NULL,
  enabled          boolean     NOT NULL DEFAULT false,
  rollout_percent  smallint    NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  enabled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT company_module_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT company_module_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
CREATE UNIQUE INDEX company_module_uq ON platform.company_module (company_id, module_key) WHERE deleted_at IS NULL;
SELECT app.setup_table('platform', 'company_module', 'company');

-- Settings at tenant, company or user scope. company_id is NULL for tenant scope, so this
-- table has its own policy: tenant always; company only when it is one of the session's.
CREATE TABLE platform.setting (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id),
  company_id     uuid,
  user_id        uuid,
  scope          text        NOT NULL CHECK (scope IN ('tenant', 'company', 'user')),
  key            text        NOT NULL,
  value          jsonb       NOT NULL,
  valid_from     date        NOT NULL DEFAULT CURRENT_DATE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT setting_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT setting_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT setting_scope_ck CHECK (
    (scope = 'tenant'  AND company_id IS NULL     AND user_id IS NULL) OR
    (scope = 'company' AND company_id IS NOT NULL AND user_id IS NULL) OR
    (scope = 'user'    AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX setting_tenant_uq  ON platform.setting (tenant_id, key, valid_from) WHERE scope = 'tenant' AND deleted_at IS NULL;
CREATE UNIQUE INDEX setting_company_uq ON platform.setting (company_id, key, valid_from) WHERE scope = 'company' AND deleted_at IS NULL;
CREATE UNIQUE INDEX setting_user_uq    ON platform.setting (user_id, key, valid_from) WHERE scope = 'user' AND deleted_at IS NULL;
SELECT app.setup_table('platform', 'setting', 'tenant');
DROP POLICY tenant_isolation ON platform.setting;
CREATE POLICY tenant_company_optional ON platform.setting
  USING (tenant_id = app.current_tenant_id()
         AND (company_id IS NULL OR company_id = ANY (app.current_company_ids())))
  WITH CHECK (tenant_id = app.current_tenant_id()
         AND (company_id IS NULL OR company_id = ANY (app.current_company_ids())));

-- Human-readable numbers (L0001 ...). Allocated with SELECT ... FOR UPDATE in the API;
-- values are never reused (SPEC 2.12, 4.6).
CREATE TABLE platform.number_sequence (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  key            text        NOT NULL,
  prefix         text        NOT NULL DEFAULT '',
  padding        smallint    NOT NULL DEFAULT 4 CHECK (padding BETWEEN 1 AND 12),
  next_value     bigint      NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  reset_policy   text        NOT NULL DEFAULT 'never' CHECK (reset_policy IN ('never', 'yearly', 'monthly')),
  format         text        NOT NULL DEFAULT '{prefix}{number}',
  last_reset_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT number_sequence_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT number_sequence_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id)
);
CREATE UNIQUE INDEX number_sequence_key_uq ON platform.number_sequence (company_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('platform', 'number_sequence', 'company');

-- Inter-company loans and transfers are recorded on both sides (SPEC 2.7). The account
-- columns reference gl.account, which arrives in Phase 2 (foreign keys added then).
CREATE TABLE platform.inter_company_link (
  id                       uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                uuid        NOT NULL,
  from_company_id          uuid        NOT NULL,
  to_company_id            uuid        NOT NULL,
  receivable_account_id    uuid,
  payable_account_id       uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid,
  version                  integer     NOT NULL DEFAULT 1,
  deleted_at               timestamptz,
  deleted_by               uuid,
  delete_reason            text,
  CONSTRAINT inter_company_link_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT inter_company_link_from_fk FOREIGN KEY (tenant_id, from_company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT inter_company_link_to_fk FOREIGN KEY (tenant_id, to_company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT inter_company_link_distinct_ck CHECK (from_company_id <> to_company_id)
);
CREATE UNIQUE INDEX inter_company_link_uq ON platform.inter_company_link (from_company_id, to_company_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('platform', 'inter_company_link', 'tenant');

-- =============================================================================
-- iam
-- =============================================================================

-- One login per person per tenant. party_id gets its foreign key when the party schema
-- is created (Phase 1, commit 8).
CREATE TABLE iam.user_account (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL REFERENCES platform.tenant (id),
  party_id              uuid,
  username              text        NOT NULL CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 64),
  email                 text        CHECK (email = lower(email)),
  phone                 text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  display_name          text        NOT NULL,
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password  boolean     NOT NULL DEFAULT true,
  failed_attempts       integer     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  preferred_language    text        NOT NULL DEFAULT 'en',
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  delete_reason         text,
  CONSTRAINT user_account_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT user_account_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX user_account_username_uq ON iam.user_account (tenant_id, username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX user_account_email_uq ON iam.user_account (tenant_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX user_account_phone_uq ON iam.user_account (tenant_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;
CREATE INDEX user_account_party_idx ON iam.user_account (party_id);
SELECT app.setup_table('iam', 'user_account', 'tenant');

-- Password hashes (Argon2id). Old rows are kept with is_current = false for the
-- password-history rule.
CREATE TABLE iam.credential (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  kind           text        NOT NULL DEFAULT 'password' CHECK (kind IN ('password')),
  hash           text        NOT NULL,
  is_current     boolean     NOT NULL DEFAULT true,
  set_at         timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT credential_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT credential_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE UNIQUE INDEX credential_current_uq ON iam.credential (user_id, kind) WHERE is_current AND deleted_at IS NULL;
CREATE INDEX credential_user_idx ON iam.credential (user_id, set_at DESC);
SELECT app.setup_table('iam', 'credential', 'tenant');

CREATE TABLE iam.mfa_factor (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  user_id           uuid        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('totp', 'webauthn')),
  label             text,
  secret_encrypted  bytea       NOT NULL,
  confirmed_at      timestamptz,
  -- Last accepted TOTP time step: a code is accepted once only (replay protection).
  last_used_step    bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT mfa_factor_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT mfa_factor_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE INDEX mfa_factor_user_idx ON iam.mfa_factor (user_id);
SELECT app.setup_table('iam', 'mfa_factor', 'tenant');

CREATE TABLE iam.mfa_recovery_code (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  code_hash      text        NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT mfa_recovery_code_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT mfa_recovery_code_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE INDEX mfa_recovery_code_user_idx ON iam.mfa_recovery_code (user_id);
SELECT app.setup_table('iam', 'mfa_recovery_code', 'tenant');

CREATE TABLE iam.otp_challenge (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id),
  user_id        uuid,
  phone          text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  purpose        text        NOT NULL CHECK (purpose IN ('login', 'sign', 'reauth', 'verify_phone')),
  code_hash      text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  attempts       integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT otp_challenge_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT otp_challenge_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT otp_challenge_target_ck CHECK (user_id IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX otp_challenge_user_idx ON iam.otp_challenge (user_id, created_at DESC);
CREATE INDEX otp_challenge_phone_idx ON iam.otp_challenge (phone, created_at DESC);
SELECT app.setup_table('iam', 'otp_challenge', 'tenant');

CREATE TABLE iam.role (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id),
  key            text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name           text        NOT NULL,
  description    text,
  is_builtin     boolean     NOT NULL DEFAULT false,
  mfa_required   boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT role_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT role_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX role_key_uq ON iam.role (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('iam', 'role', 'tenant');

-- Which roles holders of a role may create (SPEC 2.1: Admin creates only roles Super
-- Admin allows).
CREATE TABLE iam.role_grantable (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,
  grantor_role_id    uuid        NOT NULL,
  grantable_role_id  uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            integer     NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  deleted_by         uuid,
  delete_reason      text,
  CONSTRAINT role_grantable_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT role_grantable_grantor_fk FOREIGN KEY (tenant_id, grantor_role_id) REFERENCES iam.role (tenant_id, id),
  CONSTRAINT role_grantable_grantable_fk FOREIGN KEY (tenant_id, grantable_role_id) REFERENCES iam.role (tenant_id, id)
);
CREATE UNIQUE INDEX role_grantable_uq ON iam.role_grantable (grantor_role_id, grantable_role_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('iam', 'role_grantable', 'tenant');

-- Permission catalogue, registered by module manifests at start-up (SPEC 2.1, 2.13).
CREATE TABLE iam.permission (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  key          text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module_key   text        NOT NULL,
  action       text        NOT NULL,
  resource     text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer     NOT NULL DEFAULT 1
);
CREATE INDEX permission_module_idx ON iam.permission (module_key);
SELECT app.setup_table('iam', 'permission', 'global_catalog');

CREATE TABLE iam.role_permission (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  role_id        uuid        NOT NULL,
  permission_id  uuid        NOT NULL REFERENCES iam.permission (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT role_permission_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT role_permission_role_fk FOREIGN KEY (tenant_id, role_id) REFERENCES iam.role (tenant_id, id)
);
CREATE UNIQUE INDEX role_permission_uq ON iam.role_permission (role_id, permission_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('iam', 'role_permission', 'tenant');

CREATE TABLE iam.company_membership (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  is_default     boolean     NOT NULL DEFAULT false,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT company_membership_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT company_membership_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT company_membership_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT company_membership_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX company_membership_uq ON iam.company_membership (user_id, company_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX company_membership_default_uq ON iam.company_membership (user_id) WHERE is_default AND deleted_at IS NULL;
SELECT app.setup_table('iam', 'company_membership', 'tenant');

CREATE TABLE iam.membership_role (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  membership_id  uuid        NOT NULL,
  role_id        uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT membership_role_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT membership_role_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES iam.company_membership (tenant_id, id),
  CONSTRAINT membership_role_role_fk FOREIGN KEY (tenant_id, role_id) REFERENCES iam.role (tenant_id, id)
);
CREATE UNIQUE INDEX membership_role_uq ON iam.membership_role (membership_id, role_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('iam', 'membership_role', 'tenant');

-- Per-user grant or deny, per company, taking priority over the role (SPEC 2.1).
CREATE TABLE iam.user_permission_override (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  permission_id  uuid        NOT NULL REFERENCES iam.permission (id),
  effect         text        NOT NULL CHECK (effect IN ('grant', 'deny')),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT user_permission_override_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT user_permission_override_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT user_permission_override_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE UNIQUE INDEX user_permission_override_uq ON iam.user_permission_override (company_id, user_id, permission_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('iam', 'user_permission_override', 'company');

-- Record-level scope (SPEC 2.1): own data only, or limited to platforms, zones, branches.
CREATE TABLE iam.data_scope (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  subject_type   text        NOT NULL CHECK (subject_type IN ('role', 'user')),
  subject_id     uuid        NOT NULL,
  scope_kind     text        NOT NULL CHECK (scope_kind IN ('own', 'platform', 'zone', 'branch', 'all')),
  scope_values   uuid[]      NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT data_scope_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT data_scope_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT data_scope_values_ck CHECK (scope_kind IN ('own', 'all') OR cardinality(scope_values) > 0)
);
CREATE UNIQUE INDEX data_scope_uq ON iam.data_scope (company_id, subject_type, subject_id, scope_kind) WHERE deleted_at IS NULL;
SELECT app.setup_table('iam', 'data_scope', 'company');

CREATE TABLE iam.impersonation (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  actor_user_id   uuid        NOT NULL,
  target_user_id  uuid        NOT NULL,
  reason          text        NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT impersonation_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT impersonation_actor_fk FOREIGN KEY (tenant_id, actor_user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT impersonation_target_fk FOREIGN KEY (tenant_id, target_user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT impersonation_not_self_ck CHECK (actor_user_id <> target_user_id),
  CONSTRAINT impersonation_tenant_id_uq UNIQUE (tenant_id, id)
);
SELECT app.setup_table('iam', 'impersonation', 'tenant');

CREATE TABLE iam.session (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  user_id           uuid        NOT NULL,
  company_id        uuid,
  impersonation_id  uuid,
  device            text,
  user_agent        text,
  ip                inet,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid,
  revoke_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT session_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT session_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id),
  CONSTRAINT session_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT session_impersonation_fk FOREIGN KEY (tenant_id, impersonation_id) REFERENCES iam.impersonation (tenant_id, id),
  CONSTRAINT session_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX session_user_active_idx ON iam.session (user_id) WHERE revoked_at IS NULL;
SELECT app.setup_table('iam', 'session', 'tenant');

-- Rotating refresh tokens. A token is used once; presenting a used token again revokes
-- the whole family (token theft detection).
CREATE TABLE iam.refresh_token (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  session_id       uuid        NOT NULL,
  family_id        uuid        NOT NULL,
  token_hash       text        NOT NULL,
  rotated_from_id  uuid        REFERENCES iam.refresh_token (id),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT refresh_token_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT refresh_token_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES iam.session (tenant_id, id)
);
CREATE UNIQUE INDEX refresh_token_hash_uq ON iam.refresh_token (token_hash);
CREATE INDEX refresh_token_family_idx ON iam.refresh_token (family_id);
SELECT app.setup_table('iam', 'refresh_token', 'tenant');

-- Login history (SPEC 2.1). Partitioned by month; insert-only.
CREATE TABLE iam.login_event (
  id          uuid        NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  identifier  text        NOT NULL,
  method      text        NOT NULL CHECK (method IN ('password', 'otp', 'refresh', 'sso')),
  result      text        NOT NULL CHECK (result IN ('success', 'bad_credentials', 'locked', 'disabled', 'mfa_required', 'mfa_failed', 'password_change_required')),
  ip          inet,
  device      text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE INDEX login_event_user_idx ON iam.login_event (user_id, at DESC);
SELECT app.setup_table('iam', 'login_event', 'tenant_append');
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('iam.login_event'::regclass, '2026-11-01', 3);

CREATE TABLE iam.password_reset_token (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  token_hash     text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT password_reset_token_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT password_reset_token_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES iam.user_account (tenant_id, id)
);
CREATE UNIQUE INDEX password_reset_token_hash_uq ON iam.password_reset_token (token_hash);
SELECT app.setup_table('iam', 'password_reset_token', 'tenant');

CREATE TABLE iam.api_client (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL,
  company_id             uuid        NOT NULL,
  name                   text        NOT NULL,
  kind                   text        NOT NULL CHECK (kind IN ('api_key', 'oauth_client')),
  client_secret_hash     text,
  scopes                 text[]      NOT NULL DEFAULT '{}',
  rate_limit_per_minute  integer     NOT NULL DEFAULT 600 CHECK (rate_limit_per_minute > 0),
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                integer     NOT NULL DEFAULT 1,
  deleted_at             timestamptz,
  deleted_by             uuid,
  delete_reason          text,
  CONSTRAINT api_client_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT api_client_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT api_client_company_id_uq UNIQUE (company_id, id)
);
SELECT app.setup_table('iam', 'api_client', 'company');

CREATE TABLE iam.api_key (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  api_client_id  uuid        NOT NULL,
  key_prefix     text        NOT NULL,
  key_hash       text        NOT NULL,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT api_key_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT api_key_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT api_key_client_fk FOREIGN KEY (company_id, api_client_id) REFERENCES iam.api_client (company_id, id)
);
CREATE UNIQUE INDEX api_key_hash_uq ON iam.api_key (key_hash);
CREATE INDEX api_key_prefix_idx ON iam.api_key (key_prefix);
SELECT app.setup_table('iam', 'api_key', 'company');

CREATE TABLE iam.ip_allowlist (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL REFERENCES platform.tenant (id),
  -- inet holds an address or a network (for example 10.0.0.0/8); Prisma cannot read cidr.
  cidr           inet        NOT NULL,
  applies_to     text        NOT NULL DEFAULT 'admin' CHECK (applies_to IN ('admin', 'all')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT ip_allowlist_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL))
);
SELECT app.setup_table('iam', 'ip_allowlist', 'tenant');

-- Ready for single sign-on (SPEC 6.5); unused at launch.
CREATE TABLE iam.sso_provider (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL REFERENCES platform.tenant (id),
  kind              text        NOT NULL CHECK (kind IN ('oidc', 'saml')),
  name              text        NOT NULL,
  config_encrypted  bytea       NOT NULL,
  status            text        NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT sso_provider_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL))
);
SELECT app.setup_table('iam', 'sso_provider', 'tenant');

-- Create the login_event partitions for the current window.
SELECT app.maintain_partitions();
