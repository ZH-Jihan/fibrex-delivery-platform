/**
 * Ledger set-up lookups other code needs (phase 2 row 2.14): which fiscal period a day falls
 * in, and which exchange rate applies on a day. The posting service (row 2.15) calls both
 * inside its unit of work, so row-level security limits them to the caller's companies.
 *
 * Exchange rate rule: the latest rate of the exact pair dated on or before the day. A rate is
 * never inverted or chained (QAR->USD is not derived from USD->QAR): a derived rate would be
 * rounded differently from the one the accountant typed, so a missing pair is an error the
 * user must fix by entering the rate. Same currency is always exactly 1.
 *
 * Depends on: kernel/db (currentUnit), kernel/http/errors. Used by: ./index.ts, row 2.15.
 */
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import { UnprocessableError } from '../../kernel/http/errors.js';
import type { FiscalPeriodRecord } from './fiscal-router.js';

export interface RateOnDay {
  /** Decimal text, 8 decimals. */
  rate: string;
  /** Day the rate was entered for (YYYY-MM-DD); null for the same-currency rate 1. */
  rateDate: string | null;
  exchangeRateId: string | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export class LedgerSetupService {
  /** The live period of `companyId` that contains `day`, or null when no year covers it. */
  async periodFor(companyId: string, day: Date): Promise<FiscalPeriodRecord | null> {
    return currentUnit().db.glFiscalPeriod.findFirst({
      where: { companyId, deletedAt: null, startDate: { lte: day }, endDate: { gte: day } },
    });
  }

  /** 1 `from` = rate `to` on `day` (see the rule in the header). */
  async rateOn(companyId: string, from: string, to: string, day: Date): Promise<RateOnDay> {
    if (from === to) return { rate: '1.00000000', rateDate: null, exchangeRateId: null };
    const row = await currentUnit().db.glExchangeRate.findFirst({
      where: {
        companyId,
        fromCurrency: from,
        toCurrency: to,
        deletedAt: null,
        rateDate: { lte: day },
      },
      orderBy: { rateDate: 'desc' },
    });
    if (row === null) {
      throw new UnprocessableError(
        'gl_exchange_rate_missing',
        `No ${from} to ${to} exchange rate on or before ${isoDay(day)}; enter one first.`,
      );
    }
    return { rate: row.rate.toFixed(8), rateDate: isoDay(row.rateDate), exchangeRateId: row.id };
  }
}
