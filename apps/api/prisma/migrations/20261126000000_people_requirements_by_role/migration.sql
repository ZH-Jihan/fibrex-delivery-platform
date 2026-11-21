-- Phase 3, row 3.13: document requirements by role.
--
-- The standard requirements seeded in row 3.2 had no profession, so they applied to every
-- employee and flagged office staff for a driving licence and food handling certificate.
-- New rule: QID and passport apply to everyone; driving licence, food handling certificate,
-- health card, insurance (and agreement, only for outside sponsorship) apply to the
-- professions rider and driver. No schema change: `applies_to_profession` already exists, and
-- an employee with no rider or driver placement has an empty profession, which matches only
-- the requirements that name no profession.
--
-- Additive and idempotent (safe to run twice, never duplicates):
--   1. every live requirement of one of those five types with no profession becomes the
--      `rider` requirement (same row, so its history and any edits are kept);
--   2. a `driver` copy is added where the company has none for that type and condition.
-- A requirement an administrator already tied to a profession (or soft-deleted) is not touched.

UPDATE people.document_requirement r
   SET applies_to_profession = 'rider'
  FROM people.document_type t
 WHERE t.id = r.document_type_id
   AND t.code IN ('driving_licence', 'food_handling', 'health_card', 'insurance', 'agreement')
   AND r.applies_to_profession IS NULL
   AND r.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM people.document_requirement x
                    WHERE x.document_type_id = r.document_type_id
                      AND x.applies_to_profession = 'rider' AND x.deleted_at IS NULL);

INSERT INTO people.document_requirement
  (tenant_id, company_id, document_type_id, condition_expr, applies_to_profession)
SELECT r.tenant_id, r.company_id, r.document_type_id, r.condition_expr, 'driver'
  FROM people.document_requirement r
  JOIN people.document_type t ON t.id = r.document_type_id
 WHERE t.code IN ('driving_licence', 'food_handling', 'health_card', 'insurance', 'agreement')
   AND r.applies_to_profession = 'rider'
   AND r.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM people.document_requirement x
                    WHERE x.document_type_id = r.document_type_id
                      AND x.applies_to_profession = 'driver' AND x.deleted_at IS NULL);
