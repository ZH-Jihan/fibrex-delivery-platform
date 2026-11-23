/**
 * Tracking: shared request schemas for the morning call sheet (phase 4 row 4.7; SPEC 3.3).
 *
 * Purpose: one definition of the call sheet's query and the bodies of the tracking entry,
 * call log and ID-operator period routes, used by the API and the call sheet screen (row 4.8)
 * so both refuse the same input with the same message.
 *
 * Business rules carried here (the database repeats the first as a CHECK):
 *   - Taking someone off the road (inactive, blocked, terminated) always says why: a reason
 *     from the `status_reason` list is required.
 *   - An effective date belongs to a status: no status, no date. Without a date the status
 *     takes effect on the entry's date.
 *   - An ID-operator period names the operator (a person record or at least a name); a COD
 *     amount at handover carries its currency; the end date is not before the start.
 *
 * Depends on: zod, ../money (decimal and currency), ../states (state code).
 * Used by: apps/api modules/tracking, apps/web tracking screens (row 4.8).
 */
import { z } from 'zod';
import { currencyCodeSchema, decimalStringSchema } from '../money/index.js';
import { stateCodeSchema } from '../states/index.js';

const isoDate = z.iso.date();
const note = z.string().trim().min(1).max(2000);

/** Statuses that need a reason (SPEC 3.3; the `tracking_entry_reason_ck` CHECK). */
export const TRACKING_REASON_REQUIRED: readonly string[] = ['inactive', 'blocked', 'terminated'];

/** Where a recorded status stands against the employee status machine. */
export const TRACKING_STATUS_STATES = [
  'none',
  'unchanged',
  'applied',
  'pending',
  'failed',
  'superseded',
] as const;
export type TrackingStatusState = (typeof TRACKING_STATUS_STATES)[number];

/**
 * Cross-check findings (SPEC 3.3 "Cross-check"):
 *   active_no_orders      our status is active, the sheet's day had no orders for them;
 *   inactive_with_orders  our status is not active, yet the sheet shows orders;
 *   status_mismatch       the sheet's own status (blocked, inactive ...) differs from ours;
 *   sheet_not_updated     the sheet marks the person "not updated".
 */
export const CROSS_CHECK_KINDS = [
  'active_no_orders',
  'inactive_with_orders',
  'status_mismatch',
  'sheet_not_updated',
] as const;
export type CrossCheckKind = (typeof CROSS_CHECK_KINDS)[number];

/** `GET /tracking` and `GET /tracking/cross-check`: the day of the sheet (default today). */
export const trackingDateQuerySchema = z.object({
  date: isoDate.optional(),
});

const reasonRule = (b: { statusCode?: string | null; reasonId?: string | null }) =>
  b.statusCode === undefined ||
  b.statusCode === null ||
  !TRACKING_REASON_REQUIRED.includes(b.statusCode) ||
  (b.reasonId !== undefined && b.reasonId !== null);

/** `POST /tracking/entries`: the first record of a person on a date. */
export const trackingEntryCreateSchema = z
  .strictObject({
    partyId: z.uuid(),
    /** The sheet's date; defaults to today. */
    businessDate: isoDate.optional(),
    /** A state of the employee status machine (active, inactive, blocked, terminated ...). */
    statusCode: stateCodeSchema.optional(),
    /** A value of the `status_reason` lookup. */
    reasonId: z.uuid().optional(),
    /** When the status takes effect; a future date is applied by the tracking job. */
    effectiveDate: isoDate.optional(),
    /** A value of the `call_outcome` lookup. */
    callOutcomeId: z.uuid().optional(),
    note: note.optional(),
  })
  .refine(reasonRule, { path: ['reasonId'], message: 'Choose a reason for this status.' })
  .refine((b) => b.effectiveDate === undefined || b.statusCode !== undefined, {
    path: ['effectiveDate'],
    message: 'An effective date needs a status.',
  });
export type TrackingEntryCreateInput = z.infer<typeof trackingEntryCreateSchema>;

/**
 * `PATCH /tracking/entries/{id}`: change the day's record. A status given here is a new
 * status change (the earlier one stays in the history); null clears an optional field.
 */
export const trackingEntryUpdateSchema = z
  .strictObject({
    version: z.number().int().min(1),
    statusCode: stateCodeSchema.optional(),
    reasonId: z.uuid().nullable().optional(),
    effectiveDate: isoDate.optional(),
    callOutcomeId: z.uuid().nullable().optional(),
    note: note.nullable().optional(),
  })
  .refine(reasonRule, { path: ['reasonId'], message: 'Choose a reason for this status.' })
  .refine((b) => b.effectiveDate === undefined || b.statusCode !== undefined, {
    path: ['effectiveDate'],
    message: 'An effective date needs a status.',
  });
export type TrackingEntryUpdateInput = z.infer<typeof trackingEntryUpdateSchema>;

/** `POST /tracking/calls`: one call attempt (insert-only). */
export const trackingCallCreateSchema = z.strictObject({
  partyId: z.uuid(),
  businessDate: isoDate.optional(),
  /** A value of the `call_outcome` lookup. */
  outcomeId: z.uuid(),
  note: note.optional(),
  /** When the call was made; defaults to now. */
  at: z.iso.datetime().optional(),
});
export type TrackingCallCreateInput = z.infer<typeof trackingCallCreateSchema>;

const operatorFields = {
  /** The operator, when they are a known person. */
  operatorPartyId: z.uuid().nullable().optional(),
  operatorName: z.string().trim().min(1).max(200).nullable().optional(),
  operatorPhone: z.string().trim().min(3).max(40).nullable().optional(),
  toDate: isoDate.nullable().optional(),
  codAtHandover: decimalStringSchema.nullable().optional(),
  currency: currencyCodeSchema.nullable().optional(),
  ordersAtHandover: z.number().int().min(0).nullable().optional(),
};

/** `POST /tracking/operator-periods`: someone else works a person's platform ID from a date. */
export const operatorPeriodCreateSchema = z
  .strictObject({
    /** The platform ID (a `party_identifier`, e.g. a Falcon ID) being worked. */
    partyIdentifierId: z.uuid(),
    fromDate: isoDate,
    ...operatorFields,
  })
  .refine((b) => (b.operatorPartyId ?? null) !== null || (b.operatorName ?? null) !== null, {
    path: ['operatorName'],
    message: 'Name the person working the ID.',
  })
  .refine((b) => (b.toDate ?? null) === null || (b.toDate ?? '') >= b.fromDate, {
    path: ['toDate'],
    message: 'The end date cannot be before the start date.',
  })
  .refine((b) => (b.codAtHandover ?? null) === null || (b.currency ?? null) !== null, {
    path: ['currency'],
    message: 'Give the currency of the COD amount.',
  });
export type OperatorPeriodCreateInput = z.infer<typeof operatorPeriodCreateSchema>;

/** `PATCH /tracking/operator-periods/{id}`: end the period or correct its details. */
export const operatorPeriodUpdateSchema = z.strictObject({
  version: z.number().int().min(1),
  fromDate: isoDate.optional(),
  ...operatorFields,
});
export type OperatorPeriodUpdateInput = z.infer<typeof operatorPeriodUpdateSchema>;
