/**
 * Snoonu FDB report check API (phase 4 row 4.9).
 *
 *   GET  /performance/fdb-check                 the newest run (or ?checkId=) with its differences,
 *                                               filtered by kind, document, review state, text
 *   GET  /performance/fdb-check/runs            the last runs (newest first)
 *   POST /performance/fdb-check/run             run the check now: body { syncSourceId,
 *                                               fileObjectId? } (an uploaded Excel copy, or the
 *                                               source's read-only reader)
 *   POST /performance/fdb-check/differences/{id}/review   mark open, reviewed or ignored (note)
 *
 * Permissions: `performance.fdb_check.read`, `.run`, `.review`. Nothing here changes an
 * employee, a document or a status; staff do that on the employee profile.
 *
 * Depends on: express, zod, kernel/db, kernel/http, ./fdb-service.ts, ./fdb-compare.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { NotFoundError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { FDB_DIFFERENCE_KINDS } from './fdb-compare.js';
import { FDB_DOC_KEYS } from './fdb-parser.js';
import type { FdbService } from './fdb-service.js';

export const FDB_READ = 'performance.fdb_check.read';
export const FDB_RUN = 'performance.fdb_check.run';
export const FDB_REVIEW = 'performance.fdb_check.review';

const MAX_DIFFERENCES = 2000;

const REVIEW_STATES = ['open', 'reviewed', 'ignored'] as const;

const listQuery = z.object({
  checkId: z.uuid().optional(),
  kind: z.enum(FDB_DIFFERENCE_KINDS).optional(),
  field: z.enum(FDB_DOC_KEYS).optional(),
  review: z.enum(REVIEW_STATES).optional(),
  q: z.string().trim().max(100).optional(),
});
const idParams = z.object({ id: z.uuid() });
const runBody = z.object({
  syncSourceId: z.uuid(),
  fileObjectId: z.uuid().optional(),
});
const reviewBody = z.object({
  status: z.enum(REVIEW_STATES),
  note: z.string().trim().max(500).optional(),
});

const checkItem = z
  .object({
    id: z.uuid(),
    businessDate: z.iso.date(),
    source: z.enum(['sheet', 'upload']),
    syncSourceId: z.uuid().nullable(),
    rowsRead: z.number().int(),
    matched: z.number().int(),
    unmatched: z.number().int(),
    differences: z.number().int(),
    createdAt: z.string(),
    createdBy: z.uuid().nullable(),
  })
  .meta({ id: 'FdbCheck' });
const differenceItem = z
  .object({
    id: z.uuid(),
    kind: z.enum(FDB_DIFFERENCE_KINDS),
    field: z.string().nullable(),
    partyId: z.uuid().nullable(),
    /** The employee record of that person, when there is one (for the profile link). */
    employeeId: z.uuid().nullable(),
    externalId: z.string().nullable(),
    displayName: z.string().nullable(),
    oursValue: z.string().nullable(),
    theirsValue: z.string().nullable(),
    reviewStatus: z.enum(REVIEW_STATES),
    reviewNote: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'FdbDifference' });
const listResponse = z
  .object({
    check: checkItem.nullable(),
    items: z.array(differenceItem),
    /** Differences of the whole run by kind (before the filters), open ones only. */
    openByKind: z.record(z.string(), z.number().int()),
    /** All differences of the run (before the filters). */
    total: z.number().int(),
    /** True when the list was cut at the safety limit. */
    truncated: z.boolean(),
  })
  .meta({ id: 'FdbCheckResult' });
const runResponse = z
  .object({
    checkId: z.uuid(),
    businessDate: z.iso.date(),
    rowsRead: z.number().int(),
    matched: z.number().int(),
    unmatched: z.number().int(),
    differences: z.number().int(),
    carriedOver: z.number().int(),
    positionalColumns: z.array(z.string()),
  })
  .meta({ id: 'FdbCheckRun' });

export interface FdbRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  fdb: FdbService;
}

interface CheckRow {
  id: string;
  businessDate: Date;
  source: string;
  syncSourceId: string | null;
  rowsRead: number;
  matched: number;
  unmatched: number;
  differencesCount: number;
  createdAt: Date;
  createdBy: string | null;
}

const toCheck = (c: CheckRow) => ({
  id: c.id,
  businessDate: c.businessDate.toISOString().slice(0, 10),
  source: c.source as 'sheet' | 'upload',
  syncSourceId: c.syncSourceId,
  rowsRead: c.rowsRead,
  matched: c.matched,
  unmatched: c.unmatched,
  differences: c.differencesCount,
  createdAt: c.createdAt.toISOString(),
  createdBy: c.createdBy,
});

export function createFdbRouter(deps: FdbRouterDeps): Router {
  const { uow, registry, permissions, fdb } = deps;
  const router = Router();

  router.get('/performance/fdb-check', async (req, res) => {
    const query = listQuery.parse(req.query);
    const body = await uow.run(async (db) => {
      await permissions.require(FDB_READ);
      const check =
        query.checkId === undefined
          ? await db.fdbCheck.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
          : await db.fdbCheck.findFirst({ where: { id: query.checkId } });
      if (check === null) {
        if (query.checkId !== undefined) throw new NotFoundError();
        return { check: null, items: [], openByKind: {}, total: 0, truncated: false };
      }
      const all = await db.fdbDifference.groupBy({
        by: ['kind', 'reviewStatus'],
        where: { fdbCheckId: check.id, deletedAt: null },
        _count: { _all: true },
      });
      const openByKind: Record<string, number> = {};
      let total = 0;
      for (const g of all) {
        total += g._count._all;
        if (g.reviewStatus === 'open') {
          openByKind[g.kind] = (openByKind[g.kind] ?? 0) + g._count._all;
        }
      }
      const q = query.q;
      const rows = await db.fdbDifference.findMany({
        where: {
          fdbCheckId: check.id,
          deletedAt: null,
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          ...(query.field === undefined ? {} : { field: query.field }),
          ...(query.review === undefined ? {} : { reviewStatus: query.review }),
          ...(q === undefined || q === ''
            ? {}
            : {
                OR: [
                  { displayName: { contains: q, mode: 'insensitive' as const } },
                  { externalId: { contains: q, mode: 'insensitive' as const } },
                ],
              }),
        },
        orderBy: [{ displayName: 'asc' }, { kind: 'asc' }, { field: 'asc' }, { id: 'asc' }],
        take: MAX_DIFFERENCES + 1,
      });
      const people = rows.flatMap((d) => (d.partyId === null ? [] : [d.partyId]));
      const employees =
        people.length === 0
          ? []
          : await db.employee.findMany({
              where: { partyId: { in: [...new Set(people)] }, deletedAt: null },
              select: { id: true, partyId: true },
            });
      const employeeOf = new Map(employees.map((e) => [e.partyId, e.id]));
      return {
        check: toCheck(check),
        items: rows.slice(0, MAX_DIFFERENCES).map((d) => ({
          id: d.id,
          kind: d.kind as (typeof FDB_DIFFERENCE_KINDS)[number],
          field: d.field,
          partyId: d.partyId,
          employeeId: d.partyId === null ? null : (employeeOf.get(d.partyId) ?? null),
          externalId: d.externalId,
          displayName: d.displayName,
          oursValue: d.oursValue,
          theirsValue: d.theirsValue,
          reviewStatus: d.reviewStatus as (typeof REVIEW_STATES)[number],
          reviewNote: d.reviewNote,
          reviewedAt: d.reviewedAt?.toISOString() ?? null,
          version: d.version,
        })),
        openByKind,
        total,
        truncated: rows.length > MAX_DIFFERENCES,
      };
    });
    res.json(body);
  });

  router.get('/performance/fdb-check/runs', async (_req, res) => {
    const items = await uow.run(async (db) => {
      await permissions.require(FDB_READ);
      const rows = await db.fdbCheck.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
      });
      return rows.map(toCheck);
    });
    res.json({ items });
  });

  router.post('/performance/fdb-check/run', async (req, res) => {
    const body = runBody.parse(req.body);
    await uow.run(async () => {
      await permissions.require(FDB_RUN);
    });
    res.json(await fdb.run(body));
  });

  router.post('/performance/fdb-check/differences/:id/review', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = reviewBody.parse(req.body);
    const out = await uow.run(async (db) => {
      await permissions.require(FDB_REVIEW);
      const found = await db.fdbDifference.findFirst({ where: { id, deletedAt: null } });
      if (found === null) throw new NotFoundError();
      const { context } = currentUnit();
      const reopen = body.status === 'open';
      const updated = await db.fdbDifference.update({
        where: { id },
        data: {
          reviewStatus: body.status,
          reviewNote: reopen ? null : (body.note ?? null),
          reviewedAt: reopen ? null : new Date(),
          reviewedBy: reopen ? null : (context.userId ?? null),
          version: { increment: 1 },
        },
      });
      return {
        id: updated.id,
        reviewStatus: updated.reviewStatus as (typeof REVIEW_STATES)[number],
        reviewNote: updated.reviewNote,
        reviewedAt: updated.reviewedAt?.toISOString() ?? null,
        version: updated.version,
      };
    });
    res.json(out);
  });

  const tags = ['Performance FDB check'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/performance/fdb-check',
    tags,
    summary: 'The newest Snoonu FDB check (or one run) with its differences',
    request: { query: listQuery },
    responses: { 200: { description: 'The run and its differences', content: json(listResponse) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/performance/fdb-check/runs',
    tags,
    summary: 'Recent FDB check runs',
    responses: {
      200: { description: 'Runs', content: json(z.object({ items: z.array(checkItem) })) },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/performance/fdb-check/run',
    tags,
    summary: 'Run the FDB check from the sheet or an uploaded Excel copy',
    request: { body: { content: json(runBody) } },
    responses: { 200: { description: 'The run', content: json(runResponse) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/performance/fdb-check/differences/{id}/review',
    tags,
    summary: 'Mark a difference open, reviewed or ignored',
    request: { params: idParams, body: { content: json(reviewBody) } },
    responses: {
      200: {
        description: 'The new review state',
        content: json(
          z.object({
            id: z.uuid(),
            reviewStatus: z.enum(REVIEW_STATES),
            reviewNote: z.string().nullable(),
            reviewedAt: z.string().nullable(),
            version: z.number().int(),
          }),
        ),
      },
    },
  });
  return router;
}
