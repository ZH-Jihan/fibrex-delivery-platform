/**
 * Starting data for the document expiry engine (phase 3 row 3.4).
 *
 * Purpose: a new company gets its expiry alert settings and a notification rule for the
 * in-app alerts. Both are ordinary data the admin edits afterwards (the expiry settings
 * endpoint, the notification rule screens); this seed only fills what is missing and never
 * overwrites an edit.
 *
 *   - Setting `people.expiry_alerts` (company scope): the email list the owner gave on
 *     2026-11-19 and the default windows 14 and 7 days (phase 3 plan section 8).
 *   - Rule "Documents: expiring soon": `people.documents_expiring` to the admin and manager
 *     roles, in the app only (expired documents are never emailed; the consolidated email
 *     goes to the list above, not through rules).
 *
 * Depends on: pg (the seed's client), @fibrex/shared (settings key and defaults).
 * Used by: ./index.ts (re-export), src/seed/seed.ts.
 */
import { DEFAULT_EXPIRY_SETTINGS, EXPIRY_SETTINGS_KEY, type ExpirySettings } from '@fibrex/shared';
import type pg from 'pg';
import { EXPIRY_EVENT } from './expiry-service.js';

/** The owner's expiry email list (phase 3 plan section 9, answer 1). Editable afterwards. */
export const OWNER_EXPIRY_EMAILS: readonly string[] = [
  'fibrextrading@gmail.com',
  'zakirjihan222@gmail.com',
];

export const EXPIRY_RULE_NAME = 'Documents: expiring soon';

/** Adds the company's settings and the tenant's rule when missing; returns how many rows. */
export async function seedExpiryAlerts(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
  companyId: string,
  emails: readonly string[] = OWNER_EXPIRY_EMAILS,
): Promise<number> {
  const settings: ExpirySettings = { ...DEFAULT_EXPIRY_SETTINGS, emails: [...emails] };
  const setting = await client.query(
    `INSERT INTO platform.setting (tenant_id, company_id, scope, key, value)
     SELECT $1, $2, 'company', $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM platform.setting
                       WHERE company_id = $2 AND scope = 'company' AND key = $3 AND deleted_at IS NULL)`,
    [tenantId, companyId, EXPIRY_SETTINGS_KEY, JSON.stringify(settings)],
  );
  const rule = await client.query(
    `INSERT INTO notify.notification_rule
       (tenant_id, name, event_type_key, channels, recipients, title_template, body_template)
     SELECT $1, $2, $3, ARRAY['in_app'], $4, $5, $6
     WHERE NOT EXISTS (SELECT 1 FROM notify.notification_rule
                       WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL)`,
    [
      tenantId,
      EXPIRY_RULE_NAME,
      EXPIRY_EVENT,
      JSON.stringify({ roleKeys: ['admin', 'manager'] }),
      'Documents: {{expiringCount}} expiring soon, {{expiredCount}} expired',
      'Open Documents > Expiring soon to see and renew them ({{date}}).',
    ],
  );
  return (setting.rowCount ?? 0) + (rule.rowCount ?? 0);
}
