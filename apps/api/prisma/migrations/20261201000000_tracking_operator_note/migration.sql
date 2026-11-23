-- Phase 4 row 4.8b: a free-text note on an ID-operator period (why the handover, what was agreed).
-- Additive and nullable (expand step): existing rows and the 4.7 API keep working unchanged.
ALTER TABLE tracking.id_operator_period ADD COLUMN note text;
