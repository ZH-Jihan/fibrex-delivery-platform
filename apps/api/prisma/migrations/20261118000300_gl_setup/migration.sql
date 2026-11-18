-- =============================================================================
-- Migration: ledger set-up (Phase 2, row 2.14)
--
-- PLAN 3.9 `gl.account`, `cost_centre`, `tax_code`, `exchange_rate`, `fiscal_year`,
-- `fiscal_period` (all S: company-scoped, audited, versioned, soft-deleted, RLS). The journal
-- tables and the posting service follow in row 2.15; the period check on posting is a trigger
-- there and reads `fiscal_period.status` from here.
--
-- Design notes:
--   * Every table is per company: each company keeps its own books (SPEC 2.7).
--   * Composite foreign keys (company_id, x_id) keep a parent, an account or a year inside
--     the same company, as platform.branch does with (tenant_id, company_id).
--   * Account codes never change once created (posting rules name accounts by code, row
--     2.15); the tree rules (header accounts, same type as the parent, no cycles) live in
--     the API (modules/gl) because they need the whole tree.
--   * Currencies are foreign keys to the global `platform.currency` list.
--   * Fiscal years do not overlap within a company and neither do periods (exclusion
--     constraints). Periods are created with their year and are never edited directly;
--     only close, lock and reopen change them, and each records who and when.
-- =============================================================================

CREATE SCHEMA gl;
GRANT USAGE ON SCHEMA gl TO fibrex_app;

-- ---------------------------------------------------------------------------
-- Chart of accounts: an editable tree. Header accounts (is_postable = false) group others.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.account (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL,
  company_id           uuid        NOT NULL,
  code                 text        NOT NULL CHECK (code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'),
  -- Name per language; English is required (same shape as cfg lookups).
  name                 jsonb       NOT NULL CHECK (jsonb_typeof(name) = 'object' AND name ? 'en'),
  type                 text        NOT NULL
                       CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id            uuid,
  is_postable          boolean     NOT NULL DEFAULT true,
  -- A control account is the total of a sub-ledger (receivables, payables): lines name a party.
  is_control           boolean     NOT NULL DEFAULT false,
  -- When set, only lines in this currency may post to the account.
  currency_restriction char(3)     REFERENCES platform.currency (code),
  -- Dimensions every line on this account must carry (party, branch, cost_centre ...).
  requires_dimensions  text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(requires_dimensions) <= 10),
  description          text        CHECK (length(description) <= 2000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              integer     NOT NULL DEFAULT 1,
  deleted_at           timestamptz,
  deleted_by           uuid,
  delete_reason        text,
  CONSTRAINT account_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT account_not_own_parent_ck CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT account_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT account_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT account_parent_fk FOREIGN KEY (company_id, parent_id)
    REFERENCES gl.account (company_id, id)
);
CREATE UNIQUE INDEX account_code_uq ON gl.account (company_id, code) WHERE deleted_at IS NULL;
CREATE INDEX account_parent_idx ON gl.account (parent_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'account', 'company');

-- ---------------------------------------------------------------------------
-- Cost centres: a tree used as a journal-line dimension.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.cost_centre (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  code          text        NOT NULL CHECK (code ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,29}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  parent_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT cost_centre_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT cost_centre_not_own_parent_ck CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT cost_centre_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT cost_centre_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT cost_centre_parent_fk FOREIGN KEY (company_id, parent_id)
    REFERENCES gl.cost_centre (company_id, id)
);
CREATE UNIQUE INDEX cost_centre_code_uq ON gl.cost_centre (company_id, code) WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'cost_centre', 'company');

-- ---------------------------------------------------------------------------
-- Tax codes: every journal line carries one (SPEC 5.15). Exactly one default per company;
-- the seed makes "NONE" (0 %) the default because no tax applies yet.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.tax_code (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL,
  company_id    uuid          NOT NULL,
  code          text          NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name          text          NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- Percent, for example 5.0000 for 5 %.
  rate          numeric(7,4)  NOT NULL DEFAULT 0 CHECK (rate >= 0 AND rate <= 100),
  -- Where the tax amount posts; required when the rate is above zero.
  account_id    uuid,
  is_default    boolean       NOT NULL DEFAULT false,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer       NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT tax_code_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT tax_code_account_ck CHECK (rate = 0 OR account_id IS NOT NULL),
  CONSTRAINT tax_code_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT tax_code_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT tax_code_account_fk FOREIGN KEY (company_id, account_id)
    REFERENCES gl.account (company_id, id)
);
CREATE UNIQUE INDEX tax_code_code_uq ON gl.tax_code (company_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tax_code_default_uq ON gl.tax_code (company_id)
  WHERE is_default AND deleted_at IS NULL;
SELECT app.setup_table('gl', 'tax_code', 'company');

-- ---------------------------------------------------------------------------
-- Exchange rates: 1 from_currency = rate to_currency on rate_date. The posting service
-- (row 2.15) uses the latest rate on or before the entry date and stores it on the line.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.exchange_rate (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL,
  company_id    uuid          NOT NULL,
  from_currency char(3)       NOT NULL REFERENCES platform.currency (code),
  to_currency   char(3)       NOT NULL REFERENCES platform.currency (code),
  rate_date     date          NOT NULL,
  rate          numeric(18,8) NOT NULL CHECK (rate > 0),
  source        text          NOT NULL DEFAULT 'manual' CHECK (length(btrim(source)) BETWEEN 1 AND 100),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer       NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT exchange_rate_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT exchange_rate_pair_ck CHECK (from_currency <> to_currency),
  CONSTRAINT exchange_rate_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT exchange_rate_company_id_uq UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX exchange_rate_day_uq
  ON gl.exchange_rate (company_id, from_currency, to_currency, rate_date) WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'exchange_rate', 'company');

-- ---------------------------------------------------------------------------
-- Fiscal years and their periods.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.fiscal_year (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  start_date    date        NOT NULL,
  end_date      date        NOT NULL,
  -- closed when every period is closed or locked (kept in step by the API).
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT fiscal_year_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT fiscal_year_dates_ck CHECK (end_date >= start_date AND end_date < start_date + 548),
  CONSTRAINT fiscal_year_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT fiscal_year_company_id_uq UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX fiscal_year_name_uq ON gl.fiscal_year (company_id, name) WHERE deleted_at IS NULL;
ALTER TABLE gl.fiscal_year ADD CONSTRAINT fiscal_year_no_overlap EXCLUDE USING gist (
  company_id WITH =, daterange(start_date, end_date, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('gl', 'fiscal_year', 'company');

CREATE TABLE gl.fiscal_period (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL,
  company_id     uuid        NOT NULL,
  fiscal_year_id uuid        NOT NULL,
  period_no      smallint    NOT NULL CHECK (period_no BETWEEN 1 AND 18),
  start_date     date        NOT NULL,
  end_date       date        NOT NULL,
  -- open: postings allowed; closed: refused, may be reopened; locked: final, reopening it
  -- needs the separate unlock permission.
  status         text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_by      uuid,
  closed_at      timestamptz,
  locked_by      uuid,
  locked_at      timestamptz,
  reopened_by    uuid,
  reopened_at    timestamptz,
  reopen_reason  text        CHECK (length(reopen_reason) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        integer     NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  deleted_by     uuid,
  delete_reason  text,
  CONSTRAINT fiscal_period_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT fiscal_period_dates_ck CHECK (end_date >= start_date),
  CONSTRAINT fiscal_period_closed_ck CHECK (status = 'open' OR closed_at IS NOT NULL),
  CONSTRAINT fiscal_period_locked_ck CHECK (status <> 'locked' OR locked_at IS NOT NULL),
  CONSTRAINT fiscal_period_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT fiscal_period_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT fiscal_period_year_fk FOREIGN KEY (company_id, fiscal_year_id)
    REFERENCES gl.fiscal_year (company_id, id)
);
CREATE UNIQUE INDEX fiscal_period_no_uq ON gl.fiscal_period (fiscal_year_id, period_no)
  WHERE deleted_at IS NULL;
ALTER TABLE gl.fiscal_period ADD CONSTRAINT fiscal_period_no_overlap EXCLUDE USING gist (
  company_id WITH =, daterange(start_date, end_date, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('gl', 'fiscal_period', 'company');
