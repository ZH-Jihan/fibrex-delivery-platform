/**
 * Performance report helper routes (phase 4 row 4.6a), under `/performance`:
 *
 *   GET /performance/report-options        platforms with this and last cycle, yesterday
 *   GET /performance/person/{partyId}      one person's day-by-day figures for a cycle or range
 *
 * Purpose: the report pages need the platforms and cycle dates to fill their pickers, and the
 * employee profile needs one person's cycle (daily orders and hours for a table and a chart).
 * The three tabular reports themselves run through the report engine (`/reports/{key}/run` and
 * `/export`, see ./performance-reports.ts), which adds paging and CSV/Excel export.
 *
 * Rules: both routes need `performance.report.view`. The person route uses the same scope rules
 * as the reports (platform, cycle or range, reset guard: a date nobody has figures for is
 * returned with `reported: false` and no numbers, never as a zero).
 *
 * Depends on: ./performance-reports.ts, ./report-calc.ts, kernel (unit of work, permissions,
 * openapi). Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { NotFoundError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { addDays } from './cycle.js';
import {
  REPORT_VIEW,
  loadFigures,
  qatarToday,
  resolveScope,
  thisAndLastCycle,
  yesterdayInQatar,
} from './performance-reports.js';
import { acceptancePercent, hoursOf, indexFigures, totalsFor } from './report-calc.js';

const day = z.iso.date();
const cycleSchema = z.object({ start: day, end: day });

const optionsResponse = z
  .object({
    today: day,
    yesterday: day,
    platforms: z.array(
      z.object({
        id: z.uuid(),
        companyId: z.uuid(),
        code: z.string(),
        name: z.string(),
        cycleStartDay: z.number().int(),
        thisCycle: cycleSchema,
        lastCycle: cycleSchema,
      }),
    ),
  })
  .meta({ id: 'PerformanceReportOptions' });

const personQuery = z.object({
  platformId: z.uuid().optional(),
  cycle: z.enum(['this', 'last']).optional(),
  from: day.optional(),
  to: day.optional(),
});
const personParams = z.object({ partyId: z.uuid() });

const personResponse = z
  .object({
    partyId: z.uuid(),
    platformId: z.uuid(),
    platformName: z.string(),
    from: day,
    to: day,
    /** Dates in the range on which the platform reported figures for somebody. */
    reportedDays: z.number().int(),
    totals: z.object({
      orders: z.number().int(),
      hours: z.number(),
      daysWorked: z.number().int(),
      zeroDays: z.number().int(),
    }),
    days: z.array(
      z.object({
        date: day,
        reported: z.boolean(),
        orders: z.number().int().nullable(),
        hours: z.number().nullable(),
        acceptanceRate: z.number().nullable(),
        lateMinutes: z.number().int().nullable(),
        km: z.number().nullable(),
      }),
    ),
  })
  .meta({ id: 'PerformancePersonHistory' });

export interface PerformanceReportRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createPerformanceReportRouter(deps: PerformanceReportRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();

  router.get('/performance/report-options', async (_req, res) => {
    const result = await uow.run(async (db) => {
      await permissions.require(REPORT_VIEW);
      const platforms = await db.clientPlatform.findMany({
        where: { deletedAt: null, status: 'active' },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, companyId: true, code: true, name: true, cycleStartDay: true },
      });
      return {
        today: qatarToday(),
        yesterday: yesterdayInQatar(),
        platforms: platforms.map((p) => {
          const { thisCycle, lastCycle } = thisAndLastCycle(p.cycleStartDay);
          return {
            ...p,
            thisCycle: { start: thisCycle.start, end: thisCycle.end },
            lastCycle: { start: lastCycle.start, end: lastCycle.end },
          };
        }),
      };
    });
    res.json(result);
  });

  router.get('/performance/person/:partyId', async (req, res) => {
    const { partyId } = personParams.parse(req.params);
    const query = personQuery.parse(req.query);
    const result = await uow.run(async () => {
      await permissions.require(REPORT_VIEW);
      const { db } = currentUnit();
      const filters: Record<string, string> = {};
      for (const [key, value] of Object.entries(query)) {
        filters[key] = value;
      }
      const scope = await resolveScope(db, filters);
      const party = await db.party.findFirst({ where: { id: partyId }, select: { id: true } });
      if (party === null) throw new NotFoundError('That person does not exist.');
      const data = await loadFigures(db, scope);
      const days = indexFigures(data.figures.filter((f) => f.partyId === partyId)).get(partyId);
      const reported = new Set(data.reportedDates);
      const totals = totalsFor(partyId, days, data.reportedDates);

      // One entry per calendar date of the range, so a chart can show gaps honestly.
      const list: z.infer<typeof personResponse>['days'] = [];
      for (let date = scope.from; date <= scope.to; date = addDays(date, 1)) {
        const figure = days?.get(date);
        const isReported = reported.has(date);
        list.push({
          date,
          reported: isReported,
          orders: isReported ? (figure?.orders ?? 0) : null,
          hours: isReported ? hoursOf(figure?.workingMinutes ?? 0) : null,
          acceptanceRate: acceptancePercent(figure?.acceptanceRate ?? null),
          lateMinutes: figure?.lateMinutes ?? null,
          km: figure?.kms ?? null,
        });
      }
      return {
        partyId,
        platformId: scope.platformId,
        platformName: scope.platformName,
        from: scope.from,
        to: scope.to,
        reportedDays: data.reportedDates.length,
        totals: {
          orders: totals.totalOrders,
          hours: totals.totalHours,
          daysWorked: totals.daysWorked,
          zeroDays: totals.zeroDays,
        },
        days: list,
      };
    });
    res.json(result);
  });

  const tags = ['Performance reports'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  registerRoute(registry, {
    method: 'get',
    path: '/performance/report-options',
    tags,
    summary: 'Platforms with their this and last cycle dates, and yesterday (Qatar date)',
    responses: { 200: { description: 'Report options', content: json(optionsResponse) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/performance/person/{partyId}',
    tags,
    summary: "One person's daily orders and hours for a cycle or date range",
    request: { params: personParams, query: personQuery },
    responses: { 200: { description: 'The days', content: json(personResponse) } },
  });
  return router;
}
