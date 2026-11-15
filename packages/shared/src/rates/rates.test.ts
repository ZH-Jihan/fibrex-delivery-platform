/**
 * Unit tests of the rate matching rule: wildcards, most specific wins, earlier dimension
 * breaks ties, unknown dimensions and no match. All rates are invented.
 */
import { describe, expect, it } from 'vitest';
import { pickRateRow, rateDimensionsSchema, rateRowFormSchema } from './index.js';

const dimensions = ['platform', 'profession', 'zone'];
const rows: { id: string; dims: Record<string, string> }[] = [
  { id: 'any-driver', dims: { profession: 'driver' } },
  { id: 'any-rider', dims: { profession: 'rider' } },
  { id: 'p1-driver', dims: { platform: 'p1', profession: 'driver' } },
  { id: 'p1', dims: { platform: 'p1' } },
  { id: 'north', dims: { zone: 'north' } },
];
const pick = (asked: Record<string, string>) => {
  const result = pickRateRow(dimensions, rows, asked);
  return result.ok ? result.row.id : result.code;
};

describe('pickRateRow', () => {
  it('a row that leaves a dimension out matches any value', () => {
    expect(pick({ platform: 'p2', profession: 'rider' })).toBe('any-rider');
  });

  it('the most specific row wins', () => {
    expect(pick({ platform: 'p1', profession: 'driver' })).toBe('p1-driver');
  });

  it('between rows naming as many dimensions, the earlier dimension wins', () => {
    expect(pick({ platform: 'p1', profession: 'pilot', zone: 'north' })).toBe('p1');
    expect(pick({ profession: 'rider', zone: 'north' })).toBe('any-rider');
  });

  it('a row naming a dimension the caller did not give does not match', () => {
    expect(pick({ platform: 'p2' })).toBe('rate_not_found');
  });

  it('refuses a dimension the table does not have', () => {
    expect(pick({ colour: 'red' })).toBe('rate_unknown_dimension');
  });
});

describe('rate schemas', () => {
  it('dimensions are listed once each', () => {
    expect(rateDimensionsSchema.safeParse(['a', 'a']).success).toBe(false);
    expect(rateDimensionsSchema.safeParse(['platform', 'profession']).success).toBe(true);
  });

  it('a row value has at most 4 decimals and a 3-letter currency', () => {
    const base = { dims: {}, validFrom: '2026-01-01' };
    expect(rateRowFormSchema.safeParse({ ...base, value: '18', currency: 'QAR' }).success).toBe(
      true,
    );
    expect(
      rateRowFormSchema.safeParse({ ...base, value: '1.23456', currency: 'QAR' }).success,
    ).toBe(false);
    expect(rateRowFormSchema.safeParse({ ...base, value: '18', currency: 'qar' }).success).toBe(
      false,
    );
  });
});
