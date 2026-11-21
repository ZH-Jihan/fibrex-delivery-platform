/**
 * Starting notification rule for sync problems (phase 4 row 4.3).
 *
 * Purpose: when a sync run cannot use the report (source unreachable after its last retry,
 * no reader installed, empty sheet, changed layout), the sync engine raises
 * `performance.sync_problem` on the event outbox. This rule tells the administrators of the
 * company (roles `super_admin` and `admin`) in the app and by e-mail. Like every rule it is
 * tenant data: an administrator edits the text, the roles or switches it off, and this seed
 * only adds it when no rule of that name exists, so an edit is never overwritten.
 *
 * Depends on: pg (the seed's client), ./sync-service.ts (event key). Used by: ./index.ts,
 * src/seed/seed.ts, the sync tests.
 */
import type pg from 'pg';
import { SYNC_PROBLEM_EVENT } from './sync-service.js';

export const SYNC_PROBLEM_RULE_NAME = 'Performance: sync problem';

/** Adds the rule when missing; returns 1 when added, else 0. */
export async function seedSyncAlertRule(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
): Promise<number> {
  const made = await client.query(
    `INSERT INTO notify.notification_rule
       (tenant_id, company_id, name, event_type_key, channels, recipients, title_template, body_template)
     SELECT $1, NULL, $2, $3, ARRAY['in_app', 'email'], $4::jsonb, $5, $6
      WHERE NOT EXISTS (SELECT 1 FROM notify.notification_rule WHERE tenant_id = $1 AND name = $2)`,
    [
      tenantId,
      SYNC_PROBLEM_RULE_NAME,
      SYNC_PROBLEM_EVENT,
      JSON.stringify({ roleKeys: ['super_admin', 'admin'] }),
      'Sync problem: {{sourceName}} ({{businessDate}})',
      "The {{platformCode}} report could not be used ({{problem}}). {{message}} You can upload the day's Excel file from the Sync sources screen.",
    ],
  );
  return made.rowCount ?? 0;
}
