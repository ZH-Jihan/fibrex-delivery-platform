/**
 * Starting lookup lists for a tenant (phase 2 row 2.3; the types named in PLAN 3.7).
 *
 * Purpose: gives a new tenant the dropdowns the first modules need. They are ordinary data
 * rows: administrators rename, reorder, retire and add values on the Lookups screen, and
 * nothing here runs again over their edits.
 *
 * Idempotent and respectful of edits: a list or a value is inserted only when no row with
 * that key (or code in that list) exists, deleted rows included, so a value an administrator
 * deleted does not come back at the next seed. Lists are flagged `is_system` so they cannot
 * be deleted (their values can be retired).
 *
 * All text is generic and invented. Only English labels are seeded; other languages are
 * added on the screen.
 *
 * Depends on: pg. Used by: src/seed/seed.ts (development and CI seed), future tenant
 * onboarding.
 */
import type pg from 'pg';

export interface LookupSeedType {
  key: string;
  name: string;
  allowHierarchy?: boolean;
  /** [code, English label] in display order. */
  values: readonly (readonly [string, string])[];
}

export const LOOKUP_SEED: readonly LookupSeedType[] = [
  {
    key: 'client_platform_type',
    name: 'Client platform types',
    values: [
      ['delivery_app', 'Delivery app'],
      ['ride_hailing', 'Ride hailing'],
      ['logistics', 'Logistics'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'profession',
    name: 'Professions',
    values: [
      ['rider', 'Rider'],
      ['driver', 'Driver'],
    ],
  },
  {
    key: 'document_category',
    name: 'Document categories',
    values: [
      ['identity', 'Identity'],
      ['residency', 'Visa and residency'],
      ['licence', 'Licence'],
      ['contract', 'Contract'],
      ['medical', 'Medical'],
      ['vehicle', 'Vehicle'],
      ['financial', 'Financial'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'merchandise_category',
    name: 'Merchandise categories',
    values: [
      ['uniform', 'Uniform'],
      ['helmet', 'Helmet'],
      ['bag', 'Delivery bag'],
      ['jacket', 'Jacket'],
      ['accessory', 'Accessory'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'expense_type',
    name: 'Expense types',
    values: [
      ['fuel', 'Fuel'],
      ['maintenance', 'Maintenance'],
      ['accommodation', 'Accommodation'],
      ['government_fees', 'Government fees'],
      ['fines', 'Fines'],
      ['office', 'Office'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'loan_purpose',
    name: 'Loan purposes',
    values: [
      ['personal', 'Personal'],
      ['emergency', 'Emergency'],
      ['medical', 'Medical'],
      ['travel', 'Travel'],
      ['education', 'Education'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'status_reason',
    name: 'Status reasons',
    values: [
      ['resigned', 'Resigned'],
      ['terminated', 'Terminated'],
      ['absconded', 'Absconded'],
      ['contract_ended', 'Contract ended'],
      ['on_leave', 'On leave'],
      ['transferred', 'Transferred'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'payment_method',
    name: 'Payment methods',
    values: [
      ['cash', 'Cash'],
      ['bank_transfer', 'Bank transfer'],
      ['cheque', 'Cheque'],
      ['card', 'Card'],
      ['mobile_wallet', 'Mobile wallet'],
    ],
  },
  {
    key: 'call_outcome',
    name: 'Call outcomes',
    values: [
      ['answered', 'Answered'],
      ['no_answer', 'No answer'],
      // SPEC 3.3 (call sheet): answered, no answer, switched off. Added in row 4.7.
      ['switched_off', 'Switched off'],
      ['busy', 'Busy'],
      ['wrong_number', 'Wrong number'],
      ['call_back_later', 'Call back later'],
      ['interested', 'Interested'],
      ['not_interested', 'Not interested'],
    ],
  },
  {
    key: 'vehicle_type',
    name: 'Vehicle types',
    values: [
      ['motorbike', 'Motorbike'],
      ['car', 'Car'],
      ['van', 'Van'],
      ['bicycle', 'Bicycle'],
    ],
  },
];

/** Adds the starting lists and values to one tenant. Returns how many rows it inserted. */
export async function seedLookups(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
): Promise<{ types: number; values: number }> {
  let types = 0;
  let values = 0;
  for (const type of LOOKUP_SEED) {
    const exists = await client.query<{ id: string }>(
      `SELECT id FROM cfg.lookup_type WHERE tenant_id = $1 AND key = $2
       ORDER BY deleted_at NULLS FIRST LIMIT 1`,
      [tenantId, type.key],
    );
    let typeId = exists.rows[0]?.id;
    if (typeId === undefined) {
      const made = await client.query<{ id: string }>(
        `INSERT INTO cfg.lookup_type (tenant_id, key, name, is_system, allow_hierarchy)
         VALUES ($1, $2, $3, true, $4) RETURNING id`,
        [tenantId, type.key, type.name, type.allowHierarchy ?? false],
      );
      typeId = made.rows[0]?.id;
      types += 1;
    }
    if (typeId === undefined) throw new Error(`Seed: lookup type ${type.key} was not created`);
    for (const [index, [code, label]] of type.values.entries()) {
      const inserted = await client.query(
        `INSERT INTO cfg.lookup_value (tenant_id, lookup_type_id, code, labels, sort_order)
         SELECT $1, $2, $3, jsonb_build_object('en', $4::text), $5
         WHERE NOT EXISTS (SELECT 1 FROM cfg.lookup_value WHERE lookup_type_id = $2 AND code = $3)`,
        [tenantId, typeId, code, label, (index + 1) * 10],
      );
      values += inserted.rowCount ?? 0;
    }
  }
  return { types, values };
}
