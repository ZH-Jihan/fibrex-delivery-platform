-- =============================================================================
-- Migration: cash locations, company bank accounts and bank statements
-- (Phase 2, row 2.17a; PLAN 3.9)
--
-- What this adds (all company-scoped S tables with RLS, audit trigger, soft delete):
--   gl.cash_location          a place money is held (hand, bank, card, wallet), tied to the
--                             ledger account that carries its balance. The table never holds
--                             a balance itself (SPEC 2.9); the balance is the ledger's.
--   gl.company_bank_account   the company's own bank account at a cash location. The number
--                             (IBAN) is encrypted (kernel SecretBox), keyed-hashed for the
--                             duplicate check and masked for display. The audit trigger
--                             redacts columns whose name contains "encrypted" or "hash", so
--                             the number never reaches the audit log.
--   gl.bank_statement         one imported statement file (kept as files.raw_input).
--   gl.bank_statement_line    its lines; amounts are signed from the company's point of view
--                             (money in > 0, money out < 0).
--
-- What the database enforces:
--   1. One cash location per ledger account, and one bank account per cash location (among
--      live rows), so "the balance of this place" is never ambiguous.
--   2. The same statement file cannot be imported twice for one bank account (sha256).
--   3. A statement line's content (date, amount, currency, text, number) never changes after
--      import: a bank statement is evidence. Only match_status and the soft-delete columns
--      move (trigger). Corrections are a new import after deleting the wrong statement.
--   4. A line is never zero and never has a status other than unmatched or matched.
-- Match rules and reconciliation matches come in row 2.17b.
-- =============================================================================

CREATE TABLE gl.cash_location (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind          text        NOT NULL CHECK (kind IN ('hand', 'bank', 'card', 'wallet')),
  account_id    uuid        NOT NULL,
  currency      char(3)     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT cash_location_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT cash_location_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT cash_location_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT cash_location_account_fk FOREIGN KEY (company_id, account_id)
    REFERENCES gl.account (company_id, id),
  CONSTRAINT cash_location_currency_fk FOREIGN KEY (currency) REFERENCES platform.currency (code)
);
CREATE UNIQUE INDEX cash_location_name_uq ON gl.cash_location (company_id, name)
  WHERE deleted_at IS NULL;
-- Rule 1.
CREATE UNIQUE INDEX cash_location_account_uq ON gl.cash_location (company_id, account_id)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'cash_location', 'company');

CREATE TABLE gl.company_bank_account (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  cash_location_id uuid        NOT NULL,
  bank_name        text        NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 1 AND 200),
  iban_encrypted   bytea       NOT NULL,
  iban_hash        text        NOT NULL,
  iban_masked      text        NOT NULL,
  wps_employer_id  text        CHECK (wps_employer_id IS NULL OR length(btrim(wps_employer_id)) BETWEEN 1 AND 50),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          integer     NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       uuid,
  delete_reason    text,
  CONSTRAINT company_bank_account_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT company_bank_account_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT company_bank_account_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT company_bank_account_location_fk FOREIGN KEY (company_id, cash_location_id)
    REFERENCES gl.cash_location (company_id, id)
);
CREATE UNIQUE INDEX company_bank_account_location_uq ON gl.company_bank_account (company_id, cash_location_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX company_bank_account_number_uq ON gl.company_bank_account (company_id, iban_hash)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'company_bank_account', 'company');

CREATE TABLE gl.bank_statement (
  id                      uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id               uuid          NOT NULL,
  company_id              uuid          NOT NULL,
  company_bank_account_id uuid          NOT NULL,
  raw_input_id            uuid          NOT NULL,
  file_name               text          NOT NULL,
  sha256                  text          NOT NULL,
  period_from             date          NOT NULL,
  period_to               date          NOT NULL,
  currency                char(3)       NOT NULL,
  line_count              integer       NOT NULL CHECK (line_count > 0),
  total_in                numeric(18,4) NOT NULL CHECK (total_in >= 0),
  total_out               numeric(18,4) NOT NULL CHECK (total_out >= 0),
  status                  text          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled')),
  note                    text          CHECK (note IS NULL OR length(note) <= 500),
  created_at              timestamptz   NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer       NOT NULL DEFAULT 1,
  deleted_at              timestamptz,
  deleted_by              uuid,
  delete_reason           text,
  CONSTRAINT bank_statement_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT bank_statement_period_ck CHECK (period_from <= period_to),
  CONSTRAINT bank_statement_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT bank_statement_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT bank_statement_account_fk FOREIGN KEY (company_id, company_bank_account_id)
    REFERENCES gl.company_bank_account (company_id, id),
  CONSTRAINT bank_statement_raw_input_fk FOREIGN KEY (raw_input_id) REFERENCES files.raw_input (id),
  CONSTRAINT bank_statement_currency_fk FOREIGN KEY (currency) REFERENCES platform.currency (code)
);
-- Rule 2.
CREATE UNIQUE INDEX bank_statement_file_uq ON gl.bank_statement (company_bank_account_id, sha256)
  WHERE deleted_at IS NULL;
CREATE INDEX bank_statement_list_idx ON gl.bank_statement (company_id, company_bank_account_id, period_from DESC)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'bank_statement', 'company');

CREATE TABLE gl.bank_statement_line (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL,
  company_id    uuid          NOT NULL,
  statement_id  uuid          NOT NULL,
  line_no       integer       NOT NULL CHECK (line_no > 0),
  value_date    date          NOT NULL,
  -- Signed: money into the account is positive, money out is negative (rule 4: never zero).
  amount        numeric(18,4) NOT NULL CHECK (amount <> 0),
  currency      char(3)       NOT NULL,
  reference     text          CHECK (reference IS NULL OR length(reference) <= 200),
  description   text          CHECK (description IS NULL OR length(description) <= 1000),
  match_status  text          NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'matched')),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer       NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT bank_statement_line_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT bank_statement_line_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT bank_statement_line_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT bank_statement_line_statement_fk FOREIGN KEY (company_id, statement_id)
    REFERENCES gl.bank_statement (company_id, id),
  CONSTRAINT bank_statement_line_currency_fk FOREIGN KEY (currency) REFERENCES platform.currency (code)
);
CREATE UNIQUE INDEX bank_statement_line_no_uq ON gl.bank_statement_line (statement_id, line_no);
CREATE INDEX bank_statement_line_open_idx ON gl.bank_statement_line (company_id, match_status, value_date)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'bank_statement_line', 'company');

-- Rule 3.
CREATE FUNCTION gl.tg_bank_statement_line_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.statement_id, NEW.line_no, NEW.value_date, NEW.amount, NEW.currency)
       IS DISTINCT FROM (OLD.statement_id, OLD.line_no, OLD.value_date, OLD.amount, OLD.currency)
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'gl_statement_line_immutable: a bank statement line cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER c_bank_statement_line_update BEFORE UPDATE ON gl.bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION gl.tg_bank_statement_line_update();
