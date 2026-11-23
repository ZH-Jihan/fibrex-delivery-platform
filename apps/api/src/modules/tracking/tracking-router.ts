/**
 * Tracking API: the morning call sheet (phase 4 row 4.7; SPEC 3.3, PLAN 5.13).
 *
 *   GET   /tracking?date=                       the call sheet: rows and summary strip
 *   GET   /tracking/cross-check?date=           sheet status and figures against our status
 *   GET   /tracking/{partyId}/history           entries, status history, calls, operator periods
 *   POST  /tracking/entries                     the day's entry of a person (outcome, status ...)
 *   PATCH /tracking/entries/{id}                change it (a new status is a new status change)
 *   POST  /tracking/calls                       log one call attempt
 *   POST  /tracking/operator-periods            someone else works a person's platform ID
 *   PATCH /tracking/operator-periods/{id}       end or correct that period
 *
 * Permissions: tracking.entry.view (read), tracking.entry.create / update (entries and
 * operator periods), tracking.call.create (calls), and tracking.status.apply plus the
 * employee status permission for a status change (./tracking-service.ts).
 *
 * Rules enforced here, and why:
 *   - Operator periods: one operator per platform ID on any day (database exclusion rule,
 *     returned as 409 `operator_period_overlap`); the operator is never the ID's owner; the
 *     owner comes from the identifier, never from the body.
 *   - Calls are insert-only (the table has no UPDATE grant for history's sake).
 *   - Nothing is ever deleted: every table is retire-only and audited by its trigger.
 *
 * Depends on: express, zod, @fibrex/shared, kernel/db, kernel/http, kernel/permissions,
 * ./call-sheet.ts, ./tracking-service.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  CROSS_CHECK_KINDS,
  TRACKING_STATUS_STATES,
  operatorPeriodCreateSchema,
  operatorPeriodUpdateSchema,
  trackingCallCreateSchema,
  trackingDateQuerySchema,
  trackingEntryCreateSchema,
  trackingEntryUpdateSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { createRepository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { EMPLOYEE_ENTITY } from '../people/index.js';
import {
  callView,
  loadCallSheet,
  lookupCodes,
  operatorView,
  type OperatorView,
} from './call-sheet.js';
import {
  CALL_CREATE,
  ENTRY_CREATE,
  ENTRY_UPDATE,
  ENTRY_VIEW,
  entryView,
  type TrackingService,
} from './tracking-service.js';

const day = z.iso.date();
const idParams = z.object({ id: z.uuid() });
const partyParams = z.object({ partyId: z.uuid() });
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

type OperatorRow = Parameters<typeof operatorView>[0];

// ---- Response schemas (OpenAPI) ----
const entrySchema = z
  .object({
    id: z.uuid(),
    partyId: z.uuid(),
    businessDate: day,
    statusCode: z.string().nullable(),
    reasonId: z.uuid().nullable(),
    effectiveDate: day.nullable(),
    statusState: z.enum(TRACKING_STATUS_STATES),
    statusAppliedAt: z.iso.datetime().nullable(),
    statusError: z.string().nullable(),
    stateHistoryId: z.uuid().nullable(),
    callOutcomeId: z.uuid().nullable(),
    callerUserId: z.uuid().nullable(),
    note: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'TrackingEntry' });
const callSchema = z
  .object({
    id: z.uuid(),
    businessDate: day,
    at: z.iso.datetime(),
    outcomeId: z.uuid(),
    outcomeCode: z.string().nullable(),
    callerUserId: z.uuid().nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: 'TrackingCall' });
const operatorSchema = z
  .object({
    id: z.uuid(),
    partyIdentifierId: z.uuid(),
    ownerPartyId: z.uuid(),
    operatorPartyId: z.uuid().nullable(),
    operatorName: z.string().nullable(),
    operatorPhone: z.string().nullable(),
    fromDate: day,
    toDate: day.nullable(),
    codAtHandover: z.string().nullable(),
    currency: z.string().nullable(),
    ordersAtHandover: z.number().int().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'TrackingOperatorPeriod' });
const sheetStatusSchema = z.object({ text: z.string(), code: z.string().nullable() }).nullable();
const rowSchema = z
  .object({
    partyId: z.uuid(),
    employeeId: z.uuid(),
    employeeCode: z.string(),
    name: z.string(),
    platformIds: z.array(z.object({ identifierId: z.uuid(), type: z.string(), value: z.string() })),
    profession: z.string(),
    zone: z.string().nullable(),
    phone: z.string().nullable(),
    statusCode: z.string().nullable(),
    yesterday: z.object({
      orders: z.number().int().nullable(),
      hours: z.number().nullable(),
      lateMinutes: z.number().int().nullable(),
    }),
    sheetStatus: sheetStatusSchema,
    entry: entrySchema.nullable(),
    calledToday: z.boolean(),
    lastCall: callSchema.nullable(),
    operator: operatorSchema.nullable(),
    crossCheck: z.array(z.enum(CROSS_CHECK_KINDS)),
  })
  .meta({ id: 'TrackingRow' });
const summarySchema = z
  .object({
    totalPeople: z.number().int(),
    called: z.number().int(),
    notCalled: z.number().int(),
    ordersYesterday: z.number().int(),
    hoursYesterday: z.number(),
    zeroOrders: z.number().int(),
    statusChangesToday: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    operatedByOthers: z.number().int(),
    crossCheckFlags: z.number().int(),
  })
  .meta({ id: 'TrackingSummary' });
const sheetSchema = z
  .object({
    date: day,
    figuresDate: day,
    reported: z.boolean(),
    summary: summarySchema,
    rows: z.array(rowSchema),
  })
  .meta({ id: 'TrackingSheet' });
const crossCheckSchema = z
  .object({
    date: day,
    figuresDate: day,
    reported: z.boolean(),
    items: z.array(
      z.object({
        partyId: z.uuid(),
        employeeCode: z.string(),
        name: z.string(),
        platformIds: z.array(z.string()),
        ourStatus: z.string().nullable(),
        sheetStatus: sheetStatusSchema,
        orders: z.number().int().nullable(),
        kinds: z.array(z.enum(CROSS_CHECK_KINDS)),
      }),
    ),
  })
  .meta({ id: 'TrackingCrossCheck' });
const historySchema = z
  .object({
    partyId: z.uuid(),
    employeeId: z.uuid(),
    entries: z.array(entrySchema),
    statusHistory: z.array(
      z.object({
        id: z.uuid(),
        fromCode: z.string().nullable(),
        toCode: z.string(),
        effectiveDate: day,
        reasonId: z.uuid().nullable(),
        note: z.string().nullable(),
        actorId: z.uuid().nullable(),
        at: z.iso.datetime(),
      }),
    ),
    calls: z.array(callSchema),
    operatorPeriods: z.array(operatorSchema),
  })
  .meta({ id: 'TrackingHistory' });

export interface TrackingRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  tracking: TrackingService;
}

/** The exclusion rule "one operator per ID at a time" as a 409 the screen can show. */
async function guardOverlap<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
    if (text.includes('id_operator_period_no_overlap')) {
      throw new ConflictError(
        'operator_period_overlap',
        'Someone else is already recorded as working this ID on some of these days.',
      );
    }
    throw err;
  }
}

export function createTrackingRouter(deps: TrackingRouterDeps): Router {
  const { uow, registry, permissions, tracking } = deps;
  const operators = createRepository<OperatorRow>({ model: 'idOperatorPeriod', scope: 'company' });
  const router = Router();
  /** The state service's today (UTC date), for "status on a date". */
  const utcToday = () => new Date().toISOString().slice(0, 10);

  router.get('/tracking', async (req, res) => {
    const query = trackingDateQuerySchema.parse(req.query);
    const result = await uow.run(async (db) => {
      await permissions.require(ENTRY_VIEW);
      return loadCallSheet(db, query.date ?? tracking.today(), utcToday());
    });
    res.json(result);
  });

  router.get('/tracking/cross-check', async (req, res) => {
    const query = trackingDateQuerySchema.parse(req.query);
    const result = await uow.run(async (db) => {
      await permissions.require(ENTRY_VIEW);
      const sheet = await loadCallSheet(db, query.date ?? tracking.today(), utcToday());
      return {
        date: sheet.date,
        figuresDate: sheet.figuresDate,
        reported: sheet.reported,
        items: sheet.rows
          .filter((row) => row.crossCheck.length > 0)
          .map((row) => ({
            partyId: row.partyId,
            employeeCode: row.employeeCode,
            name: row.name,
            platformIds: row.platformIds.map((p) => p.value),
            ourStatus: row.statusCode,
            sheetStatus: row.sheetStatus,
            orders: row.yesterday.orders,
            kinds: row.crossCheck,
          })),
      };
    });
    res.json(result);
  });

  router.get('/tracking/:partyId/history', async (req, res) => {
    const { partyId } = partyParams.parse(req.params);
    const result = await uow.run(async (db) => {
      await permissions.require(ENTRY_VIEW);
      const employee = await db.employee.findFirst({
        where: { partyId, deletedAt: null },
        select: { id: true },
      });
      if (employee === null) throw new NotFoundError();
      const entries = await db.trackingEntry.findMany({
        where: { partyId, deletedAt: null },
        orderBy: [{ businessDate: 'desc' }, { id: 'desc' }],
      });
      const history = await db.stateHistory.findMany({
        where: { entityType: EMPLOYEE_ENTITY, entityId: employee.id },
        orderBy: [{ id: 'asc' }],
      });
      const calls = await db.callLog.findMany({
        where: { partyId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
      });
      const periods = await db.idOperatorPeriod.findMany({
        where: { ownerPartyId: partyId, deletedAt: null },
        orderBy: [{ fromDate: 'desc' }],
      });
      const codes = await lookupCodes(
        db,
        calls.map((c) => c.outcomeId),
      );
      return {
        partyId,
        employeeId: employee.id,
        entries: entries.map(entryView),
        statusHistory: history.map((h) => ({
          id: h.id,
          fromCode: h.fromCode,
          toCode: h.toCode,
          effectiveDate: isoDay(h.effectiveDate),
          reasonId: h.reasonId,
          note: h.note,
          actorId: h.actorId,
          at: h.createdAt.toISOString(),
        })),
        calls: calls.map((c) => callView(c, codes)),
        operatorPeriods: periods.map(operatorView),
      };
    });
    res.json(result);
  });

  router.post('/tracking/entries', async (req, res) => {
    const body = trackingEntryCreateSchema.parse(req.body);
    const result = await uow.run(() => tracking.createEntry(body));
    res.status(201).json(result);
  });

  router.patch('/tracking/entries/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = trackingEntryUpdateSchema.parse(req.body);
    const result = await uow.run(() => tracking.updateEntry(id, body));
    res.json(result);
  });

  router.post('/tracking/calls', async (req, res) => {
    const body = trackingCallCreateSchema.parse(req.body);
    const result = await uow.run(async (db) => {
      await permissions.require(CALL_CREATE);
      const { context } = currentUnit();
      const employee = await tracking.employeeOf(body.partyId);
      const outcome = await tracking.lookupValue(body.outcomeId, 'call_outcome', 'outcomeId');
      const row = await db.callLog.create({
        data: {
          tenantId: context.tenantId,
          companyId: employee.companyId,
          partyId: body.partyId,
          businessDate: toDay(body.businessDate ?? tracking.today()),
          callerUserId: context.userId ?? null,
          outcomeId: body.outcomeId,
          note: body.note ?? null,
          ...(body.at === undefined ? {} : { at: new Date(body.at) }),
        },
      });
      return callView(row, new Map([[outcome.id, outcome.code]]));
    });
    res.status(201).json(result);
  });

  router.post('/tracking/operator-periods', async (req, res) => {
    const body = operatorPeriodCreateSchema.parse(req.body);
    const result: OperatorView = await uow.run(async (db) => {
      await permissions.require(ENTRY_CREATE);
      const identifier = await db.partyIdentifier.findFirst({
        where: { id: body.partyIdentifierId, deletedAt: null },
        select: { id: true, partyId: true, companyId: true },
      });
      if (identifier === null) throw new NotFoundError('This platform ID does not exist.');
      if (body.operatorPartyId === identifier.partyId) {
        throw new UnprocessableError(
          'operator_is_owner',
          'The owner works their own ID; record another person here.',
        );
      }
      const row = await guardOverlap(() =>
        operators.create({
          companyId: identifier.companyId,
          partyIdentifierId: identifier.id,
          ownerPartyId: identifier.partyId,
          operatorPartyId: body.operatorPartyId ?? null,
          operatorName: body.operatorName ?? null,
          operatorPhone: body.operatorPhone ?? null,
          fromDate: toDay(body.fromDate),
          toDate: body.toDate == null ? null : toDay(body.toDate),
          codAtHandover: body.codAtHandover ?? null,
          currency: body.currency ?? null,
          ordersAtHandover: body.ordersAtHandover ?? null,
        }),
      );
      return operatorView(row);
    });
    res.status(201).json(result);
  });

  router.patch('/tracking/operator-periods/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = operatorPeriodUpdateSchema.parse(req.body);
    const result: OperatorView = await uow.run(async () => {
      await permissions.require(ENTRY_UPDATE);
      const current = await operators.get(id);
      if (body.operatorPartyId != null && body.operatorPartyId === current.ownerPartyId) {
        throw new UnprocessableError(
          'operator_is_owner',
          'The owner works their own ID; record another person here.',
        );
      }
      const changes: Record<string, unknown> = {};
      if (body.fromDate !== undefined) changes.fromDate = toDay(body.fromDate);
      if (body.toDate !== undefined)
        changes.toDate = body.toDate === null ? null : toDay(body.toDate);
      for (const key of [
        'operatorPartyId',
        'operatorName',
        'operatorPhone',
        'codAtHandover',
        'currency',
        'ordersAtHandover',
      ] as const) {
        if (body[key] !== undefined) changes[key] = body[key];
      }
      const row = await guardOverlap(() => operators.update(id, body.version, changes));
      return operatorView(row);
    });
    res.json(result);
  });

  const tags = ['Tracking'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/tracking',
    tags,
    summary:
      'The morning call sheet of a date (default today): riders and drivers, yesterday’s figures, the day’s entry, last call and summary strip',
    request: { query: trackingDateQuerySchema },
    responses: { 200: { description: 'The call sheet', content: json(sheetSchema) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/tracking/cross-check',
    tags,
    summary: 'People whose sheet status or figures do not match our employee status',
    request: { query: trackingDateQuerySchema },
    responses: { 200: { description: 'The differences', content: json(crossCheckSchema) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/tracking/{partyId}/history',
    tags,
    summary: 'A person’s call sheet entries, dated status history, calls and ID-operator periods',
    request: { params: partyParams },
    responses: { 200: { description: 'The history', content: json(historySchema) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/tracking/entries',
    tags,
    summary:
      'Record the day’s entry of a person (call outcome, status, reason, effective date, note); a status is applied to the employee now or on its effective date',
    request: { body: { content: json(trackingEntryCreateSchema) } },
    responses: { 201: { description: 'Recorded', content: json(entrySchema) } },
  });
  registerRoute(registry, {
    method: 'patch',
    path: '/tracking/entries/{id}',
    tags,
    summary: 'Change the day’s entry; a status given here is a new status change',
    request: { params: idParams, body: { content: json(trackingEntryUpdateSchema) } },
    responses: { 200: { description: 'Changed', content: json(entrySchema) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/tracking/calls',
    tags,
    summary: 'Log one call attempt (who called, when, outcome, note)',
    request: { body: { content: json(trackingCallCreateSchema) } },
    responses: { 201: { description: 'Logged', content: json(callSchema) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/tracking/operator-periods',
    tags,
    summary: 'Record that another person works a platform ID from a date',
    request: { body: { content: json(operatorPeriodCreateSchema) } },
    responses: { 201: { description: 'Recorded', content: json(operatorSchema) } },
  });
  registerRoute(registry, {
    method: 'patch',
    path: '/tracking/operator-periods/{id}',
    tags,
    summary: 'End or correct an ID-operator period',
    request: { params: idParams, body: { content: json(operatorPeriodUpdateSchema) } },
    responses: { 200: { description: 'Changed', content: json(operatorSchema) } },
  });
  return router;
}
