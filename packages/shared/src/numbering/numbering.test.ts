import { describe, expect, it } from 'vitest';
import {
  numberSequenceFormSchema,
  parsePattern,
  patternProblem,
  renderNumber,
  resetPeriod,
} from './index.js';

const date = new Date('2026-03-07T10:00:00Z');

describe('numbering patterns', () => {
  it('renders the patterns from the phase plan', () => {
    expect(renderNumber('L{0000}', { prefix: '', padding: 4, value: 1, date })).toBe('L0001');
    expect(renderNumber('INV-{YYYY}-{00000}', { prefix: '', padding: 4, value: 42, date })).toBe(
      'INV-2026-00042',
    );
    expect(renderNumber('{prefix}{number}', { prefix: 'PS', padding: 6, value: 7, date })).toBe(
      'PS000007',
    );
    expect(renderNumber('{YY}{MM}/{000}', { prefix: '', padding: 4, value: 1234, date })).toBe(
      '2603/1234',
    );
    expect(renderNumber('{0000}', { prefix: '', padding: 4, value: 10n ** 11n, date })).toBe(
      '100000000000',
    );
  });

  it('refuses patterns the allocator could not render', () => {
    expect(() => parsePattern('L')).toThrow('exactly one running number');
    expect(() => parsePattern('{0000}-{000}')).toThrow('exactly one running number');
    expect(() => parsePattern('{abc}')).toThrow('Unknown token {abc}');
    expect(() => parsePattern('L{0000')).toThrow('never closed');
    expect(() => parsePattern('L}0000')).toThrow('Unexpected "}"');
    expect(() => parsePattern('{0000000000000}')).toThrow('At most 12 digits');
  });

  it('ties the reset policy to the date tokens', () => {
    expect(patternProblem('L{0000}', 'never')).toBeNull();
    expect(patternProblem('L{0000}', 'yearly')).toContain('{YYYY}');
    expect(patternProblem('L{YY}{0000}', 'yearly')).toBeNull();
    expect(patternProblem('L{YYYY}{0000}', 'monthly')).toContain('{MM}');
    expect(patternProblem('{YYYY}{MM}-{0000}', 'monthly')).toBeNull();
    expect(patternProblem('{nope}', 'never')).toBe('Unknown token {nope}');
  });

  it('computes reset periods in UTC', () => {
    expect(resetPeriod('never', date)).toBe('');
    expect(resetPeriod('yearly', date)).toBe('2026');
    expect(resetPeriod('monthly', date)).toBe('2026-03');
    expect(resetPeriod('monthly', new Date('2026-03-31T23:30:00Z'))).toBe('2026-03');
  });

  it('form schema coerces numbers and reports the pattern problem on the format field', () => {
    const ok = numberSequenceFormSchema.safeParse({
      key: 'loan',
      prefix: '',
      format: 'L{0000}',
      padding: '4',
      resetPolicy: 'never',
      nextValue: '1',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.padding).toBe(4);
    const bad = numberSequenceFormSchema.safeParse({
      key: 'Loan',
      prefix: '',
      format: 'L{0000}',
      padding: 4,
      resetPolicy: 'yearly',
      nextValue: 1,
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.map((i) => i.path[0])).toEqual(
        expect.arrayContaining(['key', 'format']),
      );
    }
  });
});
