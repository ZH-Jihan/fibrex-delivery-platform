/**
 * Expiry alert rule and settings schema (phase 3 row 3.4).
 *
 * Depends on: ./expiry.ts. Used by: the shared unit test run.
 */
import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  dueExpiryWindows,
  DEFAULT_EXPIRY_SETTINGS,
  EXPIRED_WINDOW,
  expirySettingsSchema,
} from './expiry.js';

const due = (daysLeft: number, alerted: number[] = [], windows: number[] = [14, 7]) =>
  dueExpiryWindows({ daysLeft, windows, alerted });

describe('daysUntil', () => {
  it('counts whole calendar days, negative once passed', () => {
    expect(daysUntil('2026-11-19', '2026-11-19')).toBe(0);
    expect(daysUntil('2026-12-03', '2026-11-19')).toBe(14);
    expect(daysUntil('2026-11-16', '2026-11-19')).toBe(-3);
    // Across a month and a year end.
    expect(daysUntil('2027-01-02', '2026-12-30')).toBe(3);
  });
});

describe('dueExpiryWindows (owner rule: 14 and 7 days before only)', () => {
  it('alerts nothing outside the largest window', () => {
    expect(due(20)).toEqual([]);
    expect(due(15)).toEqual([]);
  });

  it('alerts the 14-day window from 14 days down to 8', () => {
    expect(due(14)).toEqual([14]);
    expect(due(10)).toEqual([14]);
  });

  it('alerts 7 after 14 was sent, and never a window twice', () => {
    expect(due(7, [14])).toEqual([7]);
    expect(due(7, [14, 7])).toEqual([]);
    expect(due(10, [14])).toEqual([]);
  });

  it('catches up missed windows at once (largest first)', () => {
    expect(due(5)).toEqual([14, 7]);
  });

  it('sends no email on the expiry day unless a 0 window is set', () => {
    expect(due(0)).toEqual([]);
    expect(due(0, [], [14, 7, 0])).toEqual([0]);
  });

  it('marks an expired document once, in-app only', () => {
    expect(due(-3)).toEqual([EXPIRED_WINDOW]);
    expect(due(-1, [14, 7])).toEqual([EXPIRED_WINDOW]);
    expect(due(-4, [EXPIRED_WINDOW])).toEqual([]);
  });

  it('follows per-type windows', () => {
    expect(due(30, [], [30])).toEqual([30]);
    expect(due(14, [], [30])).toEqual([30]);
  });
});

describe('expirySettingsSchema', () => {
  it('accepts the default and an email list', () => {
    expect(expirySettingsSchema.parse(DEFAULT_EXPIRY_SETTINGS).windows).toEqual([14, 7]);
    const ok = expirySettingsSchema.safeParse({
      emails: ['office@example.test', 'hr@example.test'],
      windows: [14, 7],
    });
    expect(ok.success).toBe(true);
  });

  it('refuses bad addresses, duplicates and out-of-range windows', () => {
    const bad = (body: unknown) => expirySettingsSchema.safeParse(body).success;
    expect(bad({ emails: ['not-an-email'], windows: [7] })).toBe(false);
    expect(bad({ emails: ['a@example.test', 'A@example.test'], windows: [7] })).toBe(false);
    expect(bad({ emails: [], windows: [7, 7] })).toBe(false);
    expect(bad({ emails: [], windows: [] })).toBe(false);
    expect(bad({ emails: [], windows: [400] })).toBe(false);
  });
});
