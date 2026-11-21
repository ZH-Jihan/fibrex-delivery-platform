/**
 * Starting data for the daily performance summary email (phase 4 row 4.6b).
 *
 * Purpose: a new company gets its summary settings and the tenant gets the two English email
 * templates. All of it is ordinary data an admin edits afterwards (the "Performance summary"
 * settings screen, the Templates screen); this seed only fills what is missing and never
 * overwrites an edit.
 *
 *   - Setting `performance.summary_email` (company scope): recipients = the owner address
 *     (phase 4 plan, row 4.6), on, 07:00 Asia/Qatar.
 *   - Template `performance.daily_summary`: the day's figures as a short plain-text table.
 *   - Template `performance.daily_summary_incomplete`: the "data incomplete" notice.
 *
 * Depends on: pg (the seed's client), @fibrex/shared (settings key and defaults).
 * Used by: ./index.ts (re-export), src/seed/seed.ts, the summary test.
 */
import {
  DEFAULT_SUMMARY_SETTINGS,
  SUMMARY_SETTINGS_KEY,
  type SummarySettings,
} from '@fibrex/shared';
import type pg from 'pg';
import { SUMMARY_INCOMPLETE_TEMPLATE_KEY, SUMMARY_TEMPLATE_KEY } from './summary-service.js';

/** The owner's default recipient (phase 4 plan, row 4.6). Editable afterwards. */
export const OWNER_SUMMARY_RECIPIENTS: readonly string[] = ['fibrextrading@gmail.com'];

export const SUMMARY_SUBJECT = 'Performance summary {{date}}: {{totalOrders}} orders';
export const SUMMARY_BODY = `Performance summary for {{companyName}}
Date: {{date}} ({{platformName}})

People with orders: {{peopleWithOrders}}
Total orders: {{totalOrders}}
Total active hours: {{totalHours}}
People with zero orders: {{zeroOrders}}

5 best by orders
#  | Name | Orders | Hours
{{#each best}}
{{rank}}  | {{name}} | {{orders}} | {{hours}}
{{/each}}

5 weakest by orders
#  | Name | Orders | Hours
{{#each worst}}
{{rank}}  | {{name}} | {{orders}} | {{hours}}
{{/each}}
{{#if unmatched}}

Note: {{unmatched}} platform ID(s) are still unmatched, so their figures are not in this summary. Open Performance, Unmatched riders to link them.
{{/if}}
`;

export const SUMMARY_INCOMPLETE_SUBJECT = 'Performance summary {{date}}: data incomplete';
export const SUMMARY_INCOMPLETE_BODY = `Performance summary for {{companyName}}
Date: {{date}} ({{platformName}})

DATA INCOMPLETE. The figures for this date could not be trusted, so none are shown.
{{reason}}

Open Performance, Sync runs to check the sync, or upload the day's Excel file. This summary is sent once per date and will not be sent again.
{{#if unmatched}}

Also: {{unmatched}} platform ID(s) are still unmatched.
{{/if}}
`;

const TEMPLATES = [
  {
    key: SUMMARY_TEMPLATE_KEY,
    name: 'Performance: daily summary',
    subject: SUMMARY_SUBJECT,
    body: SUMMARY_BODY,
  },
  {
    key: SUMMARY_INCOMPLETE_TEMPLATE_KEY,
    name: 'Performance: daily summary (data incomplete)',
    subject: SUMMARY_INCOMPLETE_SUBJECT,
    body: SUMMARY_INCOMPLETE_BODY,
  },
] as const;

/** Adds the company's settings and the tenant's templates when missing; returns rows added. */
export async function seedPerformanceSummary(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
  companyId: string,
  recipients: readonly string[] = OWNER_SUMMARY_RECIPIENTS,
): Promise<number> {
  const settings: SummarySettings = { ...DEFAULT_SUMMARY_SETTINGS, recipients: [...recipients] };
  let added = 0;
  const setting = await client.query(
    `INSERT INTO platform.setting (tenant_id, company_id, scope, key, value)
     SELECT $1, $2, 'company', $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM platform.setting
                       WHERE company_id = $2 AND scope = 'company' AND key = $3 AND deleted_at IS NULL)`,
    [tenantId, companyId, SUMMARY_SETTINGS_KEY, JSON.stringify(settings)],
  );
  added += setting.rowCount ?? 0;
  for (const template of TEMPLATES) {
    const made = await client.query<{ id: string }>(
      `INSERT INTO cfg.template (tenant_id, key, kind, name)
       SELECT $1, $2, 'email', $3
       WHERE NOT EXISTS (SELECT 1 FROM cfg.template
                         WHERE tenant_id = $1 AND key = $2 AND deleted_at IS NULL)
       RETURNING id`,
      [tenantId, template.key, template.name],
    );
    const templateId = made.rows[0]?.id;
    // The template exists already (an admin may have edited or replaced its text): leave it.
    if (templateId === undefined) continue;
    await client.query(
      `INSERT INTO cfg.template_version
         (tenant_id, template_id, company_id, language, version_no, subject, body, status, valid_from)
       VALUES ($1, $2, NULL, 'en', 1, $3, $4, 'published', current_date)`,
      [tenantId, templateId, template.subject, template.body],
    );
    added += 2;
  }
  return added;
}
