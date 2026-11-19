-- Phase 3, row 3.1: the `people` schema, part one (PLAN 3.10): employee, employment_period,
-- employee_placement. Documents follow in row 3.2.
--
-- Design notes:
--   * A person exists once, in party.party (SPEC 2.8). `employee` holds only what is about
--     the employment; names, phones, QID and passport stay on the party and its identifiers.
--     One live employee row per party and company; a rehire reuses the same row and adds an
--     employment period, so history stays with the person.
--   * `employee_code` comes from the number sequence `employee` (E0001 ...) and is never
--     reused, so it is unique per company even among deleted rows.
--   * `status_code` is a state of the `people.employee` state machine. Only the state
--     service changes it (with dated history); the API never accepts it in a body.
--   * Sponsorship: under the company, or by an outside sponsor (another party). A sponsor
--     party is only allowed for `outside`; nobody sponsors or recruits themselves.
--   * Placements are effective-dated (valid_from / valid_to inclusive); an exclusion
--     constraint keeps one placement per employee on any day, so "current placement" is
--     always a single row. Zone and team are platform.org_unit rows of that kind (checked by
--     the API); the client platform table arrives later, so its id is a plain uuid for now.
--   * Every table: tenant and company, audit columns, version, soft delete, RLS, audit
--     trigger and no DELETE grant, through app.setup_table.

CREATE SCHEMA people;
GRANT USAGE ON SCHEMA people TO fibrex_app;

CREATE TABLE people.employee (
  id                         uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                  uuid        NOT NULL,
  company_id                 uuid        NOT NULL,
  branch_id                  uuid,
  party_id                   uuid        NOT NULL,
  employee_code              text        NOT NULL CHECK (length(employee_code) BETWEEN 1 AND 40),
  status_code                text        NOT NULL DEFAULT 'active' CHECK (status_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  sponsorship                text        NOT NULL DEFAULT 'company' CHECK (sponsorship IN ('company', 'outside')),
  sponsor_party_id           uuid,
  recruiting_agent_party_id  uuid,
  joining_date               date,
  custom_fields              jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom_fields) = 'object'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid,
  version                    integer     NOT NULL DEFAULT 1,
  deleted_at                 timestamptz,
  deleted_by                 uuid,
  delete_reason              text,
  CONSTRAINT employee_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT employee_sponsor_ck CHECK (sponsorship = 'outside' OR sponsor_party_id IS NULL),
  CONSTRAINT employee_not_own_sponsor_ck CHECK (sponsor_party_id IS NULL OR sponsor_party_id <> party_id),
  CONSTRAINT employee_not_own_agent_ck CHECK (recruiting_agent_party_id IS NULL OR recruiting_agent_party_id <> party_id),
  CONSTRAINT employee_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT employee_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES platform.branch (company_id, id),
  CONSTRAINT employee_party_fk FOREIGN KEY (company_id, party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT employee_sponsor_fk FOREIGN KEY (company_id, sponsor_party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT employee_agent_fk FOREIGN KEY (company_id, recruiting_agent_party_id) REFERENCES party.party (company_id, id),
  CONSTRAINT employee_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT employee_code_uq UNIQUE (company_id, employee_code)
);
CREATE UNIQUE INDEX employee_party_uq ON people.employee (company_id, party_id) WHERE deleted_at IS NULL;
CREATE INDEX employee_status_idx ON people.employee (company_id, status_code);
CREATE INDEX employee_custom_fields_idx ON people.employee USING gin (custom_fields);
SELECT app.setup_table('people', 'employee', 'company');

CREATE TABLE people.employment_period (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  employee_id      uuid        NOT NULL,
  start_date       date        NOT NULL,
  -- Inclusive: the last working day. NULL = still employed.
  end_date         date,
  -- The exit clearance case (Phase 10); NULL until that module exists.
  exit_case_id     uuid,
  rehire_eligible  boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT employment_period_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT employment_period_dates_ck CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT employment_period_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT employment_period_employee_fk FOREIGN KEY (company_id, employee_id) REFERENCES people.employee (company_id, id)
);
CREATE INDEX employment_period_employee_idx ON people.employment_period (employee_id);
-- Two periods of one employee never overlap (a rehire starts after the last one ended).
ALTER TABLE people.employment_period ADD CONSTRAINT employment_period_no_overlap EXCLUDE USING gist (
  employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('people', 'employment_period', 'company');

CREATE TABLE people.employee_placement (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL,
  company_id          uuid        NOT NULL,
  branch_id           uuid,
  employee_id         uuid        NOT NULL,
  valid_from          date        NOT NULL DEFAULT current_date,
  -- Inclusive: the last day of this placement. NULL = current.
  valid_to            date,
  -- Code of the `profession` lookup (rider, driver ...).
  profession          text        NOT NULL CHECK (profession ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- The client platform table arrives in a later phase; until then a plain id.
  client_platform_id  uuid,
  -- platform.org_unit of kind zone / team (kind checked by the API).
  org_unit_id         uuid        REFERENCES platform.org_unit (id),
  team_id             uuid        REFERENCES platform.org_unit (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             integer     NOT NULL DEFAULT 1,
  deleted_at          timestamptz,
  deleted_by          uuid,
  delete_reason       text,
  CONSTRAINT employee_placement_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT employee_placement_period_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_placement_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT employee_placement_branch_fk FOREIGN KEY (company_id, branch_id) REFERENCES platform.branch (company_id, id),
  CONSTRAINT employee_placement_employee_fk FOREIGN KEY (company_id, employee_id) REFERENCES people.employee (company_id, id)
);
CREATE INDEX employee_placement_employee_idx ON people.employee_placement (employee_id);
-- One placement per employee on any day: the current placement is always a single row.
ALTER TABLE people.employee_placement ADD CONSTRAINT employee_placement_no_overlap EXCLUDE USING gist (
  employee_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&
) WHERE (deleted_at IS NULL);
SELECT app.setup_table('people', 'employee_placement', 'company');
