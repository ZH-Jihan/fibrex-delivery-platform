-- Phase 3, row 3.7: bulk scan upload (SPEC 5.12, PLAN 3.10 `bulk_upload`, `bulk_upload_item`).
--
-- Design notes:
--   * A bulk_upload is one batch of scans dropped together. Each scan becomes one
--     bulk_upload_item with its own ocr_job (row 3.6): the OCR read, the suggested person and
--     the suggested document type. Nothing becomes a document until staff confirm the item.
--   * Suggestions are only suggestions: suggested_party_id is set when exactly one employee in
--     the company matches the holder name read; the confirm body (a normal document body) may
--     name anyone, and the normal document rules apply.
--   * Item status: pending (waiting for staff), confirmed (a document was created, document_id
--     set), rejected (staff dropped it; reject_reason kept). Status moves only from pending.
--   * bulk_upload.status is derived from its items on every change: open while any item is
--     pending, completed when none is. uploaded_count is the number of items at creation.
--   * file_object_id, ocr_job_id, suggested_party_id and document_id are plain uuids like the
--     other cross-module references (the owning modules hold the rows). The ocr_job and
--     document references point inside the same module and company, so they have real FKs.
--   * Every table: tenant and company, audit columns, version, soft delete, RLS, audit
--     trigger and no DELETE grant, through app.setup_table.

CREATE TABLE people.bulk_upload (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL,
  company_id      uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  uploaded_count  integer     NOT NULL CHECK (uploaded_count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         integer     NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  CONSTRAINT bulk_upload_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT bulk_upload_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT bulk_upload_company_id_uq UNIQUE (company_id, id)
);
SELECT app.setup_table('people', 'bulk_upload', 'company');

CREATE TABLE people.bulk_upload_item (
  id                           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                    uuid        NOT NULL,
  company_id                   uuid        NOT NULL,
  bulk_upload_id               uuid        NOT NULL,
  file_object_id               uuid        NOT NULL,
  ocr_job_id                   uuid        NOT NULL,
  suggested_party_id           uuid,
  suggested_document_type_id   uuid,
  status                       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  document_id                  uuid,
  reject_reason                text        CHECK (reject_reason IS NULL OR length(reject_reason) <= 500),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid,
  version                      integer     NOT NULL DEFAULT 1,
  deleted_at                   timestamptz,
  deleted_by                   uuid,
  delete_reason                text,
  CONSTRAINT bulk_upload_item_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  -- A confirmed item has its document; a rejected one has its reason; a pending one neither.
  CONSTRAINT bulk_upload_item_state_ck CHECK (
    (status = 'pending'   AND document_id IS NULL     AND reject_reason IS NULL) OR
    (status = 'confirmed' AND document_id IS NOT NULL AND reject_reason IS NULL) OR
    (status = 'rejected'  AND document_id IS NULL     AND reject_reason IS NOT NULL)
  ),
  CONSTRAINT bulk_upload_item_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT bulk_upload_item_upload_fk FOREIGN KEY (company_id, bulk_upload_id) REFERENCES people.bulk_upload (company_id, id),
  CONSTRAINT bulk_upload_item_job_fk FOREIGN KEY (company_id, ocr_job_id) REFERENCES people.ocr_job (company_id, id),
  CONSTRAINT bulk_upload_item_type_fk FOREIGN KEY (company_id, suggested_document_type_id) REFERENCES people.document_type (company_id, id),
  CONSTRAINT bulk_upload_item_company_id_uq UNIQUE (company_id, id)
);
CREATE INDEX bulk_upload_item_upload_idx ON people.bulk_upload_item (company_id, bulk_upload_id);
-- One item per OCR job: a scan cannot be confirmed through two items.
CREATE UNIQUE INDEX bulk_upload_item_job_uq ON people.bulk_upload_item (ocr_job_id) WHERE deleted_at IS NULL;
SELECT app.setup_table('people', 'bulk_upload_item', 'company');
