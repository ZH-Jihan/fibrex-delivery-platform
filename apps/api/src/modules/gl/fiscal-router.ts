/**
 * Ledger set-up API, part 2 (phase 2 row 2.14; PLAN 5.11): fiscal years and periods.
 *
 *   /fiscal-years                       CRUD; creating a year creates its monthly periods
 *   GET /fiscal-periods                 periods ordered by start date (filters fiscalYearId, status)
 *   GET /fiscal-periods/{id}
 *   POST /fiscal-periods/{id}/close     open -> closed            (gl.fiscal_period.close)
 *   POST /fiscal-periods/{id}/lock      closed -> locked          (gl.fiscal_period.lock)
 *   POST /fiscal-periods/{id}/reopen    closed or locked -> open  (gl.fiscal_period.reopen,
 *                                       plus gl.fiscal_period.unlock for a locked one; reason)
 *
 * What the statuses mean (the posting service, row 2.15, refuses any posting into a period
 * that is not open, in a database trigger):
 *   open    postings allowed.
 *   closed  month-end done; an accountant may reopen it to correct something.
 *   locked  final (reported, audited); reopening needs the separate unlock permission.
 *
 * Rules, and why:
 *   1. A year's periods are calendar months (packages/shared `fiscalPeriods`); years and
 *      periods of one company never overlap (database exclusion constraints). After creation
 *      only the name of a year changes: its dates fix its periods.
 *   2. Close in date order: a period closes only when every earlier period of the company is
 *      closed or locked, and locks only when every earlier one is locked. Otherwise a later
 *      month could be final while an earlier one still takes postings that change its
 *      opening balances.
 *   3. Reopen in reverse order: only when every later period is open, for the same reason.
 *      A reason is required and kept on the period (and in the audit log).
 *   4. A year is `closed` when none of its periods is open, `open` otherwise; kept in step
 *      by every move.
 *   5. A year is deleted only while all its periods are open; its periods go to the recycle
 *      bin and come back with it. (Row 2.15 adds: not when it has journals.)
 *   6. Every move carries If-Match (the period's version), so two people closing the same
 *      period at once get one success and one 409.
 *
 * Depends on: express, zod, @fibrex/shared (fiscalPeriods), kernel/db, kernel/http,
 * kernel/permissions. Used by: ./index.ts (the gl module manifest).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { defaultFiscalYearEnd, fiscalPeriods } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { VersionConflictError } from '../../kernel/db/optimistic-lock.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../../kernel/http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../../kernel/http/errors.js';
import { problemSchema, registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';

export type FiscalYearRecord = NonNullable<Awaited<ReturnType<Db['glFiscalYear']['findFirst']>>>;
export type FiscalPeriodRecord = NonNullable<
  Awaited<ReturnType<Db['glFiscalPeriod']['findFirst']>>
>;

const day = z.iso.date();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const PERIOD_STATUSES = ['open', 'closed', 'locked'] as const;

const yearCreate = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    startDate: day,
    /** Default: one day before the same date a year later. */
    endDate: day.optional(),
  })
  .superRefine((b, ctx) => {
    try {
      fiscalPeriods(b.startDate, b.endDate ?? defaultFiscalYearEnd(b.startDate));
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: err instanceof Error ? err.message : 'Invalid dates.',
      });
    }
  });
const yearUpdate = z.strictObject({ name: z.string().trim().min(1).max(100) }).partial();
const yearItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    name: z.string(),
    startDate: day,
    endDate: day,
    status: z.enum(['open', 'closed']),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'FiscalYear' });

const periodItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    fiscalYearId: z.uuid(),
    periodNo: z.number().int(),
    startDate: day,
    endDate: day,
    status: z.enum(PERIOD_STATUSES),
    closedBy: z.uuid().nullable(),
    closedAt: z.iso.datetime().nullable(),
    lockedBy: z.uuid().nullable(),
    lockedAt: z.iso.datetime().nullable(),
    reopenedBy: z.uuid().nullable(),
    reopenedAt: z.iso.datetime().nullable(),
    reopenReason: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'FiscalPeriod' });
const periodQuery = z.object({
  fiscalYearId: z.uuid().optional(),
  status: z.enum(PERIOD_STATUSES).optional(),
});
const idParams = z.object({ id: z.uuid() });
const reopenBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

export const toFiscalYearItem = (row: FiscalYearRecord) => ({
  id: row.id,
  companyId: row.companyId,
  name: row.name,
  startDate: isoDay(row.startDate),
  endDate: isoDay(row.endDate),
  status: row.status as 'open' | 'closed',
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

export const toFiscalPeriodItem = (row: FiscalPeriodRecord) => ({
  id: row.id,
  companyId: row.companyId,
  fiscalYearId: row.fiscalYearId,
  periodNo: row.periodNo,
  startDate: isoDay(row.startDate),
  endDate: isoDay(row.endDate),
  status: row.status as (typeof PERIOD_STATUSES)[number],
  closedBy: row.closedBy,
  closedAt: row.closedAt?.toISOString() ?? null,
  lockedBy: row.lockedBy,
  lockedAt: row.lockedAt?.toISOString() ?? null,
  reopenedBy: row.reopenedBy,
  reopenedAt: row.reopenedAt?.toISOString() ?? null,
  reopenReason: row.reopenReason,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Rule 1 backstop: the exclusion constraint as a 409 the screen can show. */
async function guardOverlap<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
    if (text.includes('fiscal_year_no_overlap') || text.includes('fiscal_period_no_overlap')) {
      throw new ConflictError(
        'gl_fiscal_year_overlap',
        'These dates overlap another fiscal year of this company.',
      );
    }
    throw err;
  }
}

/** Rule 4: the year's status follows its periods. */
async function syncYearStatus(fiscalYearId: string): Promise<void> {
  const { db, context } = currentUnit();
  const open = await db.glFiscalPeriod.count({
    where: { fiscalYearId, status: 'open', deletedAt: null },
  });
  const status = open > 0 ? 'open' : 'closed';
  await db.glFiscalYear.updateMany({
    where: { id: fiscalYearId, status: { not: status } },
    data: {
      status,
      version: { increment: 1 },
      updatedAt: new Date(),
      updatedBy: context.userId ?? null,
    },
  });
}

/** The repository behind `/fiscal-years` and the recycle bin; adds rules 1 and 5. */
export function createFiscalYearRepository(): Repository<FiscalYearRecord> {
  const base = createRepository<FiscalYearRecord>({ model: 'glFiscalYear', scope: 'company' });
  return {
    ...base,
    list: (options) =>
      base.list({ ...options, orderBy: options.orderBy ?? [{ startDate: 'desc' }] }),
    create: async (data) => {
      const body = data as z.infer<typeof yearCreate>;
      const endDate = body.endDate ?? defaultFiscalYearEnd(body.startDate);
      const year = await guardOverlap(() =>
        base.create({
          name: body.name,
          startDate: toDay(body.startDate),
          endDate: toDay(endDate),
        }),
      );
      const { db, context } = currentUnit();
      await guardOverlap(() =>
        db.glFiscalPeriod.createMany({
          data: fiscalPeriods(body.startDate, endDate).map((p) => ({
            tenantId: year.tenantId,
            companyId: year.companyId,
            fiscalYearId: year.id,
            periodNo: p.periodNo,
            startDate: toDay(p.startDate),
            endDate: toDay(p.endDate),
            createdBy: context.userId ?? null,
            updatedBy: context.userId ?? null,
          })),
        }),
      );
      return year;
    },
    softDelete: async (id, version, reason) => {
      const { db, context } = currentUnit();
      const notOpen = await db.glFiscalPeriod.count({
        where: { fiscalYearId: id, deletedAt: null, status: { not: 'open' } },
      });
      if (notOpen > 0) {
        throw new UnprocessableError(
          'gl_fiscal_year_in_use',
          'A period of this year is closed or locked; only a year whose periods are all open can be deleted.',
        );
      }
      const deleted = await base.softDelete(id, version, reason);
      // Rule 5: the periods go to the recycle bin with the year (same reason, same moment).
      await db.glFiscalPeriod.updateMany({
        where: { fiscalYearId: id, deletedAt: null },
        data: {
          deletedAt: deleted.deletedAt ?? new Date(),
          deletedBy: context.userId ?? null,
          deleteReason: reason ?? 'fiscal year deleted',
          version: { increment: 1 },
        },
      });
      return deleted;
    },
    restore: async (id, version) => {
      const restored = await guardOverlap(() => base.restore(id, version));
      // Periods are never deleted on their own, so every deleted period of the year returns.
      await guardOverlap(() =>
        currentUnit().db.glFiscalPeriod.updateMany({
          where: { fiscalYearId: id, deletedAt: { not: null } },
          data: {
            deletedAt: null,
            deletedBy: null,
            deleteReason: null,
            version: { increment: 1 },
          },
        }),
      );
      return restored;
    },
  };
}

export interface FiscalRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

type Move = 'close' | 'lock' | 'reopen';

export function createFiscalRouter(deps: FiscalRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  const periods = createRepository<FiscalPeriodRecord>({
    model: 'glFiscalPeriod',
    scope: 'company',
  });

  router.use(
    createCrudRouter<FiscalYearRecord>(crud, {
      path: '/fiscal-years',
      resource: 'gl.fiscal_year',
      tag: 'Fiscal years',
      repository: createFiscalYearRepository(),
      schemas: { create: yearCreate, update: yearUpdate, item: yearItem },
      toItem: toFiscalYearItem,
    }),
  );

  router.get('/fiscal-periods', async (req, res) => {
    const query = periodQuery.parse(req.query);
    const rows = await uow.run(async () => {
      await permissions.require('gl.fiscal_period.read');
      return currentUnit().db.glFiscalPeriod.findMany({
        where: { ...query, deletedAt: null },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        take: 500,
      });
    });
    res.json({ items: rows.map(toFiscalPeriodItem) });
  });

  router.get('/fiscal-periods/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const row = await uow.run(async () => {
      await permissions.require('gl.fiscal_period.read');
      return periods.get(id);
    });
    res.setHeader('ETag', `"${String(row.version)}"`).json(toFiscalPeriodItem(row));
  });

  /**
   * One status move. Steps: check the permission(s), load the period, check its status,
   * check the neighbours (rules 2 and 3), write the period with If-Match (rule 6), then bring
   * the year's status in step (rule 4) - all in one transaction.
   */
  async function move(id: string, expected: number, kind: Move, reason?: string) {
    const { db, context } = currentUnit();
    await permissions.require(`gl.fiscal_period.${kind}`);
    const current = await periods.get(id);
    // Rule 6 first: a screen showing an old status gets a 409 with the current period, not a
    // rule message about a status it never saw.
    if (current.version !== expected) {
      throw new VersionConflictError(expected, current, []);
    }
    const now = new Date();
    const who = context.userId ?? null;
    const earlier = {
      companyId: current.companyId,
      deletedAt: null,
      startDate: { lt: current.startDate },
    };
    const later = {
      companyId: current.companyId,
      deletedAt: null,
      startDate: { gt: current.startDate },
    };
    const notAllowed = (detail: string) => new UnprocessableError('gl_period_status', detail);
    let changes: Record<string, unknown>;

    if (kind === 'close') {
      if (current.status !== 'open') throw notAllowed('Only an open period can be closed.');
      const blocking = await db.glFiscalPeriod.findFirst({
        where: { ...earlier, status: 'open' },
        orderBy: { startDate: 'asc' },
      });
      if (blocking !== null) {
        throw notAllowed(
          `Close the period starting ${isoDay(blocking.startDate)} first; periods close in date order.`,
        );
      }
      changes = { status: 'closed', closedBy: who, closedAt: now };
    } else if (kind === 'lock') {
      if (current.status !== 'closed') throw notAllowed('Only a closed period can be locked.');
      const blocking = await db.glFiscalPeriod.findFirst({
        where: { ...earlier, status: { not: 'locked' } },
        orderBy: { startDate: 'asc' },
      });
      if (blocking !== null) {
        throw notAllowed(
          `Lock the period starting ${isoDay(blocking.startDate)} first; periods lock in date order.`,
        );
      }
      changes = { status: 'locked', lockedBy: who, lockedAt: now };
    } else {
      if (current.status === 'open') throw notAllowed('This period is already open.');
      // A locked period is final: reopening it needs the unlock permission as well.
      if (current.status === 'locked') await permissions.require('gl.fiscal_period.unlock');
      const blocking = await db.glFiscalPeriod.findFirst({
        where: { ...later, status: { not: 'open' } },
        orderBy: { startDate: 'desc' },
      });
      if (blocking !== null) {
        throw notAllowed(
          `Reopen the period starting ${isoDay(blocking.startDate)} first; periods reopen from the latest back.`,
        );
      }
      // closed_by/closed_at and locked_by/locked_at stay as history of the last close; the
      // database only needs them for closed and locked rows.
      changes = { status: 'open', reopenedBy: who, reopenedAt: now, reopenReason: reason ?? null };
    }
    const row = await periods.update(id, expected, changes);
    await syncYearStatus(row.fiscalYearId);
    return row;
  }

  for (const kind of ['close', 'lock', 'reopen'] as const) {
    router.post(`/fiscal-periods/:id/${kind}`, async (req, res) => {
      const { id } = idParams.parse(req.params);
      const expected = parseIfMatch(req.get('If-Match'));
      let reason: string | undefined;
      if (kind === 'reopen') {
        const parsed = reopenBody.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new ValidationError([
            {
              path: 'reason',
              message: 'Give a reason for reopening (3 to 500 characters).',
              code: 'reason_required',
            },
          ]);
        }
        reason = parsed.data.reason;
      }
      try {
        const row = await uow.run(() => move(id, expected, kind, reason));
        res.setHeader('ETag', `"${String(row.version)}"`).json(toFiscalPeriodItem(row));
      } catch (err) {
        if (err instanceof VersionConflictError) {
          throw err.presentedWith((row) =>
            toFiscalPeriodItem(row as unknown as FiscalPeriodRecord),
          );
        }
        throw err;
      }
    });
  }

  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/fiscal-periods',
    tags: ['Fiscal years'],
    summary: 'Fiscal periods ordered by start date',
    request: { query: periodQuery },
    responses: {
      200: {
        description: 'The periods',
        content: { 'application/json': { schema: z.object({ items: z.array(periodItem) }) } },
      },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/fiscal-periods/{id}',
    tags: ['Fiscal years'],
    summary: 'One fiscal period',
    request: { params: idParams },
    responses: {
      200: { description: 'The period', content: { 'application/json': { schema: periodItem } } },
      404: problem('No such period'),
    },
  });
  const summaries: Record<Move, string> = {
    close: 'Close an open period (earlier periods must be closed; If-Match required)',
    lock: 'Lock a closed period (earlier periods must be locked; If-Match required)',
    reopen:
      'Reopen a closed or locked period with a reason (later periods must be open; a locked one needs gl.fiscal_period.unlock; If-Match required)',
  };
  for (const kind of ['close', 'lock', 'reopen'] as const) {
    registerRoute(registry, {
      method: 'post',
      path: `/fiscal-periods/{id}/${kind}`,
      tags: ['Fiscal years'],
      summary: summaries[kind],
      request: {
        params: idParams,
        ...(kind === 'reopen'
          ? { body: { content: { 'application/json': { schema: reopenBody } } } }
          : {}),
      },
      responses: {
        200: { description: 'The period', content: { 'application/json': { schema: periodItem } } },
        403: problem('Missing permission'),
        404: problem('No such period'),
        409: problem('Version conflict'),
        422: problem('The move is not allowed in this status or order'),
      },
    });
  }

  return router;
}
