/** Row 4.6b: summary arithmetic and schedule rule, invented names only. */
import { describe, expect, it } from 'vitest';
import { dueSummaryDate, localClock, summariseDay } from './summary-calc.js';

const p = (name: string, orders: number, workingMinutes = 0) => ({ name, orders, workingMinutes });

describe('summariseDay', () => {
  it('totals, counts people with and without orders, and ranks by orders then name', () => {
    const people = [
      p('Anan', 10, 480),
      p('Bela', 10, 360),
      p('Cem', 7, 300),
      p('Dara', 5),
      p('Eli', 4),
      p('Fay', 3),
      p('Gus', 2),
      p('Hana', 1),
      p('Ivo', 0),
      p('Jun', 0),
    ];
    const out = summariseDay(people);
    expect(out.peopleWithOrders).toBe(8);
    expect(out.zeroOrders).toBe(2);
    expect(out.totalOrders).toBe(42);
    expect(out.totalHours).toBe(19);
    expect(out.best.map((l) => l.name)).toEqual(['Anan', 'Bela', 'Cem', 'Dara', 'Eli']);
    expect(out.best[0]).toEqual({ rank: 1, name: 'Anan', orders: 10, hours: 8 });
    // Weakest: fewest first, never someone already on the best list.
    expect(out.worst.map((l) => l.name)).toEqual(['Ivo', 'Jun', 'Hana', 'Gus', 'Fay']);
  });

  it('does not list a person twice on a small team and never ranks a zero as best', () => {
    const out = summariseDay([p('Anan', 3), p('Bela', 0)]);
    expect(out.best.map((l) => l.name)).toEqual(['Anan']);
    expect(out.worst.map((l) => l.name)).toEqual(['Bela']);
    expect(summariseDay([])).toMatchObject({ peopleWithOrders: 0, totalOrders: 0, zeroOrders: 0 });
  });
});

describe('dueSummaryDate', () => {
  it('is due from the send time on, for the day before the local date', () => {
    // 2026-11-20 06:59 in Qatar (UTC+3) = 03:59 UTC; 07:00 = 04:00 UTC.
    expect(dueSummaryDate('07:00', 'Asia/Qatar', new Date('2026-11-20T03:59:00Z'))).toBeNull();
    expect(dueSummaryDate('07:00', 'Asia/Qatar', new Date('2026-11-20T04:00:00Z'))).toBe(
      '2026-11-19',
    );
    expect(dueSummaryDate('07:00', 'Asia/Qatar', new Date('2026-11-20T10:00:00Z'))).toBe(
      '2026-11-19',
    );
    // Just after local midnight it is not due yet; the day before is already in the log.
    expect(dueSummaryDate('07:00', 'Asia/Qatar', new Date('2026-11-20T21:30:00Z'))).toBeNull();
  });

  it('uses the company time zone for the local date', () => {
    expect(localClock('Asia/Qatar', new Date('2026-11-19T21:30:00Z'))).toEqual({
      date: '2026-11-20',
      minutes: 30,
    });
  });
});

describe('summariseDay: day off (row 4.8d)', () => {
  it('does not count a person with no orders on their day off, nor list them as weakest', () => {
    const out = summariseDay([
      { ...p('Anan', 6, 300) },
      { ...p('Bela', 0), dayOff: true },
      { ...p('Cem', 0) },
      { ...p('Dara', 2, 60), dayOff: true },
    ]);
    // Only Cem had no orders on a working day.
    expect(out.zeroOrders).toBe(1);
    // A day off with orders still counts as a person with orders.
    expect(out.peopleWithOrders).toBe(2);
    expect(out.worst.map((l) => l.name)).toEqual(['Cem']);
  });
});
