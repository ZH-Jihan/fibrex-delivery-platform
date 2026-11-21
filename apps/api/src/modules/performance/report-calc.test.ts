/**
 * Unit tests for the performance report arithmetic (row 4.6a): reset guard (only reported days
 * count), zero days, averages, runs of no orders and the acceptance-rate display rule.
 * All people and numbers are invented.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptancePercent,
  hoursOf,
  indexFigures,
  longestZeroRun,
  totalsFor,
  type DayFigure,
} from './report-calc.js';
import { thisAndLastCycle } from './performance-reports.js';

const figure = (date: string, orders: number, workingMinutes = 0): DayFigure => ({
  partyId: 'p1',
  date,
  orders,
  workingMinutes,
  lateMinutes: null,
  acceptanceRate: null,
  kms: null,
});

describe('totalsFor', () => {
  const days = indexFigures([
    figure('2026-11-01', 5, 300),
    figure('2026-11-02', 0, 60),
    figure('2026-11-04', 3, 120),
  ]).get('p1');

  it('counts only reported days: an unreported date is never a zero', () => {
    // 11-03 has no figures for anybody (a reset or missed sync), so it is not a zero day.
    const t = totalsFor('p1', days, ['2026-11-01', '2026-11-02', '2026-11-04']);
    expect(t.zeroDays).toBe(1);
    expect(t.daysWorked).toBe(3);
    expect(t.totalOrders).toBe(8);
    expect(t.totalHours).toBe(8);
    expect(t.avgOrdersPerActiveDay).toBe(2.67);
    expect(t.ordersPerHour).toBe(1);
    // The same person with 11-03 added as a reported day gets one more zero.
    const withGap = totalsFor('p1', days, ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(withGap.zeroDays).toBe(2);
    expect(withGap.daysWorked).toBe(3);
  });

  it('gives zeros, not NaN, for a person with no figures', () => {
    const t = totalsFor('p2', undefined, ['2026-11-01', '2026-11-02']);
    expect(t).toMatchObject({
      totalOrders: 0,
      totalHours: 0,
      daysWorked: 0,
      zeroDays: 2,
      avgOrdersPerActiveDay: 0,
      ordersPerHour: 0,
    });
  });
});

describe('longestZeroRun', () => {
  const run = (zeroDates: string[], reported: string[]) =>
    longestZeroRun(
      indexFigures(
        reported.filter((d) => !zeroDates.includes(d)).map((d) => figure(d, 4)),
      ).get('p1'),
      reported,
    );

  it('finds consecutive reported zero days', () => {
    const reported = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
    expect(run(['2026-11-02', '2026-11-03', '2026-11-04'], reported)).toEqual({
      days: 3,
      from: '2026-11-02',
      to: '2026-11-04',
    });
  });

  it('is broken by a date nobody reported', () => {
    // 11-03 missing from the platform: the two zero days either side are not one run of 4.
    const reported = ['2026-11-01', '2026-11-02', '2026-11-04', '2026-11-05'];
    expect(run(reported, reported)?.days).toBe(2);
  });

  it('is null when every day has orders', () => {
    expect(run([], ['2026-11-01', '2026-11-02'])).toBeNull();
  });

  it('crosses a month end', () => {
    const reported = ['2026-10-30', '2026-10-31', '2026-11-01'];
    expect(run(reported, reported)).toEqual({ days: 3, from: '2026-10-30', to: '2026-11-01' });
  });
});

describe('display helpers', () => {
  it('shows hours with two decimals', () => {
    expect(hoursOf(450)).toBe(7.5);
    expect(hoursOf(100)).toBe(1.67);
  });

  it('shows acceptance as a percentage whether the sheet stores a fraction or a percentage', () => {
    expect(acceptancePercent(0.935)).toBe(93.5);
    expect(acceptancePercent(1)).toBe(100);
    expect(acceptancePercent(88)).toBe(88);
    expect(acceptancePercent(null)).toBeNull();
  });
});

describe('thisAndLastCycle', () => {
  it('uses the Qatar date and the 26th start day (this cycle and the one before)', () => {
    // 2026-11-25 22:30 UTC is already 2026-11-26 in Qatar: the new cycle has begun.
    expect(thisAndLastCycle(26, new Date('2026-11-25T22:30:00Z'))).toEqual({
      thisCycle: { start: '2026-11-26', end: '2026-12-25' },
      lastCycle: { start: '2026-10-26', end: '2026-11-25' },
    });
    // 2026-11-25 20:30 UTC is still the 25th in Qatar (23:30).
    expect(thisAndLastCycle(26, new Date('2026-11-25T20:30:00Z')).thisCycle).toEqual({
      start: '2026-10-26',
      end: '2026-11-25',
    });
    // A year boundary.
    expect(thisAndLastCycle(26, new Date('2027-01-10T08:00:00Z')).lastCycle).toEqual({
      start: '2026-11-26',
      end: '2026-12-25',
    });
  });
});
