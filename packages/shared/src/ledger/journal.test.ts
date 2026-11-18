import { describe, expect, it } from 'vitest';
import { baseRoundingFix, manualJournalLineSchema, toBaseAmount, type FxLine } from './journal.js';

const usd = (side: 'debit' | 'credit', amount: string, rate = '3.64'): FxLine => {
  const base = toBaseAmount(amount, rate);
  return {
    currency: 'USD',
    fxRate: rate,
    debit: side === 'debit' ? amount : '0',
    credit: side === 'credit' ? amount : '0',
    baseDebit: side === 'debit' ? base : '0',
    baseCredit: side === 'credit' ? base : '0',
  };
};

describe('toBaseAmount', () => {
  it('multiplies and rounds half-up to 4 decimals', () => {
    expect(toBaseAmount('100', '3.64')).toBe('364.0000');
    expect(toBaseAmount('0.00005', '1')).toBe('0.0001');
    expect(toBaseAmount('33.3333', '3.64000001')).toBe('121.3332');
    expect(toBaseAmount('1', '0.00001')).toBe('0.0000');
  });
});

describe('baseRoundingFix', () => {
  it('moves a rounding difference onto the largest line of the short side', () => {
    const lines = [
      usd('debit', '33.3333', '3.64000001'),
      usd('debit', '33.3333', '3.64000001'),
      usd('debit', '33.3334', '3.64000001'),
      usd('credit', '100', '3.64000001'),
    ];
    // Debits 121.3332 + 121.3332 + 121.3336 = 364.0000; credit 364.0000 => already equal.
    expect(baseRoundingFix(lines)).toBeNull();

    const uneven = [
      usd('debit', '0.0001', '0.5'),
      usd('debit', '0.0001', '0.5'),
      usd('credit', '0.0002', '0.5'),
    ];
    // 0.00005 rounds up to 0.0001 twice (0.0002) against 0.0001: debits are long.
    const fix = baseRoundingFix(uneven);
    expect(fix).toEqual({ index: 2, side: 'credit', delta: '0.0001' });
  });

  it('leaves real differences alone: two rates, or not balanced in the currency', () => {
    expect(baseRoundingFix([usd('debit', '100', '3.64'), usd('credit', '100', '3.65')])).toBeNull();
    expect(baseRoundingFix([usd('debit', '100'), usd('credit', '99.99')])).toBeNull();
  });

  it('picks the same line again when the lines are reversed', () => {
    const lines = [
      usd('debit', '0.0001', '0.5'),
      usd('debit', '0.0001', '0.5'),
      usd('credit', '0.0002', '0.5'),
    ];
    const swapped = lines.map((l) => ({
      ...l,
      debit: l.credit,
      credit: l.debit,
      baseDebit: l.baseCredit,
      baseCredit: l.baseDebit,
    }));
    expect(baseRoundingFix(swapped)).toEqual({ index: 2, side: 'debit', delta: '0.0001' });
  });
});

describe('manualJournalLineSchema', () => {
  it('needs exactly one side and a positive amount', () => {
    expect(manualJournalLineSchema.safeParse({ accountCode: '1100', debit: '10' }).success).toBe(
      true,
    );
    expect(
      manualJournalLineSchema.safeParse({ accountCode: '1100', debit: '1', credit: '1' }).success,
    ).toBe(false);
    expect(manualJournalLineSchema.safeParse({ accountCode: '1100', debit: '0' }).success).toBe(
      false,
    );
    expect(
      manualJournalLineSchema.safeParse({ accountCode: '1100', credit: '1.23456' }).success,
    ).toBe(false);
  });
});
