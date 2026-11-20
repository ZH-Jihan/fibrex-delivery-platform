/**
 * Starting data for client platforms (phase 4 row 4.1).
 *
 * Purpose: a company gets the Snoonu client platform and the metrics its Daily Report
 * carries. Both are ordinary data that administrators edit afterwards; this seed only adds
 * what is missing and never overwrites an edit.
 *
 *   - Snoonu: an organisation party with the `client` role, platform code `snoonu`, adapter
 *     `sheet`, and `cycle_start_day` 26, because Snoonu's performance month runs from the
 *     26th to the 25th (owner answer 2026-11-21, phase 4 plan section 9).
 *   - Metric definitions for the seven columns of each day block of the Daily Report
 *     (phase 4 plan section 2). Delivered (orders), Working Hours and Late Log In are the
 *     core figures the call sheet and reports use first.
 *
 * Depends on: pg (the seed's client). Used by: ./index.ts (re-export), src/seed/seed.ts.
 */
import type pg from 'pg';

export const SNOONU_CODE = 'snoonu';
/** Snoonu's performance month starts on the 26th (DECISIONS 2026-11-21). */
export const SNOONU_CYCLE_START_DAY = 26;

interface MetricSeed {
  key: string;
  label: string;
  unit: 'count' | 'percent' | 'hours' | 'minutes' | 'km';
  aggregation: 'sum' | 'avg' | 'max';
  isCore: boolean;
}

/** The day-block columns of Snoonu's Daily Report, in sheet order. */
export const SNOONU_METRICS: readonly MetricSeed[] = [
  { key: 'assigned', label: 'Assigned', unit: 'count', aggregation: 'sum', isCore: false },
  // "Orders" everywhere means Delivered, not Assigned (phase 4 plan section 9).
  { key: 'delivered', label: 'Delivered', unit: 'count', aggregation: 'sum', isCore: true },
  {
    key: 'acceptance_rate',
    label: 'Acceptance rate',
    unit: 'percent',
    aggregation: 'avg',
    isCore: false,
  },
  // Decimal hours in the sheet; stored on daily_performance as working_minutes.
  { key: 'working_hours', label: 'Working hours', unit: 'hours', aggregation: 'sum', isCore: true },
  { key: 'late_minutes', label: 'Late login', unit: 'minutes', aggregation: 'sum', isCore: true },
  { key: 'kms', label: 'Kms', unit: 'km', aggregation: 'sum', isCore: false },
  {
    key: 'avg_km_per_order',
    label: 'Average km per order',
    unit: 'km',
    aggregation: 'avg',
    isCore: false,
  },
];

/**
 * Adds the Snoonu platform (with its client party) and its metric definitions when missing.
 * Returns the platform id.
 */
export async function seedClientPlatforms(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
  companyId: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM performance.client_platform
      WHERE company_id = $1 AND code = $2 AND deleted_at IS NULL`,
    [companyId, SNOONU_CODE],
  );
  let platformId = existing.rows[0]?.id;
  if (platformId === undefined) {
    // The client is an organisation party like any other (SPEC 2.8).
    const party = await client.query<{ id: string }>(
      `INSERT INTO party.party (tenant_id, company_id, kind, display_name, names)
       VALUES ($1, $2, 'organisation', 'Snoonu', '{"en": "Snoonu"}') RETURNING id`,
      [tenantId, companyId],
    );
    const partyId = party.rows[0]?.id;
    if (partyId === undefined) throw new Error('Snoonu party was not created');
    await client.query(
      `INSERT INTO party.party_role (tenant_id, company_id, party_id, role_type)
       VALUES ($1, $2, $3, 'client')`,
      [tenantId, companyId, partyId],
    );
    const made = await client.query<{ id: string }>(
      `INSERT INTO performance.client_platform
         (tenant_id, company_id, party_id, code, name, adapter_kind, cycle_start_day)
       VALUES ($1, $2, $3, $4, 'Snoonu', 'sheet', $5) RETURNING id`,
      [tenantId, companyId, partyId, SNOONU_CODE, SNOONU_CYCLE_START_DAY],
    );
    platformId = made.rows[0]?.id;
    if (platformId === undefined) throw new Error('Snoonu platform was not created');
  }

  for (const [i, m] of SNOONU_METRICS.entries()) {
    await client.query(
      `INSERT INTO performance.metric_definition
         (tenant_id, company_id, client_platform_id, key, label, unit, aggregation, is_core, sort_order)
       SELECT $1, $2, $3, $4, jsonb_build_object('en', $5::text), $6, $7, $8, $9
       WHERE NOT EXISTS (SELECT 1 FROM performance.metric_definition
                         WHERE client_platform_id = $3 AND key = $4 AND deleted_at IS NULL)`,
      [tenantId, companyId, platformId, m.key, m.label, m.unit, m.aggregation, m.isCore, i + 1],
    );
  }
  return platformId;
}
