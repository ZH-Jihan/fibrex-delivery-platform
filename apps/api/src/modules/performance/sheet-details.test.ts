/**
 * Unit tests of the sheet detail parsing (phase 4 row 4.8c): invented sheet values only.
 * Covers the "day off today" mark, duty time and break reading, "Not updated", and the rule
 * that amounts stay out without the permission.
 */
import { describe, expect, it } from 'vitest';
import {
  isDayOffOn,
  parseBreak,
  parseDutyTime,
  parseSheetFields,
  parseWeekdays,
  weekdayOf,
} from './sheet-details.js';

// 2026-11-20 is a Friday.
const FRIDAY = '2026-11-20';
const SATURDAY = '2026-11-21';

describe('day off', () => {
  it('reads weekday names, short names and lists', () => {
    expect(parseWeekdays('Friday')).toEqual([5]);
    expect(parseWeekdays('FRI')).toEqual([5]);
    expect(parseWeekdays('Fri, Sat')).toEqual([5, 6]);
    expect(parseWeekdays('Friday & sunday')).toEqual([0, 5]);
    expect(parseWeekdays('Not updated')).toEqual([]);
    expect(parseWeekdays(null)).toEqual([]);
  });

  it('marks the day off only on the matching weekday of the chosen date', () => {
    expect(weekdayOf(FRIDAY)).toBe(5);
    expect(isDayOffOn('Friday', FRIDAY)).toBe(true);
    expect(isDayOffOn('Friday', SATURDAY)).toBe(false);
    expect(isDayOffOn('Fri, Sat', SATURDAY)).toBe(true);
    // Words that are not weekdays never mark anyone as off.
    expect(isDayOffOn('Rotation B', FRIDAY)).toBe(false);
    expect(isDayOffOn(null, FRIDAY)).toBe(false);
  });
});

describe('duty time and break', () => {
  it('splits a schedule into from and to, also across midnight', () => {
    expect(parseDutyTime('14:00-02:00')).toEqual({
      from: '14:00',
      to: '02:00',
      text: null,
      notUpdated: false,
    });
    expect(parseDutyTime('9:30 - 18:00')).toMatchObject({ from: '09:30', to: '18:00' });
  });

  it('shows NA as empty, unknown text as it is, and Not updated with the flag', () => {
    expect(parseDutyTime('NA')).toEqual({ from: null, to: null, text: null, notUpdated: false });
    expect(parseDutyTime('Flexible')).toMatchObject({ from: null, text: 'Flexible' });
    expect(parseDutyTime('Not updated')).toEqual({
      from: null,
      to: null,
      text: null,
      notUpdated: true,
    });
    expect(parseDutyTime('  NOT UPDATED ').notUpdated).toBe(true);
    expect(parseDutyTime(null).notUpdated).toBe(false);
  });

  it('reads the break from its two cells', () => {
    expect(parseBreak('16:00', '17:00')).toEqual({
      from: '16:00',
      to: '17:00',
      text: null,
      notUpdated: false,
    });
    expect(parseBreak('16:00', null)).toMatchObject({ from: '16:00', to: null });
    expect(parseBreak(null, null)).toEqual({ from: null, to: null, text: null, notUpdated: false });
    expect(parseBreak('Not updated', '17:00')).toMatchObject({ notUpdated: true, from: null });
  });
});

describe('parseSheetFields', () => {
  const metrics = {
    _fields: {
      day_off: 'Friday',
      schedule: '14:00-02:00',
      break_start: '16:00',
      break_end: '17:00',
      zone: 'North Gate',
      plate_number: '123456',
      vehicle_type: 'Rider',
      skill: 'Express',
      tags: 'Night shift',
      pending_amount: 125.5,
      balance_amount: -40,
    },
  };

  it('gives friendly values and four-place amounts in QAR with the permission', () => {
    const d = parseSheetFields(metrics, FRIDAY, { withAmounts: true });
    expect(d.dayOff).toMatchObject({
      text: 'Friday',
      weekdays: [5],
      onCallDate: true,
      onFiguresDate: false,
    });
    expect(d.dutyTime.from).toBe('14:00');
    expect(d.break.to).toBe('17:00');
    expect(d.cod).toEqual({ amount: '125.5000', currency: 'QAR' });
    expect(d.balance).toEqual({ amount: '-40.0000', currency: 'QAR' });
  });

  it('leaves both amounts out without the permission', () => {
    const d = parseSheetFields(metrics, FRIDAY, { withAmounts: false });
    expect(d.cod).toBeNull();
    expect(d.balance).toBeNull();
    expect(JSON.stringify(d)).not.toContain('125.5');
  });

  it('lists what the sheet says is not updated, without inventing values', () => {
    const d = parseSheetFields(
      { _fields: { day_off: 'Not updated', schedule: 'Not updated', zone: 'Not updated' } },
      FRIDAY,
      { withAmounts: true },
    );
    expect(d.dayOff).toMatchObject({
      text: null,
      onCallDate: false,
      onFiguresDate: false,
      notUpdated: true,
    });
    expect(d.zone).toBeNull();
    expect(d.notUpdatedFields).toEqual(['day_off', 'schedule', 'zone']);
    expect(d.cod).toBeNull();
  });
});
