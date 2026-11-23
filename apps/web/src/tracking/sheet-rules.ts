/**
 * Marks on the morning call sheet (phase 4 rows 4.8a, 4.8b, 4.8d).
 *
 * Rules, and why:
 *   - Zero orders counts only when the platform sheet reported the day. A day nobody has figures
 *     for is a reset, never a zero (same rule as the performance reports, row 4.6a). On a
 *     reported day a person the sheet has no row for delivered nothing, so they count too; this
 *     is the same rule the server uses for the summary strip and the "zero orders" filter.
 *   - Day off (row 4.8d): the figures are from the day before the sheet's date. When that day was
 *     the person's weekly day off, no orders and low hours are expected, so neither is a
 *     problem. The server works out the flag (`sheet.dayOff.onFiguresDate`); the screen only
 *     passes it in, so the screen and the server never disagree.
 *   - Low hours: under the company's limit of active hours yesterday on a day the person did
 *     take orders. The limit is a company setting (default 4), sent by the server with the sheet.
 *
 * Depends on: nothing. Used by: ./CallSheetPage.tsx.
 */
export function isZeroOrders(
  orders: number | null,
  reported: boolean,
  dayOffOnFiguresDate = false,
): boolean {
  return reported && !dayOffOnFiguresDate && (orders ?? 0) === 0;
}

export function isLowHours(
  hours: number | null,
  reported: boolean,
  limit: number,
  dayOffOnFiguresDate = false,
): boolean {
  return reported && !dayOffOnFiguresDate && hours !== null && hours < limit;
}
