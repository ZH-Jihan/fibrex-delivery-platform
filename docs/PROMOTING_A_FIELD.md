# Promoting a custom field to a real column

SPEC 2.10 asks for a documented path to turn a "hot" custom field into a real, indexed column.
Custom field values live in a JSONB column (`data`), which has one general GIN index. That is
right for most fields. Promote a field only when a measured query needs it: the list is
sorted or range-filtered by it on a large table, a report joins on it, or it needs a unique or
foreign-key rule.

Promotion never moves or rewrites data and never changes the API. The value stays in JSONB,
which remains the source of truth; the database adds a generated column that mirrors it.
`field_definition.promoted_column` records the column name so list queries (row 2.5) filter
and sort on the column instead of the JSON path.

## Rules

- A developer does this in a reviewed, hand-written migration. The application role has no
  right to change tables, so there is no button that runs it. `POST /fields/:id/promote` in
  PLAN 5.9 is therefore not built as a schema-changing endpoint.
- Only a `published` field can be promoted. Its key and type never change (the API refuses
  it), so the column cannot drift from the field.
- Additive only (CLAUDE.md): add the column and index; never drop the JSONB value.

## Steps

1. Confirm the need with `EXPLAIN (ANALYZE)` on the slow query and note it in the migration.
2. Write a migration in `apps/api/prisma/migrations/`. Use the cast that fits the field type:

   | Field type | Column type | Expression |
   | --- | --- | --- |
   | text, dropdown | `text` | `data ->> 'key'` |
   | number | `bigint` | `(data ->> 'key')::bigint` |
   | decimal | `numeric(18,4)` | `(data ->> 'key')::numeric(18,4)` |
   | date | `date` | `app.iso_date(data ->> 'key')` (an immutable helper; a plain text-to-date cast is not allowed in a generated column) |
   | boolean | `boolean` | `(data ->> 'key')::boolean` |
   | file, party_ref, entity_ref | `uuid` | `(data ->> 'key')::uuid` |

   ```sql
   -- Example: custom record type "vehicle_inspection", field "inspected_on".
   ALTER TABLE cfg.custom_record
     ADD COLUMN cf_inspected_on date
     GENERATED ALWAYS AS (app.iso_date(data ->> 'inspected_on')) STORED;
   -- A partial index keeps it small: only this record type has the field.
   CREATE INDEX CONCURRENTLY custom_record_cf_inspected_on_idx
     ON cfg.custom_record (tenant_id, cf_inspected_on)
     WHERE entity_definition_id = '<id>' AND deleted_at IS NULL;
   UPDATE cfg.field_definition SET promoted_column = 'cf_inspected_on' WHERE id = '<field id>';
   ```

   Name the column `cf_<field key>`. For a custom field on a built-in table (for example
   `party.party`), alter that table instead; the steps are the same.
3. Add the column to the matching `apps/api/prisma/schema/*.prisma` model (the drift test
   enforces it) and run `pnpm db:migrate` and the integration tests.
4. On a large table, adding a stored generated column rewrites the table: run it in a
   maintenance window, and create the index `CONCURRENTLY` in its own migration.

`multi` fields are not promoted: the general GIN index already serves "contains" filters.

## Undoing

Set `promoted_column` back to NULL (queries return to the JSON path), then drop the index and
the column in a later migration. No data is lost, because the value never left `data`.

## Status

`cfg.custom_record` and the `data` column on built-in tables arrive in row 2.5, with the
query builder that reads `promoted_column`. `app.iso_date` is added by the first migration
that promotes a date field.
