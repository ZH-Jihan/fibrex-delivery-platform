-- Phase 4, row 4.5b: Unmatched riders queue.
--
-- The queue screen shows who the sheet says the person is, so the sync keeps the details of
-- the sheet row (name, phone, driver or rider, plate, zone) next to the Falcon ID. They are
-- the sheet's own words, refreshed by every sync that sees the id; a person is created from
-- them only when someone chooses "Create employee". `ignore_reason` and `resolved_on` record
-- how a row was closed.
--
-- Additive: nullable columns only, no existing row changes.

ALTER TABLE performance.unmatched_identifier
  ADD COLUMN sheet_name       text CHECK (length(sheet_name) <= 200),
  ADD COLUMN sheet_phone      text CHECK (length(sheet_phone) <= 50),
  ADD COLUMN sheet_profession text CHECK (length(sheet_profession) <= 100),
  ADD COLUMN sheet_plate      text CHECK (length(sheet_plate) <= 50),
  ADD COLUMN sheet_zone       text CHECK (length(sheet_zone) <= 100),
  ADD COLUMN ignore_reason    text CHECK (length(ignore_reason) <= 500),
  ADD COLUMN resolved_on      date;

-- An ignored row always says why.
ALTER TABLE performance.unmatched_identifier
  ADD CONSTRAINT unmatched_identifier_ignore_ck
  CHECK ((status = 'ignored') = (ignore_reason IS NOT NULL));
