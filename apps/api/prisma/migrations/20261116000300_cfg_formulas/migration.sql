-- =============================================================================
-- Migration: formulas and their versions (Phase 2, row 2.9a)
--
-- PLAN 3.7 `formula` (S) and `formula_version` (S); SPEC 2.10 "Rules and formula engine".
-- Pay components, fines, billing rates, interest, eligibility and alert rules are formulas
-- written in CEL and evaluated by the sandboxed engine in packages/formula.
--
-- Design notes:
--   * A formula is tenant-wide: its key (for example `pay.per_order`), purpose, the type it
--     returns and the inputs it may read (`input_schema`, JSON: name -> {type, default?}).
--     The return type never changes; the input schema may change only while every active
--     and retired version still compiles against it (checked by the API).
--   * A version holds the expression, its test cases and its effective dates. It is a
--     draft until activated. Activation runs the test cases (all must pass), closes the
--     version in force (valid_to = new valid_from - 1, status retired) and makes the new
--     one the only `active` version, open-ended. Active and retired versions are frozen, so
--     a past month can be recomputed exactly as it was (SPEC 2.10 effective dating).
--   * `checksum` is the SHA-256 of the expression, so a stored result (for example a
--     payslip line, PLAN 3.16) can prove which text produced it.
-- =============================================================================

CREATE TABLE cfg.formula (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description   text        CHECK (length(description) <= 2000),
  purpose       text        NOT NULL CHECK (purpose IN ('pay_component', 'billing_rate', 'fine',
                              'interest', 'eligibility', 'alert', 'allocation', 'risk')),
  return_type   text        NOT NULL CHECK (return_type IN ('decimal', 'int', 'bool', 'string')),
  input_schema  jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_schema) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT formula_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT formula_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT formula_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX formula_key_uq ON cfg.formula (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'formula', 'tenant');

CREATE TABLE cfg.formula_version (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  formula_id    uuid        NOT NULL,
  version_no    integer     NOT NULL CHECK (version_no > 0),
  language      text        NOT NULL DEFAULT 'cel' CHECK (language = 'cel'),
  expression    text        NOT NULL CHECK (length(expression) BETWEEN 1 AND 5000),
  valid_from    date        NOT NULL DEFAULT current_date,
  valid_to      date,
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  test_cases    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(test_cases) = 'array'),
  checksum      text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT formula_version_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT formula_version_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT formula_version_formula_fk FOREIGN KEY (tenant_id, formula_id) REFERENCES cfg.formula (tenant_id, id),
  CONSTRAINT formula_version_tenant_id_uq UNIQUE (tenant_id, id)
);
-- A number always names one expression, deleted drafts included.
CREATE UNIQUE INDEX formula_version_no_uq ON cfg.formula_version (formula_id, version_no);
-- At most one open-ended version in force per formula.
CREATE UNIQUE INDEX formula_version_active_uq ON cfg.formula_version (formula_id)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX formula_version_resolve_idx ON cfg.formula_version (formula_id, valid_from)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'formula_version', 'tenant');
