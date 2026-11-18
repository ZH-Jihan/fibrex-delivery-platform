/**
 * The posting service (phase 2 row 2.15a; SPEC 2.9, PLAN 3.9): the ONE way money reaches the
 * ledger. Modules never write gl.journal or gl.journal_line themselves; they call
 *   postEvent()  an event (loan.disbursed, payroll.posted ...) through its posting rule,
 *   post()       explicit lines (manual journals in row 2.15b; also the core of the others),
 *   reverse()    a reversal of a posted journal (the only correction there is).
 * Everything runs inside the caller's unit of work, so the journal commits or rolls back
 * together with the business change that caused it, under row-level security.
 *
 * Steps of a posting (post):
 *   1. The company must be one of the session's; its base currency is read.
 *   2. Every line is checked: exactly one side above zero, at most 4 decimals; the account
 *      is live, postable, takes the line's currency, and the line carries every dimension the
 *      account requires (a control account always needs a party); the tax code exists (the
 *      company default when none is named).
 *   3. Base amounts (row 2.15b): a foreign line takes the rate it names or the exchange rate
 *      of the entry day; base = amount x rate, half-up to 4 decimals; a base line has rate 1.
 *      A difference that is rounding only is moved onto one line (shared `baseRoundingFix`
 *      says when). Then the journal must balance in base (exact decimal sums).
 *   4. The entry date falls in an open fiscal period.
 *   5. A gapless journal number (`gl.journal`, default JV-YYYY-00001, yearly) is taken in this
 *      transaction, then the journal and its lines are inserted.
 * The database checks steps 2 to 4 again (triggers in migration gl_posting): a posting that
 * slipped past this code, or a period closed by someone else a moment ago, still fails.
 * Checking here first gives the caller a clear 422 instead of a database error.
 *
 * Event postings (postEvent): the posting rule version in force on the entry date is used
 * (active or retired, valid_from <= day <= valid_to). For each rule line: the amount formula
 * is evaluated with the event's inputs (rates from rate tables as on that day); a zero amount
 * drops the line (an optional deduction that is not there this time); a negative amount or one
 * with more than 4 decimals is an error (rounding must be written in the formula with round()).
 * The account comes from the resolver, dimensions from the named inputs.
 *
 * Idempotency: a caller that passes an idempotency key and posts again (a retried job) gets
 * the first journal back, unchanged, with `replayed: true`.
 *
 * Reversal: same lines with debit and credit swapped, same dimensions, on the given day (today
 * by default, never before the original); a journal is reversed once (unique index) and a
 * reversal is not itself reversed (post the entry again instead).
 *
 * Depends on: @fibrex/shared (posting shapes, money), @fibrex/formula, kernel/formulas,
 * kernel/numbering, kernel/db, ./setup-service.ts. Used by: ./journal-router.ts,
 * ./posting-rule-router.ts, later every module that moves money.
 */
import { createHash } from 'node:crypto';
import {
  compileFormula,
  FormulaError,
  type CompiledFormula,
  type InputSchema,
} from '@fibrex/formula';
import {
  AccountResolveError,
  baseRoundingFix,
  canonicalJson,
  toBaseAmount,
  DIMENSION_FIELDS,
  journalTotals,
  LEDGER_DIMENSIONS,
  resolveAccountCode,
  type LedgerDimension,
  type PostingRuleLine,
} from '@fibrex/shared';
import { Decimal } from '@fibrex/shared/money';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import { FormulaService } from '../../kernel/formulas/formula-service.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../kernel/http/errors.js';
import { NumberingService } from '../../kernel/numbering/numbering-service.js';
import { LedgerSetupService } from './setup-service.js';

export type JournalRecord = NonNullable<Awaited<ReturnType<Db['glJournal']['findFirst']>>>;
export type JournalLineRecord = NonNullable<Awaited<ReturnType<Db['glJournalLine']['findFirst']>>>;
export type PostingRuleRecord = NonNullable<Awaited<ReturnType<Db['glPostingRule']['findFirst']>>>;

export type Dimensions = Partial<Record<LedgerDimension, string>>;

/** One line to post. Name the account by id or by code; give debit or credit, not both. */
export interface PostingLineInput {
  accountId?: string;
  accountCode?: string;
  /** Decimal text, at most 4 decimals. */
  debit?: string;
  credit?: string;
  /** Defaults to the company's base currency. */
  currency?: string;
  /**
   * 1 unit of `currency` = fxRate base units (decimal text, at most 8 decimals). Left out:
   * the exchange rate of the entry day (`LedgerSetupService.rateOn`). Must be 1 (or left
   * out) on a base-currency line.
   */
  fxRate?: string;
  dimensions?: Dimensions;
  /** Tax code id or code; the company's default tax code when neither is given. */
  taxCodeId?: string;
  taxCode?: string;
  sourceDocType?: string;
  sourceDocId?: string;
  memo?: string;
}

export interface JournalInput {
  companyId: string;
  /** YYYY-MM-DD. */
  entryDate: string;
  eventKey: string;
  description: string;
  lines: PostingLineInput[];
  postingRuleId?: string;
  source?: { type: string; id?: string };
  idempotencyKey?: string;
  reversalOfId?: string;
  reason?: string;
}

export interface EventPostingInput {
  companyId: string;
  eventKey: string;
  /** YYYY-MM-DD; picks the rule version and the fiscal period. */
  entryDate: string;
  inputs: Record<string, unknown>;
  description: string;
  source?: { type: string; id?: string };
  idempotencyKey?: string;
}

/** A journal checked and priced but not written (post() writes it; simulate shows it). */
export interface PreparedJournal {
  companyId: string;
  baseCurrency: string;
  day: Date;
  description: string;
  rows: PreparedLine[];
  totals: { debit: string; credit: string; balanced: boolean };
  /** The fiscal period of the day, or null when no fiscal year covers it. */
  period: { id: string; status: string } | null;
}

export interface PreparedLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  debit: string;
  credit: string;
  currency: string;
  fxRate: string;
  baseDebit: string;
  baseCredit: string;
  dimensionFields: Record<string, string>;
  taxCodeId: string;
  sourceDocType: string | null;
  sourceDocId: string | null;
  memo: string | null;
}

export interface PostedJournal {
  journal: JournalRecord;
  lines: JournalLineRecord[];
  /** True when the idempotency key had already been used: nothing new was written. */
  replayed: boolean;
}

const MAX_LINES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_AMOUNT = new Decimal('1e14');
const DAY_MS = 86_400_000;

export const toDay = (text: string): Date => new Date(`${text}T00:00:00.000Z`);
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const invalid = (code: string, detail: string) => new UnprocessableError(code, detail);

/** SHA-256 of what a rule posts (inputs and lines), whatever the JSON key order. */
export function postingRuleChecksum(inputSchema: unknown, lines: unknown): string {
  return createHash('sha256').update(canonicalJson({ inputSchema, lines })).digest('hex');
}

/**
 * Database errors raised by the ledger triggers carry a `gl_...:` code at the start of their
 * message. Turn them into a 422 the caller can show; anything else is rethrown.
 */
export function ledgerDbProblem(err: unknown): unknown {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
  const match = /(gl_[a-z_]+): ([^"\\]*)/.exec(text);
  if (match?.[1] === undefined) return err;
  return invalid(match[1], (match[2] ?? '').trim() || 'The ledger refused this posting.');
}

/** True for "", "0", "0.00"; false for anything else, unreadable text included (amountOf reports it). */
function zeroText(text: string): boolean {
  if (text.trim() === '') return true;
  try {
    return new Decimal(text).isZero();
  } catch {
    return false;
  }
}

/** A positive amount of at most 4 decimals, or an error naming the line. */
function amountOf(text: string, where: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(text);
  } catch {
    throw invalid('gl_amount_invalid', `${where}: "${text}" is not a number.`);
  }
  if (!d.isFinite() || d.lte(0)) {
    throw invalid('gl_amount_invalid', `${where}: the amount must be above zero.`);
  }
  if (d.decimalPlaces() > 4) {
    throw invalid('gl_amount_invalid', `${where}: at most 4 decimals (round it explicitly).`);
  }
  if (d.gte(MAX_AMOUNT)) throw invalid('gl_amount_invalid', `${where}: the amount is too large.`);
  return d;
}

export interface PostingServiceDeps {
  setup?: LedgerSetupService;
  numbering?: NumberingService;
  formulas?: FormulaService;
}

export class PostingService {
  readonly #setup: LedgerSetupService;
  readonly #numbering: NumberingService;
  readonly #formulas: FormulaService;
  /** Compiled amount formulas by rule id, checksum and line; frozen rules never go stale. */
  readonly #compiled = new Map<string, CompiledFormula>();

  constructor(deps: PostingServiceDeps = {}) {
    this.#setup = deps.setup ?? new LedgerSetupService();
    this.#numbering = deps.numbering ?? new NumberingService();
    this.#formulas = deps.formulas ?? new FormulaService();
  }

  /* ------------------------------------------------------------------------------------
   * Rules
   * ---------------------------------------------------------------------------------- */

  /** The version of `eventKey` in force on `day` for the company; 422 when there is none. */
  async ruleInForce(companyId: string, eventKey: string, day: Date): Promise<PostingRuleRecord> {
    const rule = await currentUnit().db.glPostingRule.findFirst({
      where: {
        companyId,
        eventKey,
        deletedAt: null,
        status: { in: ['active', 'retired'] },
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gte: day } }],
      },
      orderBy: { validFrom: 'desc' },
    });
    if (rule === null) {
      throw invalid(
        'gl_posting_rule_missing',
        `No posting rule for ${eventKey} is in force on ${isoDay(day)}.`,
      );
    }
    return rule;
  }

  /** Compile one amount formula of a rule (cached for rules in force). */
  compileAmount(
    rule: Pick<PostingRuleRecord, 'id' | 'checksum' | 'inputSchema'>,
    index: number,
    expression: string,
  ) {
    const key = `${rule.id}:${rule.checksum}:${String(index)}`;
    const cached = this.#compiled.get(key);
    if (cached !== undefined) return cached;
    const compiled = compileFormula(
      expression,
      rule.inputSchema as unknown as InputSchema,
      'decimal',
    );
    if (this.#compiled.size >= 1000) this.#compiled.clear();
    this.#compiled.set(key, compiled);
    return compiled;
  }

  /**
   * The lines a rule gives for these inputs on `day` (no writing). Used by postEvent and by
   * the simulate endpoint (row 2.15b).
   */
  async linesFromRule(
    rule: PostingRuleRecord,
    inputs: Record<string, unknown>,
    day: Date,
  ): Promise<PostingLineInput[]> {
    const ruleLines = rule.lines as unknown as PostingRuleLine[];
    const schema = rule.inputSchema as unknown as InputSchema;
    // Defaults of the input schema apply to resolvers and dimensions as to formulas.
    const values: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(schema)) {
      if (field.default !== undefined) values[name] = field.default;
    }
    Object.assign(values, inputs);

    const out: PostingLineInput[] = [];
    for (const [i, line] of ruleLines.entries()) {
      const where = `Rule line ${String(i + 1)}`;
      // Amount: the sandboxed formula engine, decimal only.
      let value: string;
      try {
        const result = await this.#formulas.run(
          this.compileAmount(rule, i, line.amount),
          day,
          values,
        );
        value = String(result.value);
      } catch (err) {
        if (err instanceof FormulaError) {
          throw invalid('gl_rule_amount', `${where}: ${err.message}`);
        }
        throw err;
      }
      const amount = new Decimal(value);
      if (amount.isZero()) continue; // nothing to post on this line this time
      if (amount.isNegative()) {
        throw invalid('gl_rule_amount', `${where}: the amount came out negative (${value}).`);
      }
      // Account.
      let accountCode: string;
      try {
        accountCode = resolveAccountCode(line.account, values);
      } catch (err) {
        if (err instanceof AccountResolveError)
          throw invalid('gl_rule_account', `${where}: ${err.message}`);
        throw err;
      }
      // Dimensions: ids taken from the named inputs; an absent optional input means none.
      const dimensions: Dimensions = {};
      for (const [dim, input] of Object.entries(line.dimensions ?? {}) as [
        LedgerDimension,
        string,
      ][]) {
        const id = values[input];
        if (id === undefined || id === null || id === '') continue;
        if (typeof id !== 'string' || !UUID.test(id)) {
          throw invalid(
            'gl_rule_dimension',
            `${where}: input "${input}" must be an id for ${dim}.`,
          );
        }
        dimensions[dim] = id;
      }
      out.push({
        accountCode,
        [line.side]: amount.toFixed(),
        dimensions,
        ...(line.taxCode === undefined ? {} : { taxCode: line.taxCode }),
        ...(line.memo === undefined ? {} : { memo: line.memo }),
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------------------------
   * Posting
   * ---------------------------------------------------------------------------------- */

  /** Post a business event through the posting rule in force on its date. */
  async postEvent(input: EventPostingInput): Promise<PostedJournal> {
    const replay = await this.#replay(input.companyId, input.idempotencyKey);
    if (replay !== null) return replay;
    const day = toDay(input.entryDate);
    const rule = await this.ruleInForce(input.companyId, input.eventKey, day);
    const lines = await this.linesFromRule(rule, input.inputs, day);
    return this.post({
      companyId: input.companyId,
      entryDate: input.entryDate,
      eventKey: input.eventKey,
      description: input.description,
      lines,
      postingRuleId: rule.id,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
  }

  /** Post explicit lines (steps 1 to 5 in the header). */
  async post(input: JournalInput): Promise<PostedJournal> {
    const { db, context } = currentUnit();
    const replay = await this.#replay(input.companyId, input.idempotencyKey);
    if (replay !== null) return replay;
    const { period, rows, day, description } = await this.prepare(input);

    // Step 4: an open period.
    if (period === null) {
      throw invalid(
        'gl_period_missing',
        `No fiscal period covers ${input.entryDate}; open the fiscal year first.`,
      );
    }
    if (period.status !== 'open') {
      throw invalid(
        'gl_period_not_open',
        `The fiscal period of ${input.entryDate} is ${period.status}.`,
      );
    }

    // Step 5: number, journal, lines (the triggers check again; their errors become 422).
    const { number } = await this.#numbering.allocate('gl.journal', {
      companyId: input.companyId,
      date: day,
      defaults: { format: 'JV-{YYYY}-{00000}', resetPolicy: 'yearly' },
    });
    try {
      const journal = await db.glJournal.create({
        data: {
          tenantId: context.tenantId,
          companyId: input.companyId,
          number,
          entryDate: day,
          fiscalPeriodId: period.id,
          eventKey: input.eventKey,
          postingRuleId: input.postingRuleId ?? null,
          sourceType: input.source?.type ?? null,
          sourceId: input.source?.id ?? null,
          description,
          lineCount: rows.length,
          reversalOfId: input.reversalOfId ?? null,
          reason: input.reason ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });
      await db.glJournalLine.createMany({
        data: rows.map((r) => ({
          lineNo: r.lineNo,
          accountId: r.accountId,
          debit: r.debit,
          credit: r.credit,
          currency: r.currency,
          fxRate: r.fxRate,
          baseDebit: r.baseDebit,
          baseCredit: r.baseCredit,
          taxCodeId: r.taxCodeId,
          sourceDocType: r.sourceDocType,
          sourceDocId: r.sourceDocId,
          memo: r.memo,
          ...r.dimensionFields,
          tenantId: context.tenantId,
          companyId: input.companyId,
          journalId: journal.id,
          entryDate: day,
        })),
      });
      const lines = await this.linesOf(journal);
      return { journal, lines, replayed: false };
    } catch (err) {
      throw ledgerDbProblem(err);
    }
  }

  /**
   * Steps 1 to 3 of a posting and the period lookup of step 4, without writing anything.
   * post() uses it, and so does the simulate endpoint (which shows the result instead).
   */
  async prepare(input: JournalInput): Promise<PreparedJournal> {
    const { db, context } = currentUnit();

    // Step 1: company and base currency.
    if (!context.companyIds.includes(input.companyId)) {
      throw new BadRequestError('company_required', 'The session has no access to that company.');
    }
    const company = await db.company.findFirst({ where: { id: input.companyId } });
    if (company === null) throw new NotFoundError('No such company.');
    const base = company.baseCurrency;
    if (!EVENT_KEY.test(input.eventKey)) {
      throw invalid('gl_event_key', `"${input.eventKey}" is not a valid event key.`);
    }
    const description = input.description.trim();
    if (description.length === 0 || description.length > 500) {
      throw invalid('gl_description', 'A journal needs a description of 1 to 500 characters.');
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate) ||
      Number.isNaN(toDay(input.entryDate).getTime())
    ) {
      throw invalid('gl_entry_date', 'The entry date must be YYYY-MM-DD.');
    }
    const day = toDay(input.entryDate);
    if (input.lines.length < 2 || input.lines.length > MAX_LINES) {
      throw invalid('gl_line_count', `A journal needs 2 to ${String(MAX_LINES)} lines.`);
    }

    // Step 2: accounts and tax codes, read once for all lines.
    const ids = input.lines.flatMap((l) => (l.accountId === undefined ? [] : [l.accountId]));
    const codes = input.lines.flatMap((l) => (l.accountCode === undefined ? [] : [l.accountCode]));
    const accounts = await db.glAccount.findMany({
      where: {
        companyId: input.companyId,
        deletedAt: null,
        OR: [{ id: { in: ids } }, { code: { in: codes } }],
      },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const taxCodes = await db.glTaxCode.findMany({
      where: { companyId: input.companyId, deletedAt: null },
    });
    const defaultTax = taxCodes.find((t) => t.isDefault);

    // Step 3 (first half): currencies and rates, read once. A rate the line names wins over
    // the exchange rate of the day (a bank's actual rate on a transfer, for example).
    const currencies = [...new Set(input.lines.map((l) => l.currency ?? base))];
    const known = await db.currency.findMany({
      where: { code: { in: currencies }, isActive: true },
      select: { code: true },
    });
    const rateOfDay = new Map<string, string>();
    for (const [i, line] of input.lines.entries()) {
      const currency = line.currency ?? base;
      const where = `Line ${String(i + 1)}`;
      if (!known.some((c) => c.code === currency)) {
        throw invalid('gl_currency_unknown', `${where}: ${currency} is not an active currency.`);
      }
      if (line.fxRate !== undefined) {
        if (!/^\d{1,10}(\.\d{1,8})?$/.test(line.fxRate) || new Decimal(line.fxRate).lte(0)) {
          throw invalid(
            'gl_fx_rate_invalid',
            `${where}: the rate must be above zero with at most 8 decimals.`,
          );
        }
        if (currency === base && !new Decimal(line.fxRate).eq(1)) {
          throw invalid('gl_fx_rate_invalid', `${where}: a ${base} line has rate 1.`);
        }
      } else if (currency !== base && !rateOfDay.has(currency)) {
        const found = await this.#setup.rateOn(input.companyId, currency, base, day);
        rateOfDay.set(currency, found.rate);
      }
    }

    const rows: PreparedLine[] = input.lines.map((line, i) => {
      const where = `Line ${String(i + 1)}`;
      const account =
        line.accountId === undefined
          ? line.accountCode === undefined
            ? undefined
            : byCode.get(line.accountCode)
          : byId.get(line.accountId);
      if (account === undefined) {
        throw invalid(
          'gl_account_missing',
          `${where}: no live account ${line.accountCode ?? line.accountId ?? '(none given)'} in this company.`,
        );
      }
      if (!account.isPostable) {
        throw invalid('gl_account_not_postable', `${where}: ${account.code} is a header account.`);
      }
      const hasDebit = line.debit !== undefined && !zeroText(line.debit);
      const hasCredit = line.credit !== undefined && !zeroText(line.credit);
      if (hasDebit === hasCredit) {
        throw invalid('gl_line_side', `${where}: give a debit or a credit above zero, not both.`);
      }
      const amount = amountOf((hasDebit ? line.debit : line.credit) ?? '', where);
      const currency = line.currency ?? base;
      if (account.currencyRestriction !== null && account.currencyRestriction !== currency) {
        throw invalid(
          'gl_account_currency',
          `${where}: ${account.code} takes ${account.currencyRestriction} only.`,
        );
      }
      // Dimensions: only known names, ids only, and every one the account requires.
      const dims = line.dimensions ?? {};
      for (const [dim, id] of Object.entries(dims)) {
        if (!(LEDGER_DIMENSIONS as readonly string[]).includes(dim)) {
          throw invalid('gl_dimension', `${where}: unknown dimension "${dim}".`);
        }
        if (typeof id !== 'string' || !UUID.test(id)) {
          throw invalid('gl_dimension', `${where}: ${dim} must be an id.`);
        }
      }
      const required = new Set(account.requiresDimensions);
      // A control account is the total of a sub-ledger, so every line names whose it is.
      if (account.isControl) required.add('party');
      const missing = [...required].filter((d) => dims[d as LedgerDimension] === undefined);
      if (missing.length > 0) {
        throw invalid(
          'gl_dimension_required',
          `${where}: account ${account.code} needs ${missing.join(', ')} on every line.`,
        );
      }
      const tax =
        line.taxCodeId !== undefined
          ? taxCodes.find((t) => t.id === line.taxCodeId)
          : line.taxCode !== undefined
            ? taxCodes.find((t) => t.code === line.taxCode)
            : defaultTax;
      if (tax === undefined) {
        throw invalid(
          'gl_tax_code_missing',
          `${where}: tax code ${line.taxCode ?? line.taxCodeId ?? '(default)'} does not exist in this company.`,
        );
      }
      if (line.sourceDocId !== undefined && line.sourceDocType === undefined) {
        throw invalid('gl_source_doc', `${where}: a source document id needs its type.`);
      }
      const text = amount.toFixed(4);
      const dimensionFields = Object.fromEntries(
        Object.entries(dims).map(([dim, id]) => [DIMENSION_FIELDS[dim as LedgerDimension], id]),
      );
      // Step 3: the rate (named, of the day, or 1 in base) and the base amount.
      const fxRate = new Decimal(
        line.fxRate ?? (currency === base ? '1' : (rateOfDay.get(currency) ?? '')),
      ).toFixed(8);
      const baseText = currency === base ? text : toBaseAmount(text, fxRate);
      return {
        lineNo: i + 1,
        accountId: account.id,
        accountCode: account.code,
        debit: hasDebit ? text : '0.0000',
        credit: hasCredit ? text : '0.0000',
        currency,
        fxRate,
        baseDebit: hasDebit ? baseText : '0.0000',
        baseCredit: hasCredit ? baseText : '0.0000',
        dimensionFields,
        taxCodeId: tax.id,
        sourceDocType: line.sourceDocType ?? null,
        sourceDocId: line.sourceDocId ?? null,
        // An empty memo is stored as none.
        memo: line.memo === undefined || line.memo.trim() === '' ? null : line.memo.trim(),
      };
    });

    // Step 3 (second half): a difference that is rounding only goes onto one line (the
    // shared helper decides; real differences are left for the balance check to refuse).
    const fix = baseRoundingFix(rows);
    if (fix !== null) {
      const row = rows[fix.index];
      if (row !== undefined) {
        if (fix.side === 'debit')
          row.baseDebit = new Decimal(row.baseDebit).plus(fix.delta).toFixed(4);
        else row.baseCredit = new Decimal(row.baseCredit).plus(fix.delta).toFixed(4);
      }
    }
    const totals = journalTotals(rows.map((r) => ({ debit: r.baseDebit, credit: r.baseCredit })));
    if (!totals.balanced) {
      throw invalid(
        'gl_journal_unbalanced',
        `Debits ${totals.debit} and credits ${totals.credit} (${base}) must be equal and above zero.`,
      );
    }

    // Step 4 (lookup only; post() refuses a missing or closed period).
    const period = await this.#setup.periodFor(input.companyId, day);
    return {
      companyId: input.companyId,
      baseCurrency: base,
      day,
      description,
      rows,
      totals,
      period: period === null ? null : { id: period.id, status: period.status },
    };
  }

  /** Reverse a posted journal (see the header). */
  async reverse(
    journalId: string,
    options: { reason: string; entryDate?: string; idempotencyKey?: string },
  ): Promise<PostedJournal> {
    const { db } = currentUnit();
    const original = await db.glJournal.findFirst({ where: { id: journalId } });
    if (original === null) throw new NotFoundError('No such journal.');
    const replay = await this.#replay(original.companyId, options.idempotencyKey);
    if (replay !== null) return replay;
    if (original.reversalOfId !== null) {
      throw invalid(
        'gl_reverse_reversal',
        'A reversal cannot be reversed; post the entry again instead.',
      );
    }
    const existing = await db.glJournal.findFirst({ where: { reversalOfId: original.id } });
    if (existing !== null) {
      throw new ConflictError(
        'gl_already_reversed',
        `Journal ${original.number} was reversed by ${existing.number}.`,
        {
          reversalId: existing.id,
        },
      );
    }
    const entryDate = options.entryDate ?? isoDay(new Date());
    if (toDay(entryDate).getTime() < original.entryDate.getTime()) {
      throw invalid(
        'gl_reversal_date',
        `A reversal cannot be dated before the journal it reverses (${isoDay(original.entryDate)}).`,
      );
    }
    const lines = await this.linesOf(original);
    const reason = options.reason.trim();
    try {
      return await this.post({
        companyId: original.companyId,
        entryDate,
        eventKey: original.eventKey,
        description: `Reversal of ${original.number}: ${reason}`.slice(0, 500),
        reversalOfId: original.id,
        reason,
        ...(original.postingRuleId === null ? {} : { postingRuleId: original.postingRuleId }),
        ...(original.sourceType === null
          ? {}
          : {
              source: {
                type: original.sourceType,
                ...(original.sourceId === null ? {} : { id: original.sourceId }),
              },
            }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        // Same accounts, amounts and dimensions; debit and credit change places.
        lines: lines.map((l) => {
          const dimensions: Dimensions = {};
          for (const dim of LEDGER_DIMENSIONS) {
            const id = (l as unknown as Record<string, string | null>)[DIMENSION_FIELDS[dim]];
            if (id !== null && id !== undefined) dimensions[dim] = id;
          }
          return {
            accountId: l.accountId,
            ...(l.debit.isZero() ? { debit: l.credit.toFixed(4) } : { credit: l.debit.toFixed(4) }),
            currency: l.currency,
            // The original rate, not today's: a reversal undoes exactly what was posted (the
            // rounding fix picks the same line again, see shared baseRoundingFix).
            fxRate: l.fxRate.toFixed(8),
            dimensions,
            taxCodeId: l.taxCodeId,
            ...(l.sourceDocType === null ? {} : { sourceDocType: l.sourceDocType }),
            ...(l.sourceDocId === null ? {} : { sourceDocId: l.sourceDocId }),
            ...(l.memo === null ? {} : { memo: l.memo }),
          };
        }),
      });
    } catch (err) {
      // Two reversals at the same moment: the unique index lets one through.
      const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
      if (text.includes('journal_reversal_uq')) {
        throw new ConflictError(
          'gl_already_reversed',
          `Journal ${original.number} was reversed already.`,
        );
      }
      throw err;
    }
  }

  /** The lines of a journal in order (reads only the journal's partition). */
  async linesOf(journal: Pick<JournalRecord, 'id' | 'entryDate'>): Promise<JournalLineRecord[]> {
    return currentUnit().db.glJournalLine.findMany({
      where: { journalId: journal.id, entryDate: journal.entryDate },
      orderBy: { lineNo: 'asc' },
    });
  }

  /** The journal already posted under this idempotency key, if any. */
  async #replay(companyId: string, key: string | undefined): Promise<PostedJournal | null> {
    if (key === undefined) return null;
    const journal = await currentUnit().db.glJournal.findFirst({
      where: { companyId, idempotencyKey: key },
    });
    if (journal === null) return null;
    return { journal, lines: await this.linesOf(journal), replayed: true };
  }
}

/** The day before `day` (closing a rule version when the next one starts). */
export const dayBefore = (day: Date): Date => new Date(day.getTime() - DAY_MS);
