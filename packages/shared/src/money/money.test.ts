import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  MoneyRangeError,
  add,
  allocate,
  compare,
  convert,
  formatAmount,
  isNegative,
  money,
  moneySchema,
  multiply,
  negate,
  subtract,
  sum,
} from './index.js';

const qar = (a: string | number) => money(a, 'QAR');

describe('money()', () => {
  it('normalises to 4 decimals and avoids float errors', () => {
    expect(qar('0.1').amount).toBe('0.1000');
    expect(add(qar('0.1'), qar('0.2')).amount).toBe('0.3000');
  });

  it('refuses more than 4 decimals instead of rounding silently', () => {
    expect(() => qar('1.23456')).toThrow(MoneyRangeError);
  });

  it('enforces the NUMERIC(18,4) range', () => {
    expect(qar('99999999999999.9999').amount).toBe('99999999999999.9999');
    expect(() => qar('100000000000000')).toThrow(MoneyRangeError);
  });

  it('rejects bad currency codes', () => {
    expect(() => money(1, 'qar')).toThrow();
  });

  it('never produces negative zero', () => {
    expect(negate(qar(0)).amount).toBe('0.0000');
  });
});

describe('arithmetic', () => {
  it('refuses to mix currencies', () => {
    expect(() => add(qar(1), money(1, 'BDT'))).toThrow(CurrencyMismatchError);
    expect(() => sum([qar(1), money(1, 'BDT')], 'QAR')).toThrow(CurrencyMismatchError);
  });

  it('multiplies with explicit half-up rounding', () => {
    // 37 orders x 10.5 QAR per order
    expect(multiply(qar(10.5), 37).amount).toBe('388.5000');
    // 1000 x 0.000123455 = 0.123455, which rounds half-up at the 4th decimal to 0.1235
    expect(multiply(qar(1000), '0.000123455').amount).toBe('0.1235');
  });

  it('sums, subtracts and compares', () => {
    expect(sum([], 'QAR').amount).toBe('0.0000');
    expect(sum([qar(10), qar('2.5'), qar(-1)], 'QAR').amount).toBe('11.5000');
    expect(subtract(qar(5), qar(7)).amount).toBe('-2.0000');
    expect(isNegative(subtract(qar(5), qar(7)))).toBe(true);
    expect(compare(qar(1), qar('1.0000'))).toBe(0);
    expect(compare(qar(2), qar(1))).toBe(1);
  });

  it('converts with a recorded rate', () => {
    expect(convert(money(1000, 'BDT'), '0.0303', 'QAR').amount).toBe('30.3000');
    expect(() => convert(qar(1), 0, 'BDT')).toThrow(MoneyRangeError);
  });

  it('formats for display at minor units', () => {
    expect(formatAmount(qar('12.345'))).toBe('12.35');
  });
});

describe('allocate()', () => {
  it('splits so parts always sum exactly to the total', () => {
    const parts = allocate(qar(100), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual(['33.3400', '33.3300', '33.3300']);
    expect(sum(parts, 'QAR').amount).toBe('100.0000');
  });

  it('is proportional to weights such as days stayed', () => {
    // rent 1500 for a 30-day month: 30 days, 15 days, 10 days
    const parts = allocate(qar(1500), [30, 15, 10]);
    expect(sum(parts, 'QAR').amount).toBe('1500.0000');
    expect(parts.map((p) => p.amount)).toEqual(['818.1800', '409.0900', '272.7300']);
  });

  it('handles negative totals and zero weights', () => {
    const parts = allocate(qar(-10), [1, 0, 2]);
    expect(parts.map((p) => p.amount)).toEqual(['-3.3300', '0.0000', '-6.6700']);
  });

  it('rejects invalid input', () => {
    expect(() => allocate(qar(10), [])).toThrow(MoneyRangeError);
    expect(() => allocate(qar(10), [0, 0])).toThrow(MoneyRangeError);
    expect(() => allocate(qar(10), [-1, 2])).toThrow(MoneyRangeError);
    expect(() => allocate(qar('10.005'), [1])).toThrow(MoneyRangeError);
  });
});

describe('moneySchema', () => {
  it('validates transport shape', () => {
    expect(moneySchema.safeParse({ amount: '12.5', currency: 'QAR' }).success).toBe(true);
    expect(moneySchema.safeParse({ amount: 12.5, currency: 'QAR' }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: '1.00001', currency: 'QAR' }).success).toBe(false);
  });
});
