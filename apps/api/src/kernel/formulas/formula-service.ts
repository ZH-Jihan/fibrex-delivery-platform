/**
 * Formula service: which version of a formula applies on a day, and its result.
 *
 * Purpose: modules (payroll, billing, loans, risk ...) ask "formula `pay.per_order` for
 * 2026-03-31 with these inputs" and get the value, the version that produced it (id, number,
 * checksum) and, on request, the step-by-step trace to store as "how was this calculated".
 *
 * Resolution rule (effective dating, SPEC 2.10): among the formula's active and retired
 * versions, the one with valid_from <= day <= valid_to (open-ended when valid_to is NULL).
 * Activation keeps these ranges from overlapping, so there is at most one.
 *
 * Compiled formulas are cached by version id and checksum; a version that is in force is
 * frozen, so its compiled form never goes stale. Runs inside the caller's unit of work
 * (row-level security applies).
 *
 * Rate tables (row 2.9b): a formula that calls rate("<table>", {...}) gets the rows of
 * those tables in force on the same day, read just before evaluation (`run`), and the
 * result lists every rate it used (`rates`: table, dims, value, currency, row id).
 *
 * Depends on: @fibrex/formula, kernel/db unit of work, kernel/rates (RateService).
 * Used by: ./formula-router.ts (evaluate); later the payroll, billing and loan modules.
 */
import {
  compileFormula,
  FormulaError,
  type CompiledFormula,
  type Evaluation,
  type InputSchema,
  type RateLookup,
} from '@fibrex/formula';
import type { FormulaReturnType } from '@fibrex/shared';
import type { Db } from '../db/prisma.js';
import { currentUnit } from '../db/unit-of-work.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { RateService } from '../rates/rate-service.js';

export type FormulaRow = NonNullable<Awaited<ReturnType<Db['formula']['findFirst']>>>;
export type FormulaVersionRow = NonNullable<Awaited<ReturnType<Db['formulaVersion']['findFirst']>>>;

export interface FormulaResult extends Evaluation {
  formulaId: string;
  formulaVersionId: string;
  versionNo: number;
  checksum: string;
}

/** A FormulaError as a 400 the client can show next to the field it came from. */
export function formulaProblem(err: unknown, path: string): unknown {
  if (!(err instanceof FormulaError)) return err;
  const where =
    err.range === undefined
      ? ''
      : ` (characters ${String(err.range.start + 1)} to ${String(err.range.end)})`;
  return new ValidationError([{ path, message: `${err.message}${where}`, code: err.code }]);
}

const CACHE_LIMIT = 500;

export class FormulaService {
  readonly #cache = new Map<string, CompiledFormula>();
  readonly #rates: RateService;

  constructor(rates: RateService = new RateService()) {
    this.#rates = rates;
  }

  /** Compile (or reuse) the expression of a version against its formula's inputs. */
  compile(formula: FormulaRow, version: Pick<FormulaVersionRow, 'id' | 'checksum' | 'expression'>) {
    const cacheKey = `${version.id}:${version.checksum}:${String(formula.version)}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const compiled = compileFormula(
      version.expression,
      formula.inputSchema as unknown as InputSchema,
      formula.returnType as FormulaReturnType,
    );
    if (this.#cache.size >= CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(cacheKey, compiled);
    return compiled;
  }

  /** The version in force on `onDate`; NotFoundError when the formula has none then. */
  async resolve(
    key: string,
    onDate: Date,
  ): Promise<{ formula: FormulaRow; version: FormulaVersionRow }> {
    const { db } = currentUnit();
    const formula = await db.formula.findFirst({ where: { key, deletedAt: null } });
    if (formula === null) throw new NotFoundError(`No formula "${key}".`);
    const version = await db.formulaVersion.findFirst({
      where: {
        formulaId: formula.id,
        status: { in: ['active', 'retired'] },
        deletedAt: null,
        validFrom: { lte: onDate },
        OR: [{ validTo: null }, { validTo: { gte: onDate } }],
      },
      orderBy: { validFrom: 'desc' },
    });
    if (version === null) {
      throw new NotFoundError(
        `Formula "${key}" has no version in force on ${onDate.toISOString().slice(0, 10)}.`,
      );
    }
    return { formula, version };
  }

  /** Evaluate the version of `key` in force on `onDate`. */
  /**
   * The `rate()` lookup for a compiled formula on a day, read now because evaluation is
   * synchronous; undefined when the formula reads no rate table.
   */
  async ratesFor(compiled: CompiledFormula, onDate: Date): Promise<RateLookup | undefined> {
    if (compiled.rateTables.length === 0) return undefined;
    return this.#rates.lookupFor(compiled.rateTables, onDate);
  }

  /** Evaluate a compiled formula with the rates in force on `onDate`. */
  async run(
    compiled: CompiledFormula,
    onDate: Date,
    inputs: Record<string, unknown>,
    options: { explain?: boolean } = {},
  ): Promise<Evaluation> {
    const rates = await this.ratesFor(compiled, onDate);
    return compiled.evaluate(inputs, rates === undefined ? options : { ...options, rates });
  }

  async evaluate(
    key: string,
    onDate: Date,
    inputs: Record<string, unknown>,
    options: { explain?: boolean } = {},
  ): Promise<FormulaResult> {
    const { formula, version } = await this.resolve(key, onDate);
    const result = await this.run(this.compile(formula, version), onDate, inputs, options);
    return {
      ...result,
      formulaId: formula.id,
      formulaVersionId: version.id,
      versionNo: version.versionNo,
      checksum: version.checksum,
    };
  }
}
