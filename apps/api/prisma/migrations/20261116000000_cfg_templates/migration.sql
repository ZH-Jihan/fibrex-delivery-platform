-- =============================================================================
-- Migration: templates and generated documents (Phase 2, row 2.7)
--
-- PLAN 3.7 `template` (S), `template_version` (S) and `generated_document` (A): the
-- letters, slips, e-mails and messages the business words itself (merge fields written in
-- Handlebars) and the record of every document produced from them.
--
-- Design notes:
--   * Templates are tenant-wide; a version may be limited to one company (company_id) or
--     serve every company (NULL). When a document is made, the company's own published
--     version wins over the tenant-wide one (TemplateService.resolve).
--   * A version is a draft until published. A published version is frozen (the API refuses
--     edits): documents already produced name the version, so it must keep meaning the
--     same text. A change is a new version (number = highest + 1 per template and
--     language). Publishing retires the version it replaces.
--   * `valid_from` lets a new wording start on a future date; resolve picks the newest
--     published version whose date has arrived.
--   * `generated_document` is insert-only. It stores which template version was used and
--     a hash of the merge data, so a document can be explained and reproduced later.
--     `file_object_id` stays NULL until the PDF worker (row 2.7b) has stored the file.
-- =============================================================================

CREATE TABLE cfg.template (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  kind          text        NOT NULL CHECK (kind IN ('pdf', 'email', 'whatsapp', 'sms', 'push')),
  entity_key    text        CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  deleted_by    uuid,
  delete_reason text,
  CONSTRAINT template_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT template_tenant_fk FOREIGN KEY (tenant_id) REFERENCES platform.tenant (id),
  CONSTRAINT template_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX template_key_uq ON cfg.template (tenant_id, key) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'template', 'tenant');

CREATE TABLE cfg.template_version (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL,
  template_id           uuid        NOT NULL,
  company_id            uuid,
  language              text        NOT NULL CHECK (language ~ '^[a-z]{2,3}$'),
  version_no            integer     NOT NULL CHECK (version_no > 0),
  subject               text        CHECK (length(subject) <= 500),
  body                  text        NOT NULL CHECK (length(body) BETWEEN 1 AND 200000),
  css                   text        NOT NULL DEFAULT '' CHECK (length(css) <= 50000),
  paper                 text        NOT NULL DEFAULT 'A4' CHECK (paper IN ('A4', 'A5', 'Letter')),
  status                text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  valid_from            date        NOT NULL DEFAULT current_date,
  provider_template_id  text        CHECK (length(provider_template_id) <= 200),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               integer     NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  deleted_by            uuid,
  delete_reason         text,
  CONSTRAINT template_version_soft_delete_ck CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT template_version_template_fk FOREIGN KEY (tenant_id, template_id) REFERENCES cfg.template (tenant_id, id),
  CONSTRAINT template_version_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT template_version_tenant_id_uq UNIQUE (tenant_id, id)
);
-- One number per template and language, across companies, so a number always names one text.
CREATE UNIQUE INDEX template_version_no_uq ON cfg.template_version (template_id, language, version_no);
CREATE INDEX template_version_lookup_idx ON cfg.template_version (template_id, language, status) WHERE deleted_at IS NULL;
SELECT app.setup_table('cfg', 'template_version', 'tenant');

CREATE TABLE cfg.generated_document (
  id                   uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id            uuid        NOT NULL,
  company_id           uuid        NOT NULL,
  template_version_id  uuid        NOT NULL,
  entity_type          text        CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$'),
  entity_id            uuid,
  file_object_id       uuid,
  data_hash            text        NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'),
  merge_data           jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(merge_data) = 'object'),
  generated_by         uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  CONSTRAINT generated_document_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company (tenant_id, id),
  CONSTRAINT generated_document_version_fk FOREIGN KEY (tenant_id, template_version_id) REFERENCES cfg.template_version (tenant_id, id),
  CONSTRAINT generated_document_file_fk FOREIGN KEY (company_id, file_object_id) REFERENCES files.file_object (company_id, id)
);
CREATE INDEX generated_document_entity_idx ON cfg.generated_document (company_id, entity_type, entity_id);
SELECT app.setup_table('cfg', 'generated_document', 'company_append');
