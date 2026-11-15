/**
 * Numbering service (PLAN 3.1 `number_sequence`, SPEC 2.12): human-readable numbers such as
 * `L0001` or `INV-2026-00042`, one sequence per company and key, never reused.
 *
 * How a number is allocated, and why this way:
 *   1. `allocate()` runs inside the caller's unit of work, in the same transaction as the
 *      record that receives the number. If that insert fails, the transaction rolls back
 *      and the counter with it, so there is no gap and the number is given out next time.
 *   2. The sequence row is read with `SELECT ... FOR UPDATE`. Two requests allocating at
 *      once queue on the row lock; the second sees the first's committed counter. Gapless
 *      and unique under concurrency comes from the lock, not from code.
 *   3. Reset rules: a yearly or monthly sequence restarts at 1 when the allocation date
 *      falls in a new period. The period of the last allocation is kept in
 *      `last_reset_at`; the pattern must carry the year (and month) so numbers of
 *      different periods never collide (checked by the shared `patternProblem`).
 *   4. `next_value` only ever moves forward through this service. Lowering it, deleting a
 *      sequence and recreating the key, or editing numbers by hand are refused by the
 *      repository in numbering-router.ts.
 *   5. A missing sequence is an error unless the caller supplies defaults: a module that
 *      owns a key (loans, payslips ...) names its default pattern on the first allocation
 *      and the row is created then; administrators change it afterwards on the settings
 *      screen. Keys are data, not code: the service never lists them.
 *
 * Row-level security applies to the raw statements as to any other: the unit of work has
 * set the tenant and company context before this code runs.
 *
 * Depends on: kernel/db/unit-of-work.ts, kernel/http/errors.ts, @fibrex/shared numbering.
 * Used by: numbering-router.ts (preview), later modules that number their records
 * (custom records 2.5, loans, payslips, invoices).
 */
import {
  patternProblem,
  renderNumber,
  resetPeriod,
  type ResetPolicy,
} from '@fibrex/shared';
import { currentUnit } from '../db/unit-of-work.js';
import { BadRequestError, UnprocessableError } from '../http/errors.js';

export interface SequenceDefaults {
  format: string;
  prefix?: string;
  padding?: number;
  resetPolicy?: ResetPolicy;
}

export interface AllocateOptions {
  /** The company the record belongs to; needed when the session spans several. */
  companyId?: string;
  /** The date the number is for (defaults to now); drives the year and month tokens. */
  date?: Date;
  /** Creates the sequence with these settings when the key has none yet (rule 5). */
  defaults?: SequenceDefaults;
}

export interface AllocatedNumber {
  /** The rendered number, e.g. `L0001`. */
  number: string;
  /** The running value behind it. */
  value: bigint;
  sequenceId: string;
}

interface SequenceRow {
  id: string;
  prefix: string;
  padding: number;
  next_value: bigint;
  reset_policy: ResetPolicy;
  format: string;
  last_reset_at: Date | null;
}

/** Rule 3: the value to give out now, given what the row says about the last allocation. */
export function nextValueFor(
  row: Pick<SequenceRow, 'next_value' | 'reset_policy' | 'last_reset_at'>,
  date: Date,
): { value: bigint; reset: boolean } {
  if (row.reset_policy === 'never') return { value: row.next_value, reset: false };
  const period = resetPeriod(row.reset_policy, date);
  const last = row.last_reset_at === null ? null : resetPeriod(row.reset_policy, row.last_reset_at);
  // First allocation ever, or a new period: start again at 1.
  if (last !== period) return { value: 1n, reset: true };
  return { value: row.next_value, reset: false };
}

function resolveCompany(companyId: string | undefined): string {
  const { context } = currentUnit();
  const id = companyId ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
  if (id === undefined) {
    throw new BadRequestError('company_required', 'State which company the number is for.');
  }
  if (!context.companyIds.includes(id)) {
    throw new BadRequestError('company_required', 'The session has no access to that company.');
  }
  return id;
}

export class NumberingService {
  /** Rules 1 and 2: the next number of `key`, consumed in the caller's transaction. */
  async allocate(key: string, options: AllocateOptions = {}): Promise<AllocatedNumber> {
    const { db } = currentUnit();
    const companyId = resolveCompany(options.companyId);
    const date = options.date ?? new Date();
    let rows = await db.$queryRaw<SequenceRow[]>`
      SELECT id, prefix, padding, next_value, reset_policy, format, last_reset_at
      FROM platform.number_sequence
      WHERE company_id = ${companyId}::uuid AND key = ${key} AND deleted_at IS NULL
      FOR UPDATE`;
    if (rows.length === 0) {
      await this.createDefault(key, companyId, options.defaults);
      rows = await db.$queryRaw<SequenceRow[]>`
        SELECT id, prefix, padding, next_value, reset_policy, format, last_reset_at
        FROM platform.number_sequence
        WHERE company_id = ${companyId}::uuid AND key = ${key} AND deleted_at IS NULL
        FOR UPDATE`;
    }
    const row = rows[0];
    if (row === undefined) {
      throw new UnprocessableError('sequence_missing', `No number sequence "${key}".`);
    }
    const { value, reset } = nextValueFor(row, date);
    await db.$executeRaw`
      UPDATE platform.number_sequence
      SET next_value = ${value + 1n},
          last_reset_at = CASE WHEN ${reset} THEN ${date} ELSE last_reset_at END
      WHERE id = ${row.id}::uuid`;
    return {
      number: renderNumber(row.format, { prefix: row.prefix, padding: row.padding, value, date }),
      value,
      sequenceId: row.id,
    };
  }

  /** The number `allocate` would give out, without consuming it (the settings screen). */
  async peek(key: string, options: Omit<AllocateOptions, 'defaults'> = {}): Promise<string> {
    const { db } = currentUnit();
    const companyId = resolveCompany(options.companyId);
    const date = options.date ?? new Date();
    const rows = await db.$queryRaw<SequenceRow[]>`
      SELECT id, prefix, padding, next_value, reset_policy, format, last_reset_at
      FROM platform.number_sequence
      WHERE company_id = ${companyId}::uuid AND key = ${key} AND deleted_at IS NULL`;
    const row = rows[0];
    if (row === undefined) {
      throw new UnprocessableError('sequence_missing', `No number sequence "${key}".`);
    }
    const { value } = nextValueFor(row, date);
    return renderNumber(row.format, { prefix: row.prefix, padding: row.padding, value, date });
  }

  /** Rule 5: the module's default settings become the row; the same checks as the form. */
  private async createDefault(
    key: string,
    companyId: string,
    defaults: SequenceDefaults | undefined,
  ): Promise<void> {
    if (defaults === undefined) {
      throw new UnprocessableError(
        'sequence_missing',
        `No number sequence "${key}". Create it under Settings > Numbering sequences.`,
      );
    }
    const resetPolicy = defaults.resetPolicy ?? 'never';
    const problem = patternProblem(defaults.format, resetPolicy);
    if (problem !== null) throw new Error(`Default pattern for "${key}": ${problem}`);
    const { db, context } = currentUnit();
    await db.numberSequence.create({
      data: {
        tenantId: context.tenantId,
        companyId,
        key,
        prefix: defaults.prefix ?? '',
        padding: defaults.padding ?? 4,
        resetPolicy,
        format: defaults.format,
      },
    });
  }
}
