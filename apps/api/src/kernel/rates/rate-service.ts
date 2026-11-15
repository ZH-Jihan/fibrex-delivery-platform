/**
 * Rate service: which rate applies to a set of dimension values on a day.
 *
 * Purpose: answers `GET /rate-tables/{key}/resolve` and gives the formula engine its
 * `rate()` lookup. Modules (billing, payroll) read rates through formulas or this service,
 * never from the table directly, so the matching rule is the same everywhere.
 *
 * How a lookup works, step by step:
 *   1. Read the table by key (live tables only).
 *   2. Read its live rows in force on the day (valid_from <= day <= valid_to, open ended
 *      when valid_to is empty). Effective dating (SPEC 2.10) makes a past day give the
 *      rate that applied then.
 *   3. Pick the row with the shared rule `pickRateRow` (packages/shared/src/rates): a
 *      dimension a row leaves out matches anything, the most specific row wins.
 *
 * For formulas the rows of every table the formula names are read before evaluation
 * (`lookupFor`), because the engine runs synchronously and has no I/O of its own.
 * Runs inside the caller's unit of work (row-level security applies).
 *
 * Depends on: @fibrex/shared (pickRateRow), @fibrex/formula (FormulaError, RateLookup),
 * kernel/db unit of work.
 * Used by: ./rate-router.ts, kernel/formulas (FormulaService), later billing and payroll.
 */
import { FormulaError, type RateLookup } from '@fibrex/formula';
import { pickRateRow } from '@fibrex/shared';
import type { Db } from '../db/prisma.js';
import { currentUnit } from '../db/unit-of-work.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

export type RateTableRecord = NonNullable<Awaited<ReturnType<Db['rateTable']['findFirst']>>>;
export type RateRowRecord = NonNullable<Awaited<ReturnType<Db['rateTableRow']['findFirst']>>>;

export interface ResolvedRate {
  table: RateTableRecord;
  row: RateRowRecord;
  /** Exact text with 4 decimals, as NUMERIC(18,4) holds it. */
  value: string;
}

/** A row's value as exact text with its 4 decimals ("18.0000"). */
export const rateValueText = (row: RateRowRecord): string => row.value.toFixed(4);

const dimsOf = (row: RateRowRecord) => row.dims as Record<string, string>;

export class RateService {
  async table(key: string): Promise<RateTableRecord> {
    const table = await currentUnit().db.rateTable.findFirst({ where: { key, deletedAt: null } });
    if (table === null) throw new NotFoundError(`No rate table "${key}".`);
    return table;
  }

  /** Step 2: the table's live rows in force on `onDate`. */
  async rowsInForce(tableId: string, onDate: Date): Promise<RateRowRecord[]> {
    return currentUnit().db.rateTableRow.findMany({
      where: {
        rateTableId: tableId,
        deletedAt: null,
        validFrom: { lte: onDate },
        OR: [{ validTo: null }, { validTo: { gte: onDate } }],
      },
      orderBy: { validFrom: 'asc' },
    });
  }

  /** The rate for `dims` on `onDate`: 404 when none applies, 400 for an unknown dimension. */
  async resolve(key: string, dims: Record<string, string>, onDate: Date): Promise<ResolvedRate> {
    const table = await this.table(key);
    const picked = pickRateRow(
      table.dimensions,
      (await this.rowsInForce(table.id, onDate)).map((row) => ({ row, dims: dimsOf(row) })),
      dims,
    );
    if (!picked.ok) {
      if (picked.code === 'rate_unknown_dimension') {
        throw new ValidationError([{ path: 'dims', message: picked.message, code: picked.code }]);
      }
      throw new NotFoundError(
        `${picked.message} (table "${key}", ${onDate.toISOString().slice(0, 10)})`,
      );
    }
    return { table, row: picked.row.row, value: rateValueText(picked.row.row) };
  }

  /**
   * The `rate()` lookup for a formula: reads the rows of `keys` in force on `onDate` now,
   * then answers synchronously. A missing table or value is a formula runtime error, raised
   * only when the formula really asks for it (a branch not taken costs nothing).
   */
  async lookupFor(keys: readonly string[], onDate: Date): Promise<RateLookup> {
    const loaded = new Map<string, { dimensions: string[]; rows: RateRowRecord[] }>();
    for (const key of keys) {
      const table = await currentUnit().db.rateTable.findFirst({
        where: { key, deletedAt: null },
      });
      if (table !== null) {
        loaded.set(key, {
          dimensions: table.dimensions,
          rows: await this.rowsInForce(table.id, onDate),
        });
      }
    }
    const day = onDate.toISOString().slice(0, 10);
    return (key, dims) => {
      const table = loaded.get(key);
      if (table === undefined) throw new FormulaError('formula_runtime', `No rate table "${key}".`);
      const picked = pickRateRow(
        table.dimensions,
        table.rows.map((row) => ({ row, dims: dimsOf(row) })),
        dims,
      );
      if (!picked.ok) {
        throw new FormulaError('formula_runtime', `${picked.message} (table "${key}", ${day})`);
      }
      const row = picked.row.row;
      return { value: rateValueText(row), currency: row.currency, rowId: row.id };
    };
  }
}
