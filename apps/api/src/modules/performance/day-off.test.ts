/**
 * Row 4.8d: day off for the figures date and the call date, and the shared zero-orders rule.
 * Invented people and dates only. 2026-11-20 is a Friday.
 */
import { describe, expect, it } from 'vitest';
import {
  dayOffFlags,
  isDayOffOn,
  isZeroOrderProblem,
  parseWeekdays,
  weekdayOf,
} from './day-off.js';

describe('parseWeekdays (the one parser)', () => {
  it('reads full names, short names, lists and any case', () => {
    expect(parseWeekdays('Friday')).toEqual([5]);
    expect(parseWeekdays('fri')).toEqual([5]);
    expect(parseWeekdays('THURS')).toEqual([4]);
    expect(parseWeekdays('Tues')).toEqual([2]);
    expect(parseWeekdays('Fri, Sat')).toEqual([5, 6]);
    expect(parseWeekdays('Sunday & Monday')).toEqual([0, 1]);
  });

  it('reads "Not updated", empty, null and other words as no day off', () => {
    expect(parseWeekdays('Not updated')).toEqual([]);
    expect(parseWeekdays('NOT UPDATED')).toEqual([]);
    expect(parseWeekdays('')).toEqual([]);
    expect(parseWeekdays('   ')).toEqual([]);
    expect(parseWeekdays(null)).toEqual([]);
    expect(parseWeekdays(undefined)).toEqual([]);
    expect(parseWeekdays('Rotation B')).toEqual([]);
    expect(parseWeekdays('Monthly')).toEqual([]);
  });
});

describe('weekdayOf and isDayOffOn', () => {
  it('uses the weekday of the calendar date', () => {
    expect(weekdayOf('2026-11-20')).toBe(5);
    expect(isDayOffOn('Friday', '2026-11-20')).toBe(true);
    expect(isDayOffOn('Friday', '2026-11-21')).toBe(false);
    expect(isDayOffOn(null, '2026-11-20')).toBe(false);
  });
});

describe('dayOffFlags: the figures date and the call date on their own', () => {
  // Call date Sunday 2026-11-22, figures date Saturday 2026-11-21.
  const FIGURES = '2026-11-21';
  const CALL = '2026-11-22';

  it('day off on the figures date only', () => {
    expect(dayOffFlags('Saturday', FIGURES, CALL)).toEqual({
      onFiguresDate: true,
      onCallDate: false,
    });
  });

  it('day off on the call date only', () => {
    expect(dayOffFlags('Sun', FIGURES, CALL)).toEqual({ onFiguresDate: false, onCallDate: true });
  });

  it('two days off, one on each date', () => {
    expect(dayOffFlags('Sat, Sun', FIGURES, CALL)).toEqual({
      onFiguresDate: true,
      onCallDate: true,
    });
  });

  it('no day off set, "Not updated" or empty: neither date is a day off', () => {
    for (const text of [null, '', 'Not updated']) {
      expect(dayOffFlags(text, FIGURES, CALL)).toEqual({
        onFiguresDate: false,
        onCallDate: false,
      });
    }
  });

  it('month boundary: call date 1 December has its figures on 30 November', () => {
    // 2026-11-30 is a Monday and 2026-12-01 a Tuesday.
    expect(dayOffFlags('Monday', '2026-11-30', '2026-12-01')).toEqual({
      onFiguresDate: true,
      onCallDate: false,
    });
    expect(dayOffFlags('Tuesday', '2026-11-30', '2026-12-01')).toEqual({
      onFiguresDate: false,
      onCallDate: true,
    });
  });

  it('year boundary: call date 1 January 2027 has its figures on 31 December 2026', () => {
    // 2026-12-31 is a Thursday and 2027-01-01 a Friday.
    expect(dayOffFlags('Thu', '2026-12-31', '2027-01-01')).toEqual({
      onFiguresDate: true,
      onCallDate: false,
    });
  });
});

describe('isZeroOrderProblem', () => {
  it('flags no orders on a reported day that was not a day off', () => {
    expect(isZeroOrderProblem(0, true, false)).toBe(true);
    // A person the sheet has no row for delivered nothing on a reported day.
    expect(isZeroOrderProblem(null, true, false)).toBe(true);
  });

  it('does not flag no orders on the day off', () => {
    expect(isZeroOrderProblem(0, true, true)).toBe(false);
    expect(isZeroOrderProblem(null, true, true)).toBe(false);
  });

  it('never flags an unreported day or a person with orders', () => {
    expect(isZeroOrderProblem(0, false, false)).toBe(false);
    expect(isZeroOrderProblem(3, true, false)).toBe(false);
  });
});
