/**
 * Marks on the morning call sheet (phase 4 row 4.8a).
 *
 * Rules, and why:
 *   - Zero orders counts only when the platform sheet reported the day. A day nobody has figures
 *     for is a reset, never a zero (same rule as the performance reports, row 4.6a).
 *   - Low hours: under LOW_HOURS active hours yesterday on a day the person did take orders.
 *     LOW_HOURS is a first working value chosen for the screen, not a stored company setting; the
 *     owner should confirm it (listed in PROGRESS.md).
 *
 * Depends on: nothing. Used by: ./CallSheetPage.tsx.
 */
export const LOW_HOURS = 4;

export function isZeroOrders(orders: number | null, reported: boolean): boolean {
  return reported && orders === 0;
}

export function isLowHours(hours: number | null, reported: boolean): boolean {
  return reported && hours !== null && hours < LOW_HOURS;
}
