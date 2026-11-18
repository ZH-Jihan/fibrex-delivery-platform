-- =============================================================================
-- Migration: bank match rules and reconciliation matches
-- (Phase 2, row 2.17b; PLAN 3.9)
--
-- What this adds (company-scoped S tables with RLS, audit trigger, soft delete):
--   gl.bank_match_rule        a saved rule for automatic matching: conditions on a statement
--                             line (data, never code; SPEC 2.6), optionally narrowed to
--                             ledger entries that touch a counter account or a party, tried
--                             in priority order.
--   gl.reconciliation_match   one statement line paired with one ledger (journal) line.
--                             Unmatching soft-deletes the match; the ledger is never touched.
--
-- What the database enforces (the API checks the same first, to give clear messages):
--   1. A statement line has at most one live match, and a journal line has at most one live
--      match, so one bank movement is never counted against two ledger entries and one ledger
--      entry is never "found" twice on the statements.
--   2. A match is only ever between a line of a statement of a bank account and a ledger line
--      on THAT bank account's cash account, in the same currency, for exactly the line's
--      signed amount (money in = debit, money out = credit). The matched amount is the whole
--      amount: no partial matches.
--   3. A match never changes after it is made; unmatching only sets the soft-delete columns.
-- Statement line content stays immutable (migration gl_cash_bank); only match_status moves.
-- =============================================================================

CREATE TABLE gl.bank_match_rule (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  company_id        uuid        NOT NULL,
  name              text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- Checked by the shared Zod schema (direction, text, amount range, date window).
  conditions        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(conditions) = 'object'),
  -- Narrow the ledger entries a line may match: the entry also has a line on this account /
  -- carries this party. Both optional.
  target_account_id uuid,
  target_party_id   uuid,
  priority          integer     NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 9999),
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT bank_match_rule_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT bank_match_rule_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT bank_match_rule_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT bank_match_rule_account_fk FOREIGN KEY (company_id, target_account_id)
    REFERENCES gl.account (company_id, id)
);
CREATE UNIQUE INDEX bank_match_rule_name_uq ON gl.bank_match_rule (company_id, name)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'bank_match_rule', 'company');

CREATE TABLE gl.reconciliation_match (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL,
  company_id        uuid          NOT NULL,
  statement_line_id uuid          NOT NULL,
  journal_line_id   uuid          NOT NULL,
  -- journal_line is partitioned by entry_date, so its key is (id, entry_date).
  journal_line_date date          NOT NULL,
  -- Signed like the statement line: money in > 0.
  amount            numeric(18,4) NOT NULL CHECK (amount <> 0),
  matched_by        uuid,
  method            text          NOT NULL CHECK (method IN ('rule', 'manual')),
  rule_id           uuid,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer       NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT reconciliation_match_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT reconciliation_match_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT reconciliation_match_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT reconciliation_match_line_fk FOREIGN KEY (company_id, statement_line_id)
    REFERENCES gl.bank_statement_line (company_id, id),
  -- No foreign key to gl.journal_line: it is partitioned, and a key into a partitioned table
  -- becomes one key per partition (in the `partitions` schema), which Prisma cannot read.
  -- The insert trigger below checks that the journal line exists, and journal lines are never
  -- deleted (the ledger is insert-only), so the link cannot dangle.
  CONSTRAINT reconciliation_match_rule_fk FOREIGN KEY (company_id, rule_id)
    REFERENCES gl.bank_match_rule (company_id, id)
);
-- Rule 1.
CREATE UNIQUE INDEX reconciliation_match_line_uq ON gl.reconciliation_match (statement_line_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX reconciliation_match_journal_uq
  ON gl.reconciliation_match (journal_line_id, journal_line_date) WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'reconciliation_match', 'company');

-- Rule 2: the match must be a real, whole-amount pairing on the bank account's cash account.
CREATE FUNCTION gl.tg_reconciliation_match_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_line_amount   numeric(18,4);
  v_line_currency char(3);
  v_cash_account  uuid;
  v_account       uuid;
  v_company       uuid;
  v_signed        numeric(18,4);
  v_currency      char(3);
BEGIN
  SELECT l.amount, l.currency, cl.account_id
    INTO v_line_amount, v_line_currency, v_cash_account
    FROM gl.bank_statement_line l
    JOIN gl.bank_statement s ON s.company_id = l.company_id AND s.id = l.statement_id
    JOIN gl.company_bank_account a ON a.company_id = s.company_id AND a.id = s.company_bank_account_id
    JOIN gl.cash_location cl ON cl.company_id = a.company_id AND cl.id = a.cash_location_id
   WHERE l.company_id = NEW.company_id AND l.id = NEW.statement_line_id;

  SELECT jl.account_id, jl.company_id, jl.debit - jl.credit, jl.currency
    INTO v_account, v_company, v_signed, v_currency
    FROM gl.journal_line jl
   WHERE jl.id = NEW.journal_line_id AND jl.entry_date = NEW.journal_line_date;

  IF v_company IS DISTINCT FROM NEW.company_id
     OR v_account IS DISTINCT FROM v_cash_account
     OR v_currency IS DISTINCT FROM v_line_currency
     OR v_signed IS DISTINCT FROM v_line_amount
     OR NEW.amount IS DISTINCT FROM v_line_amount THEN
    RAISE EXCEPTION 'gl_match_mismatch: the ledger line is not on the bank account, or its amount or currency differs'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER c_reconciliation_match_insert BEFORE INSERT ON gl.reconciliation_match
  FOR EACH ROW EXECUTE FUNCTION gl.tg_reconciliation_match_insert();

-- Rule 3.
CREATE FUNCTION gl.tg_reconciliation_match_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.statement_line_id, NEW.journal_line_id, NEW.journal_line_date, NEW.amount, NEW.method)
       IS DISTINCT FROM
     (OLD.statement_line_id, OLD.journal_line_id, OLD.journal_line_date, OLD.amount, OLD.method)
     OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
     OR NEW.matched_by IS DISTINCT FROM OLD.matched_by THEN
    RAISE EXCEPTION 'gl_match_immutable: a match cannot be changed; unmatch it and match again'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER c_reconciliation_match_update BEFORE UPDATE ON gl.reconciliation_match
  FOR EACH ROW EXECUTE FUNCTION gl.tg_reconciliation_match_update();
