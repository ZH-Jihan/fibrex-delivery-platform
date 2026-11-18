/**
 * Unit tests of the ledger set-up rules: fiscal periods by calendar month, default year
 * end, and the code, rate and dimension schemas.
 */
import { describe, expect, it } from 'vitest';
import {
  accountCodeSchema,
  defaultFiscalYearEnd,
  exchangeRateValueSchema,
  fiscalPeriods,
  ledgerDimensionsSchema,
  ledgerNameSchema,
  taxRateSchema,
} from './index.js';

describe('fiscalPeriods', () => {
  it('cuts a calendar year into 12 months', () => {
    const periods = fiscalPeriods('2026-01-01', '2026-12-31');
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ periodNo: 1, startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(periods[1]?.endDate).toBe('2026-02-28');
    expect(periods[11]).toEqual({ periodNo: 12, startDate: '2026-12-01', endDate: '2026-12-31' });
  });

  it('handles a leap February and a year starting in July', () => {
    const periods = fiscalPeriods('2027-07-01', '2028-06-30');
    expect(periods).toHaveLength(12);
    expect(periods.find((p) => p.startDate === '2028-02-01')?.endDate).toBe('2028-02-29');
  });

  it('gives a short first and last period when the year starts or ends mid-month', () => {
    const periods = fiscalPeriods('2026-03-15', '2026-06-10');
    expect(periods.map((p) => [p.startDate, p.endDate])).toEqual([
      ['2026-03-15', '2026-03-31'],
      ['2026-04-01', '2026-04-30'],
      ['2026-05-01', '2026-05-31'],
      ['2026-06-01', '2026-06-10'],
    ]);
  });

  it('periods cover every day exactly once', () => {
    const periods = fiscalPeriods('2026-01-01', '2027-06-30');
    expect(periods).toHaveLength(18);
    for (let i = 1; i < periods.length; i += 1) {
      const prevEnd = new Date(`${periods[i - 1]?.endDate ?? ''}T00:00:00Z`).getTime();
      const start = new Date(`${periods[i]?.startDate ?? ''}T00:00:00Z`).getTime();
      expect(start - prevEnd).toBe(86_400_000);
    }
  });

  it('refuses an end before the start and a year over 18 months', () => {
    expect(() => fiscalPeriods('2026-02-01', '2026-01-31')).toThrow();
    expect(() => fiscalPeriods('2026-01-01', '2027-07-31')).toThrow();
  });
});

describe('defaultFiscalYearEnd', () => {
  it('is one day before the same date next year', () => {
    expect(defaultFiscalYearEnd('2026-01-01')).toBe('2026-12-31');
    expect(defaultFiscalYearEnd('2026-07-01')).toBe('2027-06-30');
  });
});

describe('schemas', () => {
  it('account codes', () => {
    expect(accountCodeSchema.safeParse('1110').success).toBe(true);
    expect(accountCodeSchema.safeParse('1-110.A').success).toBe(true);
    expect(accountCodeSchema.safeParse('-1').success).toBe(false);
    expect(accountCodeSchema.safeParse('').success).toBe(false);
  });

  it('tax rates are 0 to 100 with at most 4 decimals', () => {
    expect(taxRateSchema.safeParse('0').success).toBe(true);
    expect(taxRateSchema.safeParse('5.25').success).toBe(true);
    expect(taxRateSchema.safeParse('100').success).toBe(true);
    expect(taxRateSchema.safeParse('100.5').success).toBe(false);
    expect(taxRateSchema.safeParse('1.23456').success).toBe(false);
    expect(taxRateSchema.safeParse('-1').success).toBe(false);
  });

  it('exchange rates are above zero with at most 8 decimals', () => {
    expect(exchangeRateValueSchema.safeParse('0.27472527').success).toBe(true);
    expect(exchangeRateValueSchema.safeParse('3.64').success).toBe(true);
    expect(exchangeRateValueSchema.safeParse('0').success).toBe(false);
    expect(exchangeRateValueSchema.safeParse('0.00000000').success).toBe(false);
    expect(exchangeRateValueSchema.safeParse('1.123456789').success).toBe(false);
  });

  it('dimensions are known and listed once', () => {
    expect(ledgerDimensionsSchema.safeParse(['party', 'branch']).success).toBe(true);
    expect(ledgerDimensionsSchema.safeParse(['party', 'party']).success).toBe(false);
    expect(ledgerDimensionsSchema.safeParse(['colour']).success).toBe(false);
  });

  it('names need English', () => {
    expect(ledgerNameSchema.safeParse({ en: 'Cash' }).success).toBe(true);
    expect(ledgerNameSchema.safeParse({ bn: 'নগদ' }).success).toBe(false);
  });
});
