/**
 * Employee placements and employment periods API (PLAN 5.12):
 *
 *   /employees/{employeeId}/placements          CRUD factory (people.placement.*)
 *   /employees/{employeeId}/employment-periods  CRUD factory (people.employment_period.*)
 *
 * Rules, and why:
 *   1. Both belong to one employee: the employee comes from the path, never from the body,
 *      and a row of another employee is "not found" under this path. The row takes the
 *      employee's company, so it can never sit in another company than its employee.
 *   2. Placements are effective-dated; the database allows one placement per employee on
 *      any day (exclusion constraint), so moving someone means ending the current
 *      placement (validTo) and adding the next one. The overlap comes back as 409.
 *   3. Zone and team are platform.org_unit rows of that kind in the employee's company;
 *      anything else is refused (422) before the write.
 *   4. Employment periods never overlap either (a rehire starts after the last period).
 *
 * Depends on: express, zod, @fibrex/shared (people schemas), kernel/db, kernel/http,
 * ./dates.ts. Used by: ./employee-router.ts (first period and placement), ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  employeePlacementCreateSchema,
  employeePlacementUpdateSchema,
  employmentPeriodCreateSchema,
  employmentPeriodUpdateSchema,
} from '@fibrex/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type BaseRow, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { fromDate, guardOverlap, withDates } from './dates.js';

export type PlacementRow = NonNullable<Awaited<ReturnType<Db['employeePlacement']['findFirst']>>>;
export type PeriodRow = NonNullable<Awaited<ReturnType<Db['employmentPeriod']['findFirst']>>>;

const date = z.iso.date();
const stamps = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
const stampsOf = (row: {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

const placementItem = z
  .object({
    id: z.uuid(),
    employeeId: z.uuid(),
    branchId: z.uuid().nullable(),
    validFrom: date,
    validTo: date.nullable(),
    profession: z.string(),
    clientPlatformId: z.uuid().nullable(),
    orgUnitId: z.uuid().nullable(),
    teamId: z.uuid().nullable(),
    ...stamps,
  })
  .meta({ id: 'EmployeePlacement' });
const toPlacementItem = (row: PlacementRow) => ({
  id: row.id,
  employeeId: row.employeeId,
  branchId: row.branchId,
  validFrom: fromDate(row.validFrom),
  validTo: fromDate(row.validTo),
  profession: row.profession,
  clientPlatformId: row.clientPlatformId,
  orgUnitId: row.orgUnitId,
  teamId: row.teamId,
  ...stampsOf(row),
});

const periodItem = z
  .object({
    id: z.uuid(),
    employeeId: z.uuid(),
    startDate: date,
    endDate: date.nullable(),
    exitCaseId: z.uuid().nullable(),
    rehireEligible: z.boolean(),
    ...stamps,
  })
  .meta({ id: 'EmploymentPeriod' });
const toPeriodItem = (row: PeriodRow) => ({
  id: row.id,
  employeeId: row.employeeId,
  startDate: fromDate(row.startDate),
  endDate: fromDate(row.endDate),
  exitCaseId: row.exitCaseId,
  rehireEligible: row.rehireEligible,
  ...stampsOf(row),
});

/** Rule 3: an org unit of the right kind in the company. */
async function checkOrgUnit(
  companyId: string,
  id: unknown,
  kind: 'zone' | 'team',
  field: string,
): Promise<void> {
  if (typeof id !== 'string') return;
  const unit = await currentUnit().db.orgUnit.findFirst({
    where: { id, companyId, kind, deletedAt: null },
    select: { id: true },
  });
  if (unit === null) {
    throw new UnprocessableError(`unknown_${kind}`, `${field}: no such ${kind} in this company.`);
  }
}

const PLACEMENT_DATES = ['validFrom', 'validTo'] as const;
const PERIOD_DATES = ['startDate', 'endDate'] as const;

/** Placements across employees (rules 2 and 3); the router scopes it to one employee. */
export function createPlacementRepository(): Repository<PlacementRow> {
  const base = createRepository<PlacementRow>({ model: 'employeePlacement', scope: 'company' });
  const check = async (companyId: string, data: Record<string, unknown>) => {
    await checkOrgUnit(companyId, data.orgUnitId, 'zone', 'orgUnitId');
    await checkOrgUnit(companyId, data.teamId, 'team', 'teamId');
  };
  return {
    ...base,
    create: async (data) => {
      await check(String(data.companyId), data);
      return guardOverlap(() => base.create(withDates(data, PLACEMENT_DATES)));
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      await check(current.companyId, changes);
      return guardOverlap(() => base.update(id, version, withDates(changes, PLACEMENT_DATES)));
    },
    restore: (id, version) => guardOverlap(() => base.restore(id, version)),
  };
}

/** Employment periods across employees (rule 4). */
export function createPeriodRepository(): Repository<PeriodRow> {
  const base = createRepository<PeriodRow>({ model: 'employmentPeriod', scope: 'company' });
  return {
    ...base,
    create: (data) => guardOverlap(() => base.create(withDates(data, PERIOD_DATES))),
    update: (id, version, changes) =>
      guardOverlap(() => base.update(id, version, withDates(changes, PERIOD_DATES))),
    restore: (id, version) => guardOverlap(() => base.restore(id, version)),
  };
}

type Owned = BaseRow & { employeeId: string };

/** Rule 1: a repository that only sees and writes rows of one employee. */
function scopedTo<TRow extends Owned>(
  base: Repository<TRow>,
  model: 'employeePlacement' | 'employmentPeriod',
  employeeId: string,
): Repository<TRow> {
  const owned = async (id: string, deleted: boolean): Promise<void> => {
    const db = currentUnit().db;
    const where = { id, employeeId, deletedAt: deleted ? { not: null } : null };
    const row =
      model === 'employeePlacement'
        ? await db.employeePlacement.findFirst({ where, select: { id: true } })
        : await db.employmentPeriod.findFirst({ where, select: { id: true } });
    if (row === null) throw new NotFoundError();
  };
  return {
    list: (options) => base.list({ ...options, where: { ...options.where, employeeId } }),
    get: async (id) => {
      const row = await base.get(id);
      if (row.employeeId !== employeeId) throw new NotFoundError();
      return row;
    },
    create: async (data) => {
      const employee = await currentUnit().db.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: { companyId: true },
      });
      if (employee === null) throw new NotFoundError('No such employee.');
      return base.create({ ...data, employeeId, companyId: employee.companyId });
    },
    update: async (id, version, changes) => {
      await owned(id, false);
      return base.update(id, version, changes);
    },
    softDelete: async (id, version, reason) => {
      await owned(id, false);
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      await owned(id, true);
      return base.restore(id, version);
    },
  };
}

const employeeParams = z.object({ employeeId: z.uuid() });
const employeeIdOf = (req: Request): string => employeeParams.parse(req.params).employeeId;

export interface PlacementRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  placements: Repository<PlacementRow>;
  periods: Repository<PeriodRow>;
}

export function createPlacementRouter(deps: PlacementRouterDeps): Router {
  const { uow, registry, permissions, placements, periods } = deps;
  const crud = { uow, authorize: permissions.authorize, registry };
  const router = Router();
  router.use(
    createCrudRouter(crud, {
      path: '/employees/:employeeId/placements',
      resource: 'people.placement',
      tag: 'Employee placements',
      repository: (req) => scopedTo(placements, 'employeePlacement', employeeIdOf(req)),
      pathParams: employeeParams,
      schemas: {
        create: employeePlacementCreateSchema,
        update: employeePlacementUpdateSchema,
        item: placementItem,
      },
      toItem: toPlacementItem,
    }),
  );
  router.use(
    createCrudRouter(crud, {
      path: '/employees/:employeeId/employment-periods',
      resource: 'people.employment_period',
      tag: 'Employment periods',
      repository: (req) => scopedTo(periods, 'employmentPeriod', employeeIdOf(req)),
      pathParams: employeeParams,
      schemas: {
        create: employmentPeriodCreateSchema,
        update: employmentPeriodUpdateSchema,
        item: periodItem,
      },
      toItem: toPeriodItem,
    }),
  );
  return router;
}
