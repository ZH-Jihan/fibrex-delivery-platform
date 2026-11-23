/**
 * Unit tests for the call sheet arithmetic: the sheet's status words, the cross-check rules
 * and the summary strip. Invented values only.
 */
import { describe, expect, it } from 'vitest';
import { crossCheck, sheetStatusOf, summarise, type SummaryRow } from './tracking-calc.js';

describe('sheetStatusOf', () => {
  it('reads a status column before the tags, case and spacing ignored', () => {
    expect(
      sheetStatusOf({ _extra: { ' Account  Status ': 'BLOCKED' }, _fields: { tags: 'Active' } }),
    ).toEqual({ text: 'BLOCKED', code: 'blocked' });
  });

  it('tells "not updated" and "inactive" apart from "active"', () => {
    expect(sheetStatusOf({ _fields: { tags: 'Not Updated' } })?.code).toBe('not_updated');
    expect(sheetStatusOf({ _fields: { tags: 'In-active' } })?.code).toBe('inactive');
    expect(sheetStatusOf({ _fields: { tags: 'Active rider' } })?.code).toBe('active');
  });

  it('keeps unknown words without reading them, and says nothing for empty cells', () => {
    expect(sheetStatusOf({ _fields: { tags: 'VIP' } })).toEqual({ text: 'VIP', code: null });
    expect(sheetStatusOf({ _fields: { tags: '  ' }, _extra: { Status: null } })).toBeNull();
    expect(sheetStatusOf(null)).toBeNull();
  });
});

describe('crossCheck', () => {
  const base = { reported: true, sheet: null };

  it('flags active with no orders, and not active with orders', () => {
    expect(crossCheck({ ...base, ourStatus: 'active', orders: 0 })).toEqual(['active_no_orders']);
    expect(crossCheck({ ...base, ourStatus: 'active', orders: null })).toEqual([
      'active_no_orders',
    ]);
    expect(crossCheck({ ...base, ourStatus: 'inactive', orders: 4 })).toEqual([
      'inactive_with_orders',
    ]);
    expect(crossCheck({ ...base, ourStatus: 'active', orders: 3 })).toEqual([]);
  });

  it('never reads a day the sync missed as zero orders', () => {
    expect(crossCheck({ ...base, reported: false, ourStatus: 'active', orders: null })).toEqual([]);
  });

  it('compares the sheet status with ours; "not updated" is its own flag', () => {
    expect(
      crossCheck({
        ...base,
        ourStatus: 'active',
        orders: 2,
        sheet: { text: 'Blocked', code: 'blocked' },
      }),
    ).toEqual(['status_mismatch']);
    expect(
      crossCheck({
        ...base,
        ourStatus: 'blocked',
        orders: 0,
        sheet: { text: 'Blocked', code: 'blocked' },
      }),
    ).toEqual([]);
    expect(
      crossCheck({
        ...base,
        ourStatus: 'active',
        orders: 5,
        sheet: { text: 'Not updated', code: 'not_updated' },
      }),
    ).toEqual(['sheet_not_updated']);
    expect(
      crossCheck({ ...base, ourStatus: 'active', orders: 5, sheet: { text: 'VIP', code: null } }),
    ).toEqual([]);
  });
});

describe('summarise', () => {
  const row = (over: Partial<SummaryRow>): SummaryRow => ({
    statusCode: 'active',
    called: false,
    orders: null,
    workingMinutes: null,
    statusChanged: false,
    operatedByOther: false,
    flagged: false,
    ...over,
  });

  it('adds up the strip', () => {
    const summary = summarise(
      [
        row({ called: true, orders: 10, workingMinutes: 470, statusChanged: true }),
        row({ orders: 0, workingMinutes: 20, operatedByOther: true, flagged: true }),
        row({ statusCode: 'blocked', called: true }),
      ],
      true,
    );
    expect(summary).toEqual({
      totalPeople: 3,
      called: 2,
      notCalled: 1,
      ordersYesterday: 10,
      hoursYesterday: 8.17,
      zeroOrders: 2,
      statusChangesToday: 1,
      byStatus: { active: 2, blocked: 1 },
      operatedByOthers: 1,
      crossCheckFlags: 1,
    });
  });

  it('counts no zero-order people on a day that was not reported', () => {
    expect(summarise([row({})], false).zeroOrders).toBe(0);
  });
});

describe('day off on the figures date (row 4.8d)', () => {
  it('does not cross-check "active but no orders" on the person\'s day off', () => {
    const base = { ourStatus: 'active', reported: true, orders: 0, sheet: null };
    expect(crossCheck(base)).toEqual(['active_no_orders']);
    expect(crossCheck({ ...base, dayOffOnFiguresDate: true })).toEqual([]);
    // The call date being a day off says nothing about the figures date; only the flag above counts.
    expect(crossCheck({ ...base, dayOffOnFiguresDate: false })).toEqual(['active_no_orders']);
  });

  it("leaves the day off out of the strip's zero-order count", () => {
    const row = (orders: number | null, dayOffOnFiguresDate?: boolean) => ({
      statusCode: 'active',
      called: false,
      orders,
      workingMinutes: 0,
      statusChanged: false,
      operatedByOther: false,
      flagged: false,
      ...(dayOffOnFiguresDate === undefined ? {} : { dayOffOnFiguresDate }),
    });
    const rows = [row(0, true), row(0), row(null), row(0, false), row(5, true)];
    expect(summarise(rows, true).zeroOrders).toBe(3);
    // Nothing is a zero on a day the sheet did not report.
    expect(summarise(rows, false).zeroOrders).toBe(0);
  });
});
