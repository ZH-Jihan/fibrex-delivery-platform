-- =============================================================================
-- Migration: posting rules, journals and journal lines (Phase 2, row 2.15a)
--
-- PLAN 3.9 `posting_rule` (S), `journal` (A), `journal_line` (A, partitioned by entry_date).
-- SPEC 2.9: no module keeps its own balance; every money movement is a balanced journal
-- posted through one posting service (modules/gl/posting-service.ts). Posted journals are
-- never changed; a correction is a reversal journal.
--
-- What the database enforces, so that no code path (a bug, a module, a script run as the
-- app role) can write a ledger that does not add up:
--   1. Lines are one-sided: debit > 0 and credit = 0, or the other way round, in the
--      transaction currency and in the base currency (CHECK).
--   2. A journal balances in the base currency and has exactly `line_count` lines. A
--      deferred constraint trigger checks this at COMMIT, after every line is in. Because
--      line numbers are unique per journal and must be between 1 and line_count, no line
--      can be added to a journal later (every slot is already taken).
--   3. The entry date lies in the journal's fiscal period and that period is open. The
--      insert trigger reads the period FOR SHARE, so a period cannot be closed while a
--      posting into it is still uncommitted (the close waits, then sees the journal).
--   4. Lines post only to live, postable accounts of the same company, in the account's
--      currency when it is restricted; the line's date, company and tenant are the journal's.
--   5. Journals and lines are insert-only (app.tg_append_only, and no UPDATE grant).
--   6. A journal is reversed at most once (unique reversal_of_id).
--   7. A posting rule that is no longer a draft cannot change what it posts (frozen columns).
--
-- Differences from PLAN 3.9 (recorded in DECISIONS):
--   * journal has no `reversed_by_id`: setting it would need an UPDATE on an insert-only
--     table. The reversing journal points back with `reversal_of_id`, which is unique.
--   * journal has `line_count` (rule 2) and `reason` (why it was reversed).
--   * posting_rule has `name`, `description`, `input_schema` (the inputs its formulas and
--     resolvers may read, as for formulas), `version_no` and `checksum`, and is per company
--     (each company keeps its own books and its own chart).
--   * journal_line has no FK for vehicle, client_platform, pay_period and loan yet: those
--     tables arrive in phases 5 to 7, which add the keys (expand only).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Posting rules: how an event becomes journal lines (accounting treatment is data).
-- `lines` is a JSON array checked by the API (packages/shared ledger/posting.ts):
--   { side, account: {kind: fixed|input|map ...}, amount: "<CEL>", dimensions?, taxCode?, memo? }
-- ---------------------------------------------------------------------------
CREATE TABLE gl.posting_rule (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  event_key     text        NOT NULL CHECK (event_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  version_no    integer     NOT NULL CHECK (version_no > 0),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description   text        CHECK (length(description) <= 2000),
  input_schema  jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_schema) = 'object'),
  lines         jsonb       NOT NULL
                CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 2 AND 50),
  valid_from    date        NOT NULL DEFAULT current_date,
  valid_to      date,
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  -- SHA-256 of the canonical JSON of input_schema and lines.
  checksum      text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT posting_rule_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT posting_rule_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT posting_rule_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT posting_rule_company_id_uq UNIQUE (company_id, id)
);
-- A number always names one set of lines, deleted drafts included.
CREATE UNIQUE INDEX posting_rule_version_uq ON gl.posting_rule (company_id, event_key, version_no);
-- At most one open-ended version in force per event.
CREATE UNIQUE INDEX posting_rule_active_uq ON gl.posting_rule (company_id, event_key)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX posting_rule_resolve_idx ON gl.posting_rule (company_id, event_key, valid_from)
  WHERE deleted_at IS NULL AND status <> 'draft';
SELECT app.setup_table('gl', 'posting_rule', 'company');

-- Rule 7: once in force, what a rule posts never changes (journals name the version).
-- Only status (active -> retired), valid_to and the soft-delete columns may move.
CREATE FUNCTION gl.tg_posting_rule_frozen() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.event_key    IS DISTINCT FROM OLD.event_key
    OR NEW.version_no   IS DISTINCT FROM OLD.version_no
    OR NEW.input_schema IS DISTINCT FROM OLD.input_schema
    OR NEW.lines        IS DISTINCT FROM OLD.lines
    OR NEW.valid_from   IS DISTINCT FROM OLD.valid_from
    OR NEW.checksum     IS DISTINCT FROM OLD.checksum
    OR NEW.status = 'draft') THEN
    RAISE EXCEPTION 'gl_posting_rule_frozen: posting rule % version % is in force and cannot change',
      OLD.event_key, OLD.version_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER c_posting_rule_frozen BEFORE UPDATE ON gl.posting_rule
  FOR EACH ROW EXECUTE FUNCTION gl.tg_posting_rule_frozen();

-- ---------------------------------------------------------------------------
-- Journals: one per posting. Insert-only.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.journal (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  number           text        NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 50),
  entry_date       date        NOT NULL,
  fiscal_period_id uuid        NOT NULL,
  event_key        text        NOT NULL CHECK (event_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  posting_rule_id  uuid,
  source_type      text        CHECK (source_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  source_id        uuid,
  description      text        NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  line_count       smallint    NOT NULL CHECK (line_count BETWEEN 2 AND 500),
  reversal_of_id   uuid,
  reason           text        CHECK (length(reason) <= 500),
  posted_by        uuid,
  posted_at        timestamptz NOT NULL DEFAULT now(),
  idempotency_key  text        CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  CONSTRAINT journal_reversal_reason_ck CHECK (reversal_of_id IS NULL OR reason IS NOT NULL),
  CONSTRAINT journal_source_ck CHECK (source_id IS NULL OR source_type IS NOT NULL),
  CONSTRAINT journal_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT journal_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT journal_period_fk FOREIGN KEY (company_id, fiscal_period_id)
    REFERENCES gl.fiscal_period (company_id, id),
  CONSTRAINT journal_rule_fk FOREIGN KEY (company_id, posting_rule_id)
    REFERENCES gl.posting_rule (company_id, id),
  CONSTRAINT journal_reversal_fk FOREIGN KEY (company_id, reversal_of_id)
    REFERENCES gl.journal (company_id, id),
  CONSTRAINT journal_not_own_reversal_ck CHECK (reversal_of_id IS NULL OR reversal_of_id <> id)
);
CREATE UNIQUE INDEX journal_number_uq ON gl.journal (company_id, number);
-- Rule 6.
CREATE UNIQUE INDEX journal_reversal_uq ON gl.journal (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
-- A module retrying the same posting gets the first journal back (posting service).
CREATE UNIQUE INDEX journal_idempotency_uq ON gl.journal (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX journal_date_idx ON gl.journal (company_id, entry_date DESC, id DESC);
CREATE INDEX journal_source_idx ON gl.journal (company_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX journal_event_idx ON gl.journal (company_id, event_key, entry_date DESC);
SELECT app.setup_table('gl', 'journal', 'company_append');

-- ---------------------------------------------------------------------------
-- Journal lines, partitioned by month of entry_date (PLAN 2.5). Primary key (id, entry_date)
-- (PLAN C17). Dimension names follow packages/shared LEDGER_DIMENSIONS.
-- ---------------------------------------------------------------------------
CREATE TABLE gl.journal_line (
  id                 uuid          NOT NULL DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL,
  company_id         uuid          NOT NULL,
  journal_id         uuid          NOT NULL,
  entry_date         date          NOT NULL,
  line_no            smallint      NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  account_id         uuid          NOT NULL,
  debit              numeric(18,4) NOT NULL DEFAULT 0,
  credit             numeric(18,4) NOT NULL DEFAULT 0,
  currency           char(3)       NOT NULL REFERENCES platform.currency (code),
  -- 1 unit of `currency` = fx_rate units of the company's base currency.
  fx_rate            numeric(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  base_debit         numeric(18,4) NOT NULL DEFAULT 0,
  base_credit        numeric(18,4) NOT NULL DEFAULT 0,
  party_id           uuid,
  employee_party_id  uuid,
  vehicle_id         uuid,
  client_platform_id uuid,
  branch_id          uuid,
  cost_centre_id     uuid,
  pay_period_id      uuid,
  loan_id            uuid,
  source_doc_type    text          CHECK (source_doc_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  source_doc_id      uuid,
  tax_code_id        uuid          NOT NULL,
  memo               text          CHECK (length(memo) <= 500),
  created_at         timestamptz   NOT NULL DEFAULT now(),
  created_by         uuid,
  PRIMARY KEY (id, entry_date),
  -- Rule 1: one side only, in the transaction currency and in base, on the same side. A base
  -- amount may round to zero for a tiny foreign amount; the transaction amount may not.
  CONSTRAINT journal_line_one_sided_ck CHECK (
    (debit > 0 AND credit = 0 AND base_debit >= 0 AND base_credit = 0)
    OR (credit > 0 AND debit = 0 AND base_credit >= 0 AND base_debit = 0)),
  CONSTRAINT journal_line_source_doc_ck CHECK (source_doc_id IS NULL OR source_doc_type IS NOT NULL),
  CONSTRAINT journal_line_journal_fk FOREIGN KEY (company_id, journal_id)
    REFERENCES gl.journal (company_id, id),
  CONSTRAINT journal_line_account_fk FOREIGN KEY (company_id, account_id)
    REFERENCES gl.account (company_id, id),
  CONSTRAINT journal_line_tax_code_fk FOREIGN KEY (company_id, tax_code_id)
    REFERENCES gl.tax_code (company_id, id),
  CONSTRAINT journal_line_cost_centre_fk FOREIGN KEY (company_id, cost_centre_id)
    REFERENCES gl.cost_centre (company_id, id),
  CONSTRAINT journal_line_branch_fk FOREIGN KEY (company_id, branch_id)
    REFERENCES platform.branch (company_id, id),
  CONSTRAINT journal_line_party_fk FOREIGN KEY (tenant_id, party_id)
    REFERENCES party.party (tenant_id, id),
  CONSTRAINT journal_line_employee_fk FOREIGN KEY (tenant_id, employee_party_id)
    REFERENCES party.party (tenant_id, id)
) PARTITION BY RANGE (entry_date);
-- Rule 2: a line number is used once per journal (entry_date is the journal's).
CREATE UNIQUE INDEX journal_line_no_uq ON gl.journal_line (journal_id, entry_date, line_no);
CREATE INDEX journal_line_account_idx ON gl.journal_line (company_id, account_id, entry_date);
CREATE INDEX journal_line_party_idx ON gl.journal_line (company_id, party_id, entry_date)
  WHERE party_id IS NOT NULL;
CREATE INDEX journal_line_employee_idx ON gl.journal_line (company_id, employee_party_id, entry_date)
  WHERE employee_party_id IS NOT NULL;
CREATE INDEX journal_line_loan_idx ON gl.journal_line (company_id, loan_id, entry_date)
  WHERE loan_id IS NOT NULL;
SELECT app.setup_table('gl', 'journal_line', 'company_append');
-- Partitions from 2024 (room for opening balances and imported history) to 15 months ahead
-- (a fiscal year can be opened early). Older history: lower start_month in a migration.
INSERT INTO app.partitioned_table (parent, start_month, months_ahead)
  VALUES ('gl.journal_line'::regclass, '2024-01-01', 15);

-- ---------------------------------------------------------------------------
-- Rule 3: period check on every journal, and the posting stamp.
-- ---------------------------------------------------------------------------
CREATE FUNCTION gl.tg_journal_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  p record;
BEGIN
  -- FOR SHARE: a concurrent close/lock (an UPDATE of this row) waits for this transaction,
  -- and this insert waits for a close that is already under way, then sees its result.
  SELECT status, start_date, end_date INTO p
    FROM gl.fiscal_period
   WHERE id = NEW.fiscal_period_id AND company_id = NEW.company_id AND deleted_at IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl_period_missing: no fiscal period % for this company', NEW.fiscal_period_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
    RAISE EXCEPTION 'gl_period_mismatch: % is outside the fiscal period % to %',
      NEW.entry_date, p.start_date, p.end_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF p.status <> 'open' THEN
    RAISE EXCEPTION 'gl_period_not_open: the fiscal period of % is %', NEW.entry_date, p.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.posted_at := now();
  NEW.posted_by := coalesce(NEW.posted_by, app.current_user_id());
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_journal_insert BEFORE INSERT ON gl.journal
  FOR EACH ROW EXECUTE FUNCTION gl.tg_journal_insert();

-- ---------------------------------------------------------------------------
-- Rule 4: each line belongs to its journal (date, company, slot) and posts to a live,
-- postable account in an allowed currency.
-- ---------------------------------------------------------------------------
CREATE FUNCTION gl.tg_journal_line_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  j record;
  a record;
BEGIN
  SELECT tenant_id, company_id, entry_date, line_count INTO j
    FROM gl.journal WHERE id = NEW.journal_id;
  IF NOT FOUND OR j.tenant_id <> NEW.tenant_id OR j.company_id <> NEW.company_id
     OR j.entry_date <> NEW.entry_date THEN
    RAISE EXCEPTION 'gl_line_journal: line does not match journal %', NEW.journal_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.line_no > j.line_count THEN
    RAISE EXCEPTION 'gl_line_count: journal % has % lines', NEW.journal_id, j.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT is_postable, deleted_at, currency_restriction, code INTO a
    FROM gl.account WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT FOUND OR a.deleted_at IS NOT NULL OR NOT a.is_postable THEN
    RAISE EXCEPTION 'gl_account_not_postable: account % cannot take postings', coalesce(a.code, NEW.account_id::text)
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.currency_restriction IS NOT NULL AND a.currency_restriction <> NEW.currency THEN
    RAISE EXCEPTION 'gl_account_currency: account % takes % only', a.code, a.currency_restriction
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_journal_line_insert BEFORE INSERT ON gl.journal_line
  FOR EACH ROW EXECUTE FUNCTION gl.tg_journal_line_insert();

-- ---------------------------------------------------------------------------
-- Rule 2: at COMMIT every journal inserted in the transaction has all its lines and
-- balances in the base currency.
-- ---------------------------------------------------------------------------
CREATE FUNCTION gl.tg_journal_balanced() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  n   integer;
  dr  numeric;
  cr  numeric;
BEGIN
  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO n, dr, cr
    FROM gl.journal_line
   WHERE journal_id = NEW.id AND entry_date = NEW.entry_date;
  IF n <> NEW.line_count THEN
    RAISE EXCEPTION 'gl_journal_incomplete: journal % has % of % lines', NEW.number, n, NEW.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  IF dr <> cr OR dr = 0 THEN
    RAISE EXCEPTION 'gl_journal_unbalanced: journal % debits % credits % (base currency)',
      NEW.number, dr, cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER z_journal_balanced AFTER INSERT ON gl.journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl.tg_journal_balanced();

SELECT app.maintain_partitions();
