/**
 * Starting ledger set-up for a company (phase 2 row 2.14; DECISIONS 2026-11-15 "Chart of
 * accounts"): a standard chart for a manpower and delivery service company in QAR, the tax
 * code NONE (0 %, the default), the common home currencies of the workforce, and the
 * current fiscal year with its periods.
 *
 * Everything is added only where the company has none yet (no accounts -> the chart; no tax
 * code -> NONE; no fiscal year -> this year), so running the seed again never overwrites
 * what an administrator has changed. The chart is data: administrators extend, rename or
 * retire accounts from settings.
 *
 * Header accounts (codes ending in 00) are not postable; the accounts under them are.
 * Control accounts (receivables, payables, loans to workers, salaries payable) require a
 * party on every line so their sub-ledgers add up (row 2.15 enforces it).
 *
 * Depends on: pg (the seed's transaction), @fibrex/shared (fiscalPeriods).
 * Used by: src/seed/seed.ts (`pnpm db:seed`, and the e2e seed through it).
 */
import { fiscalPeriods, type AccountType } from '@fibrex/shared';
import type pg from 'pg';

interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  /** Code of the header above it; none for the five top headers. */
  parent?: string;
  header?: boolean;
  control?: boolean;
}

const A = 'asset';
const L = 'liability';
const E = 'equity';
const I = 'income';
const X = 'expense';

/** Parents always come before their children in this list. */
export const STANDARD_CHART: readonly AccountSeed[] = [
  { code: '1000', name: 'Assets', type: A, header: true },
  { code: '1100', name: 'Cash and bank', type: A, parent: '1000', header: true },
  { code: '1110', name: 'Cash on hand', type: A, parent: '1100' },
  { code: '1120', name: 'Bank accounts', type: A, parent: '1100' },
  { code: '1130', name: 'Cards and wallets', type: A, parent: '1100' },
  { code: '1200', name: 'Receivables', type: A, parent: '1000', header: true },
  {
    code: '1210',
    name: 'Trade receivables (client platforms)',
    type: A,
    parent: '1200',
    control: true,
  },
  { code: '1220', name: 'Loans and advances to workers', type: A, parent: '1200', control: true },
  { code: '1230', name: 'Other receivables', type: A, parent: '1200' },
  { code: '1300', name: 'Prepayments and deposits', type: A, parent: '1000', header: true },
  { code: '1310', name: 'Prepaid expenses', type: A, parent: '1300' },
  { code: '1320', name: 'Deposits paid', type: A, parent: '1300' },
  { code: '1400', name: 'Inventory', type: A, parent: '1000', header: true },
  { code: '1410', name: 'Uniforms and equipment', type: A, parent: '1400' },
  { code: '1500', name: 'Fixed assets', type: A, parent: '1000', header: true },
  { code: '1510', name: 'Vehicles', type: A, parent: '1500' },
  { code: '1520', name: 'Furniture and office equipment', type: A, parent: '1500' },
  { code: '1590', name: 'Accumulated depreciation', type: A, parent: '1500' },

  { code: '2000', name: 'Liabilities', type: L, header: true },
  { code: '2100', name: 'Payables', type: L, parent: '2000', header: true },
  { code: '2110', name: 'Trade payables (suppliers)', type: L, parent: '2100', control: true },
  { code: '2120', name: 'Salaries payable', type: L, parent: '2100', control: true },
  { code: '2130', name: 'Accrued expenses', type: L, parent: '2100' },
  { code: '2200', name: 'Other liabilities', type: L, parent: '2000', header: true },
  { code: '2210', name: 'Deposits received', type: L, parent: '2200' },
  { code: '2220', name: 'End-of-service benefits provision', type: L, parent: '2200' },
  { code: '2230', name: 'Loans from investors', type: L, parent: '2200', control: true },
  { code: '2300', name: 'Taxes', type: L, parent: '2000', header: true },
  { code: '2310', name: 'Tax payable', type: L, parent: '2300' },

  { code: '3000', name: 'Equity', type: E, header: true },
  { code: '3100', name: 'Share capital', type: E, parent: '3000' },
  { code: '3200', name: 'Retained earnings', type: E, parent: '3000' },
  { code: '3300', name: "Owners' current account", type: E, parent: '3000' },

  { code: '4000', name: 'Income', type: I, header: true },
  { code: '4100', name: 'Delivery service income', type: I, parent: '4000' },
  { code: '4200', name: 'Manpower supply income', type: I, parent: '4000' },
  { code: '4900', name: 'Other income', type: I, parent: '4000' },
  { code: '4910', name: 'Foreign exchange gains', type: I, parent: '4000' },

  { code: '5000', name: 'Cost of services', type: X, header: true },
  { code: '5100', name: 'Rider and driver pay', type: X, parent: '5000' },
  { code: '5200', name: 'Overtime and incentives', type: X, parent: '5000' },
  { code: '5300', name: 'Fuel', type: X, parent: '5000' },
  { code: '5400', name: 'Vehicle rent and maintenance', type: X, parent: '5000' },
  { code: '5500', name: 'Visas, permits and medical', type: X, parent: '5000' },

  { code: '6000', name: 'Operating expenses', type: X, header: true },
  { code: '6100', name: 'Office salaries', type: X, parent: '6000' },
  { code: '6200', name: 'Rent', type: X, parent: '6000' },
  { code: '6300', name: 'Utilities and telecom', type: X, parent: '6000' },
  { code: '6400', name: 'Insurance', type: X, parent: '6000' },
  { code: '6500', name: 'Bank charges', type: X, parent: '6000' },
  { code: '6600', name: 'Depreciation', type: X, parent: '6000' },
  { code: '6700', name: 'End-of-service benefits', type: X, parent: '6000' },
  { code: '6900', name: 'Other expenses', type: X, parent: '6000' },
  { code: '6910', name: 'Foreign exchange losses', type: X, parent: '6000' },
  { code: '6920', name: 'Rounding differences', type: X, parent: '6000' },
];

/** Home currencies of the workforce, for exchange rates (QAR is seeded with the company). */
const CURRENCIES: readonly [string, string][] = [
  ['USD', 'US Dollar'],
  ['BDT', 'Bangladeshi Taka'],
  ['INR', 'Indian Rupee'],
  ['NPR', 'Nepalese Rupee'],
  ['PKR', 'Pakistani Rupee'],
];

export interface LedgerSeedResult {
  accounts: number;
  taxCodes: number;
  fiscalYears: number;
}

/** Seeds one company. `today` decides which fiscal year is created (tests pass a date). */
export async function seedLedger(
  client: Pick<pg.PoolClient, 'query'>,
  tenantId: string,
  companyId: string,
  today: Date = new Date(),
): Promise<LedgerSeedResult> {
  const result: LedgerSeedResult = { accounts: 0, taxCodes: 0, fiscalYears: 0 };
  for (const [code, name] of CURRENCIES) {
    await client.query(
      `INSERT INTO platform.currency (code, name, minor_units) VALUES ($1, $2, 2)
       ON CONFLICT (code) DO NOTHING`,
      [code, name],
    );
  }

  const has = async (table: string) =>
    ((
      await client.query(
        `SELECT 1 FROM gl.${table} WHERE company_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [companyId],
      )
    ).rowCount ?? 0) > 0;

  if (!(await has('account'))) {
    const ids = new Map<string, string>();
    for (const a of STANDARD_CHART) {
      const made = await client.query<{ id: string }>(
        `INSERT INTO gl.account (tenant_id, company_id, code, name, type, parent_id, is_postable,
                                 is_control, requires_dimensions)
         VALUES ($1, $2, $3, jsonb_build_object('en', $4::text), $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          tenantId,
          companyId,
          a.code,
          a.name,
          a.type,
          a.parent === undefined ? null : (ids.get(a.parent) ?? null),
          a.header !== true,
          a.control === true,
          a.control === true ? ['party'] : [],
        ],
      );
      const id = made.rows[0]?.id;
      if (id !== undefined) ids.set(a.code, id);
      result.accounts += 1;
    }
  }

  if (!(await has('tax_code'))) {
    await client.query(
      `INSERT INTO gl.tax_code (tenant_id, company_id, code, name, rate, is_default)
       VALUES ($1, $2, 'NONE', 'No tax', 0, true)`,
      [tenantId, companyId],
    );
    result.taxCodes = 1;
  }

  if (!(await has('fiscal_year'))) {
    const company = await client.query<{ month: number }>(
      `SELECT fiscal_year_start_month AS month FROM platform.company WHERE id = $1`,
      [companyId],
    );
    // The year that contains `today`, starting on the company's first month (January unless
    // the owner set another month).
    const month = (company.rows[0]?.month ?? 1) - 1;
    const year = today.getUTCMonth() >= month ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
    const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(year + 1, month, 0)).toISOString().slice(0, 10);
    const name = month === 0 ? `FY ${String(year)}` : `FY ${String(year)}-${String(year + 1)}`;
    const made = await client.query<{ id: string }>(
      `INSERT INTO gl.fiscal_year (tenant_id, company_id, name, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, companyId, name, start, end],
    );
    for (const p of fiscalPeriods(start, end)) {
      await client.query(
        `INSERT INTO gl.fiscal_period (tenant_id, company_id, fiscal_year_id, period_no, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, companyId, made.rows[0]?.id, p.periodNo, p.startDate, p.endDate],
      );
    }
    result.fiscalYears = 1;
  }
  return result;
}
