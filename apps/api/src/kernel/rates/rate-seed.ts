/**
 * Starting rate tables (PLAN 3.7 `rate_table_row` seed): the per-order rates the company
 * charges clients and pays riders and drivers, in QAR, for every platform.
 *
 *   client_rate_per_order   driver 18, rider 14
 *   pay_rate_per_order      driver 14, rider 10
 *
 * Each table is created with its rows only when the tenant does not have it yet, so the
 * seed never overwrites rates an administrator has changed. Rows start on 2026-01-01 and
 * name only `profession` (a dimension left out matches every value); platform-specific
 * rates are added as more specific rows later. Profession codes are the `profession`
 * lookup codes (kernel/lookups/lookup-seed.ts).
 *
 * Depends on: pg (the seed's transaction, tenant context already set).
 * Used by: src/seed/seed.ts (`pnpm db:seed`, and the e2e seed through it).
 */
import type pg from 'pg';

interface RateTableSeed {
  key: string;
  name: string;
  description: string;
  dimensions: string[];
  rows: { dims: Record<string, string>; value: string }[];
}

const VALID_FROM = '2026-01-01';
const CURRENCY = 'QAR';

export const RATE_SEED: RateTableSeed[] = [
  {
    key: 'client_rate_per_order',
    name: 'Client rate per order',
    description: 'What the company charges a client platform for one delivered order.',
    dimensions: ['platform', 'profession', 'vehicle_type', 'zone'],
    rows: [
      { dims: { profession: 'driver' }, value: '18' },
      { dims: { profession: 'rider' }, value: '14' },
    ],
  },
  {
    key: 'pay_rate_per_order',
    name: 'Pay rate per order',
    description: 'What a rider or driver earns for one delivered order.',
    dimensions: ['platform', 'profession', 'vehicle_type', 'zone', 'slab'],
    rows: [
      { dims: { profession: 'driver' }, value: '14' },
      { dims: { profession: 'rider' }, value: '10' },
    ],
  },
];

export async function seedRates(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
): Promise<{ tables: number; rows: number }> {
  let tables = 0;
  let rows = 0;
  for (const table of RATE_SEED) {
    const made = await client.query<{ id: string }>(
      `INSERT INTO cfg.rate_table (tenant_id, key, name, description, dimensions)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM cfg.rate_table WHERE tenant_id = $1 AND key = $2)
       RETURNING id`,
      [tenantId, table.key, table.name, table.description, table.dimensions],
    );
    const tableId = made.rows[0]?.id;
    if (tableId === undefined) continue; // already there: leave it as the administrator left it
    tables += 1;
    for (const row of table.rows) {
      await client.query(
        `INSERT INTO cfg.rate_table_row (tenant_id, rate_table_id, dims, value, currency, valid_from)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, tableId, JSON.stringify(row.dims), row.value, CURRENCY, VALID_FROM],
      );
      rows += 1;
    }
  }
  return { tables, rows };
}
