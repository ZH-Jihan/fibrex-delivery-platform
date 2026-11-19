-- Phase 3, row 3.6: OCR of document scans (SPEC 5.12, PLAN 3.10 `ocr_job`).
--
-- Design notes:
--   * One ocr_job per scan read. It holds what the OCR adapter read and how sure it was, so
--     the document form can be pre-filled. NOTHING read by OCR becomes a document by itself:
--     a document is created only when a person confirms the (possibly corrected) values,
--     and then points back at the job through document.ocr_job_id.
--   * result is a JSON array of {field, value, confidence}. The document number is NOT kept
--     there in plain text: the array holds only its mask, and the number itself is sealed in
--     number_encrypted with the party identifier vault (same pattern as people.document; no
--     new crypto). number_hash is the keyed hash used to spot a duplicate document.
--   * flags is a JSON array of the warnings found at upload: low_confidence, name_mismatch,
--     expired, unreadable, cropped, duplicate.
--   * status: pending (reserved for a background provider), completed, failed (the adapter
--     errored; the user can still type the values), confirmed (a document was created).
--   * file_object_id is a plain uuid, as elsewhere for files (the files module owns them).
--   * One document per job (unique index on document.ocr_job_id).
--   * Every table: tenant and company, audit columns, version, soft delete, RLS, audit
--     trigger and no DELETE grant, through app.setup_table.

CREATE TABLE people.ocr_job (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL,
  company_id        uuid        NOT NULL,
  file_object_id    uuid        NOT NULL,
  provider          text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,59}$'),
  status            text        NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'confirmed')),
  -- Hints given at upload: the person the scan should belong to, and the expected type.
  owner_party_id    uuid,
  document_type_id  uuid,
  result            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(result) = 'array'),
  flags             jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(flags) = 'array'),
  number_encrypted  bytea,
  number_hash       text        CHECK (number_hash IS NULL OR number_hash ~ '^[0-9a-f]{64}$'),
  error             text        CHECK (error IS NULL OR length(error) <= 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           integer     NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text,
  CONSTRAINT ocr_job_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT ocr_job_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT ocr_job_type_fk FOREIGN KEY (company_id, document_type_id) REFERENCES people.document_type (company_id, id),
  CONSTRAINT ocr_job_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX ocr_job_file_idx ON people.ocr_job (company_id, file_object_id);
SELECT app.setup_table('people', 'ocr_job', 'company');

-- Additive: the job a confirmed document came from.
ALTER TABLE people.document ADD COLUMN ocr_job_id uuid;
ALTER TABLE people.document ADD CONSTRAINT document_ocr_job_fk
  FOREIGN KEY (company_id, ocr_job_id) REFERENCES people.ocr_job (company_id, id);
CREATE UNIQUE INDEX document_ocr_job_uq ON people.document (ocr_job_id) WHERE ocr_job_id IS NOT NULL;
