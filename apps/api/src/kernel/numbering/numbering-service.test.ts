import { describe, expect, it } from 'vitest';
import { nextValueFor } from './numbering-service.js';

const at = (iso: string) => new Date(iso);

describe('numbering reset rule', () => {
  it('never resets when the policy is never', () => {
    const row = { next_value: 42n, reset_policy: 'never' as const, last_reset_at: null };
    expect(nextValueFor(row, at('2030-01-01T00:00:00Z'))).toEqual({ value: 42n, reset: false });
  });

  it('restarts at 1 on the first allocation and in a new year', () => {
    const fresh = { next_value: 1n, reset_policy: 'yearly' as const, last_reset_at: null };
    expect(nextValueFor(fresh, at('2026-05-01T00:00:00Z'))).toEqual({ value: 1n, reset: true });
    const used = {
      next_value: 10n,
      reset_policy: 'yearly' as const,
      last_reset_at: at('2026-01-03T00:00:00Z'),
    };
    expect(nextValueFor(used, at('2026-12-31T23:59:59Z'))).toEqual({ value: 10n, reset: false });
    expect(nextValueFor(used, at('2027-01-01T00:00:00Z'))).toEqual({ value: 1n, reset: true });
  });

  it('restarts every month under the monthly policy', () => {
    const used = {
      next_value: 5n,
      reset_policy: 'monthly' as const,
      last_reset_at: at('2026-03-15T00:00:00Z'),
    };
    expect(nextValueFor(used, at('2026-03-31T00:00:00Z'))).toEqual({ value: 5n, reset: false });
    expect(nextValueFor(used, at('2026-04-01T00:00:00Z'))).toEqual({ value: 1n, reset: true });
  });
});
