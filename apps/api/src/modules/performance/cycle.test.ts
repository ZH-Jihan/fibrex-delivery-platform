import { describe, expect, it } from 'vitest';
import { addDays, blockDate, cycleContaining } from './cycle.js';

describe('cycleContaining', () => {
  it('runs from the 26th to the 25th for Snoonu', () => {
    expect(cycleContaining('2026-11-19', 26)).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(cycleContaining('2026-11-25', 26)).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(cycleContaining('2026-11-26', 26)).toEqual({ start: '2026-11-26', end: '2026-12-25' });
  });

  it('crosses the year and handles February', () => {
    expect(cycleContaining('2027-01-10', 26)).toEqual({ start: '2026-12-26', end: '2027-01-25' });
    expect(cycleContaining('2026-12-31', 26)).toEqual({ start: '2026-12-26', end: '2027-01-25' });
    expect(cycleContaining('2028-02-27', 26)).toEqual({ start: '2028-02-26', end: '2028-03-25' });
  });

  it('is the calendar month when the cycle starts on the 1st', () => {
    expect(cycleContaining('2026-02-14', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('refuses bad input', () => {
    expect(() => cycleContaining('2026-02-30', 26)).toThrow(/real date/);
    expect(() => cycleContaining('2026-11-19', 29)).toThrow(/1 to 28/);
  });
});

describe('blockDate', () => {
  const cycle = { start: '2026-10-26', end: '2026-11-25' };

  it('puts days from the start day in the first month and the rest in the next', () => {
    expect(blockDate(cycle, 26, 26)).toBe('2026-10-26');
    expect(blockDate(cycle, 26, 31)).toBe('2026-10-31');
    expect(blockDate(cycle, 26, 1)).toBe('2026-11-01');
    expect(blockDate(cycle, 26, 25)).toBe('2026-11-25');
  });

  it('has no date for a day the month lacks, and crosses the year', () => {
    expect(blockDate({ start: '2026-11-26', end: '2026-12-25' }, 26, 31)).toBeNull();
    expect(blockDate({ start: '2027-02-26', end: '2027-03-25' }, 26, 29)).toBeNull();
    expect(blockDate({ start: '2028-02-26', end: '2028-03-25' }, 26, 29)).toBe('2028-02-29');
    expect(blockDate({ start: '2026-12-26', end: '2027-01-25' }, 26, 3)).toBe('2027-01-03');
    expect(blockDate(cycle, 26, 0)).toBeNull();
    expect(blockDate(cycle, 26, 32)).toBeNull();
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-12-01', -1)).toBe('2026-11-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
