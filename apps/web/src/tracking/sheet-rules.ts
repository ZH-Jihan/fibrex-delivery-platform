/**
 * Marks on the morning call sheet (phase 4 rows 4.8a, 4.8b).
 *
 * Rules, and why:
 *   - Zero orders counts only when the platform sheet reported the day. A day nobody has figures
 *     for is a reset, never a zero (same rule as the performance reports, row 4.6a). On a
 *     reported day a person the sheet has no row for delivered nothing, so they count too; this
 *     is the same rule the server uses for the summary strip and the "zero orders" filter.
 *   - Low hours: under the company's limit of active hours yesterday on a day the person did
 *     take orders. The limit is a company setting (default 4), sent by the server with the sheet.
 *
 * Depends on: nothing. Used by: ./CallSheetPage.tsx.
 */
export function isZeroOrders(orders: number | null, reported: boolean): boolean {
  return reported && (orders ?? 0) === 0;
}

export function isLowHours(hours: number | null, reported: boolean, limit: number): boolean {
  return reported && hours !== null && hours < limit;
}
