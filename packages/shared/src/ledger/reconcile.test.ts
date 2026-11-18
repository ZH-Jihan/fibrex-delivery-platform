import { describe, expect, it } from 'vitest';
import {
  bankMatchRuleCreateSchema,
  daysBetween,
  lineSatisfiesConditions,
  matchConditionsSchema,
  windowDaysOf,
} from './reconcile.js';

const line = (
  amount: string,
  reference: string | null = null,
  description: string | null = null,
) => ({
  amount,
  reference,
  description,
});

describe('lineSatisfiesConditions', () => {
  it('holds for every line when there are no conditions', () => {
    expect(lineSatisfiesConditions(line('10.0000'), {})).toBe(true);
    expect(lineSatisfiesConditions(line('-10.0000'), {})).toBe(true);
  });

  it('uses the sign for direction and the absolute value for the amount range', () => {
    expect(lineSatisfiesConditions(line('-250.2500'), { direction: 'out' })).toBe(true);
    expect(lineSatisfiesConditions(line('250.2500'), { direction: 'out' })).toBe(false);
    expect(
      lineSatisfiesConditions(line('-250.2500'), { amountMin: '250.25', amountMax: '300' }),
    ).toBe(true);
    expect(lineSatisfiesConditions(line('-250.2499'), { amountMin: '250.25' })).toBe(false);
    expect(lineSatisfiesConditions(line('300.0001'), { amountMax: '300' })).toBe(false);
  });

  it('looks for text in the reference and the description, ignoring case', () => {
    expect(
      lineSatisfiesConditions(line('5', null, 'Fuel purchase'), { textContains: 'FUEL' }),
    ).toBe(true);
    expect(lineSatisfiesConditions(line('5', 'INV-77', null), { textContains: 'inv-7' })).toBe(
      true,
    );
    expect(lineSatisfiesConditions(line('5', 'R1', 'Rent'), { textContains: 'fuel' })).toBe(false);
    expect(lineSatisfiesConditions(line('5', ' inv-1 '), { referenceEquals: 'INV-1' })).toBe(true);
    expect(lineSatisfiesConditions(line('5', 'INV-12'), { referenceEquals: 'INV-1' })).toBe(false);
  });

  it('needs every given condition to hold', () => {
    const c = { direction: 'in' as const, textContains: 'acme' };
    expect(lineSatisfiesConditions(line('9', null, 'ACME Ltd'), c)).toBe(true);
    expect(lineSatisfiesConditions(line('-9', null, 'ACME Ltd'), c)).toBe(false);
    expect(lineSatisfiesConditions(line('9', null, 'Other'), c)).toBe(false);
  });
});

describe('schemas and helpers', () => {
  it('refuses unknown keys, a reversed range and a window above 30 days', () => {
    expect(matchConditionsSchema.safeParse({ colour: 'red' }).success).toBe(false);
    expect(matchConditionsSchema.safeParse({ amountMin: '10', amountMax: '5' }).success).toBe(
      false,
    );
    expect(matchConditionsSchema.safeParse({ dateWindowDays: 31 }).success).toBe(false);
    expect(matchConditionsSchema.safeParse({ amountMin: '1.00001' }).success).toBe(false);
    expect(matchConditionsSchema.safeParse({ dateWindowDays: 0 }).success).toBe(true);
  });

  it('fills the rule defaults', () => {
    const rule = bankMatchRuleCreateSchema.parse({ name: 'Rent' });
    expect(rule).toMatchObject({
      priority: 100,
      active: true,
      conditions: {},
      targetPartyId: null,
    });
  });

  it('computes the window and day gaps', () => {
    expect(windowDaysOf(null)).toBe(3);
    expect(windowDaysOf({ dateWindowDays: 0 })).toBe(0);
    expect(daysBetween('2026-11-01', '2026-11-04')).toBe(3);
    expect(daysBetween('2026-11-04', '2026-11-01')).toBe(3);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });
});
