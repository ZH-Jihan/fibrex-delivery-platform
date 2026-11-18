-- =============================================================================
-- Migration: manual journals (Phase 2, row 2.15b)
--
-- PLAN 3.9 `manual_journal` (S): journals an accountant writes by hand. They live here as
-- drafts (editable, may be unbalanced while being written) and reach the ledger only through
-- the posting service (modules/gl/posting-service.ts), which writes gl.journal and its lines
-- with every check. This table never holds money itself; `journal_id` points at the posted
-- journal.
--
-- What the database enforces:
--   1. A row is `posted` exactly when it names its journal (CHECK), and one journal is named
--      by at most one manual journal (unique index).
--   2. A posted manual journal never changes and cannot be deleted (trigger); a correction
--      is a reversal of its journal (POST /journals/{id}/reverse).
--   3. posted_at / posted_by are stamped by the database when the status becomes posted.
-- `submitted` is accepted by the CHECK for the approval step a later row binds through the
-- workflow engine; the API of row 2.15b moves draft -> posted only.
-- =============================================================================

CREATE TABLE gl.manual_journal (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  company_id    uuid        NOT NULL,
  number        text        NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 50),
  entry_date    date        NOT NULL,
  description   text        NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  -- Line shape checked by the API (packages/shared ledger/journal.ts manualJournalLineSchema).
  lines         jsonb       NOT NULL DEFAULT '[]'
                CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 500),
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'posted')),
  journal_id    uuid,
  posted_at     timestamptz,
  posted_by     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT manual_journal_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- Rule 1.
  CONSTRAINT manual_journal_posted_ck CHECK ((status = 'posted') = (journal_id IS NOT NULL)),
  CONSTRAINT manual_journal_company_fk FOREIGN KEY (tenant_id, company_id)
    REFERENCES platform.company (tenant_id, id),
  CONSTRAINT manual_journal_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT manual_journal_journal_fk FOREIGN KEY (company_id, journal_id)
    REFERENCES gl.journal (company_id, id)
);
-- Numbers come from the gapless sequence `gl.manual_journal`; deleted drafts keep theirs.
CREATE UNIQUE INDEX manual_journal_number_uq ON gl.manual_journal (company_id, number);
CREATE UNIQUE INDEX manual_journal_journal_uq ON gl.manual_journal (journal_id)
  WHERE journal_id IS NOT NULL;
CREATE INDEX manual_journal_list_idx ON gl.manual_journal (company_id, status, entry_date DESC)
  WHERE deleted_at IS NULL;
SELECT app.setup_table('gl', 'manual_journal', 'company');

-- Rules 2 and 3.
CREATE FUNCTION gl.tg_manual_journal_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'gl_manual_journal_posted: manual journal % is posted and cannot change', OLD.number
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'posted' THEN
    NEW.posted_at := now();
    NEW.posted_by := app.current_user_id();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER c_manual_journal_update BEFORE UPDATE ON gl.manual_journal
  FOR EACH ROW EXECUTE FUNCTION gl.tg_manual_journal_update();

-- A posted row always carries its posting stamp.
ALTER TABLE gl.manual_journal ADD CONSTRAINT manual_journal_posted_stamp_ck
  CHECK (status <> 'posted' OR posted_at IS NOT NULL);
