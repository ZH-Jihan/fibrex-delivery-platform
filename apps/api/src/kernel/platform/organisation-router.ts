/**
 * Organisation API: the caller's companies and their branches (PLAN 5.2, phase plan section 5).
 *
 *   GET   /companies, /companies/{id}   the companies the caller has a membership in
 *   PATCH /companies/{id}               settings (names, country, time zone, working week,
 *                                       financial year start, status); If-Match required
 *   /branches                           CRUD (kernel CRUD factory), current company
 *
 * Rules enforced here on top of the plain permission, and why:
 *   1. Companies are tenant rows, so row-level security alone would show every company of
 *      the tenant. A user only sees and changes companies they are a member of (the unit
 *      of work context lists them), so a branch manager cannot read a sister company.
 *   2. Companies are not created or deleted here: a company brings memberships, a ledger
 *      and a chart of accounts, which is tenant onboarding, not a form. Only settings change.
 *   3. The base currency is read-only: every posted amount is in it (SPEC 2.9), so changing
 *      it later would silently reinterpret money. It is fixed when the company is set up.
 *   4. The head-office branch cannot be deleted; make another branch head office first.
 *      Only one branch is head office at a time (setting one moves the flag).
 *
 * Depends on: express, zod, kernel/db (repository, unit of work), kernel/http (CRUD
 * factory, errors, OpenAPI), kernel/permissions/permission-service.ts.
 * Used by: src/main.ts, the recycle bin (branch repository).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../http/crud-router.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';

export type CompanyRow = NonNullable<Awaited<ReturnType<Db['company']['findFirst']>>>;
export type BranchRow = NonNullable<Awaited<ReturnType<Db['branch']['findFirst']>>>;

const stamps = {
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
};
const stampsOf = (r: {
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) => ({
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt?.toISOString() ?? null,
});

// ---- Companies ---------------------------------------------------------------------------
const weekday = z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const companyUpdate = z
  .strictObject({
    legalName: z.string().trim().min(1).max(300),
    tradeName: z.string().trim().min(1).max(300).nullable(),
    countryCode: z.string().regex(/^[A-Z]{2}$/, 'a two-letter country code, e.g. QA'),
    timeZone: z.string().trim().min(1).max(64),
    workingWeek: z
      .array(weekday)
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'Each day once'),
    fiscalYearStartMonth: z.number().int().min(1).max(12),
    status: z.enum(['active', 'inactive']),
  })
  .partial();
const companyItem = z
  .object({
    id: z.uuid(),
    legalName: z.string(),
    tradeName: z.string().nullable(),
    countryCode: z.string(),
    baseCurrency: z.string(),
    timeZone: z.string(),
    workingWeek: z.array(z.string()),
    fiscalYearStartMonth: z.number().int(),
    status: z.string(),
    ...stamps,
  })
  .meta({ id: 'Company' });

function toCompanyItem(row: CompanyRow) {
  return {
    id: row.id,
    legalName: row.legalName,
    tradeName: row.tradeName,
    countryCode: row.countryCode,
    baseCurrency: row.baseCurrency,
    timeZone: row.timeZone,
    workingWeek: Array.isArray(row.workingWeek) ? (row.workingWeek as string[]) : [],
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    status: row.status,
    ...stampsOf(row),
  };
}

// ---- Branches ----------------------------------------------------------------------------
const branchFields = {
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/, 'up to 20 letters, digits, - or _'),
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).nullable().optional(),
  isHeadOffice: z.boolean().optional(),
};
const branchCreate = z.strictObject(branchFields);
const branchUpdate = z.strictObject(branchFields).partial();
const branchItem = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    isHeadOffice: z.boolean(),
    ...stamps,
  })
  .meta({ id: 'Branch' });

function toBranchItem(row: BranchRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    isHeadOffice: row.isHeadOffice,
    ...stampsOf(row),
  };
}

/** The repository behind `/branches` and the recycle bin; adds rule 4 to every write. */
export function createBranchRepository(): Repository<BranchRow> {
  const base = createRepository<BranchRow>({ model: 'branch', scope: 'company' });
  /** Only one head office: setting the flag clears it on the other branches of the company. */
  const clearOtherHeadOffices = async (keepId: string, companyId: string) => {
    await currentUnit().db.branch.updateMany({
      where: { companyId, isHeadOffice: true, deletedAt: null, id: { not: keepId } },
      data: { isHeadOffice: false },
    });
  };
  return {
    ...base,
    create: async (data) => {
      const row = await base.create(data);
      if (row.isHeadOffice) await clearOtherHeadOffices(row.id, row.companyId);
      return row;
    },
    update: async (id, version, changes) => {
      const row = await base.update(id, version, changes);
      if (changes.isHeadOffice === true) await clearOtherHeadOffices(row.id, row.companyId);
      return row;
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.isHeadOffice) {
        throw new ConflictError(
          'head_office_in_use',
          'Make another branch head office before deleting this one.',
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

export interface OrganisationRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
}

export function createOrganisationRouter(deps: OrganisationRouterDeps): Router {
  const { uow, registry, permissions } = deps;
  const router = Router();
  const companies = createRepository<CompanyRow>({ model: 'company', scope: 'tenant' });
  const idParams = z.object({ id: z.uuid() });

  /** Rule 1 for a single company: a company the caller is not in does not exist for them. */
  const visibleCompany = async (id: string): Promise<CompanyRow> => {
    if (!currentUnit().context.companyIds.includes(id)) throw new NotFoundError();
    return companies.get(id);
  };

  router.get('/companies', async (_req, res) => {
    const items = await uow.run(async () => {
      await permissions.require('platform.company.read');
      const page = await companies.list({
        where: { id: { in: currentUnit().context.companyIds } },
        orderBy: [{ legalName: 'asc' }],
        page: 1,
        pageSize: 200,
      });
      return page.items.map(toCompanyItem);
    });
    res.json({ items, total: items.length });
  });

  router.get('/companies/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const row = await uow.run(async () => {
      await permissions.require('platform.company.read');
      return visibleCompany(id);
    });
    res.setHeader('ETag', `"${String(row.version)}"`).json(toCompanyItem(row));
  });

  router.patch('/companies/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    const body = companyUpdate.parse(req.body);
    const row = await uow.run(async () => {
      await permissions.require('platform.company.update');
      await visibleCompany(id);
      return companies.update(id, version, body);
    });
    res.setHeader('ETag', `"${String(row.version)}"`).json(toCompanyItem(row));
  });

  router.use(
    createCrudRouter<BranchRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/branches',
        resource: 'platform.branch',
        tag: 'Branches',
        repository: createBranchRepository(),
        schemas: { create: branchCreate, update: branchUpdate, item: branchItem },
        toItem: toBranchItem,
      },
    ),
  );

  // ---- OpenAPI ------------------------------------------------------------------------
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/companies',
    tags: ['Companies'],
    summary: 'The companies you belong to',
    responses: {
      200: {
        description: 'Companies',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(companyItem), total: z.number().int() }),
          },
        },
      },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/companies/{id}',
    tags: ['Companies'],
    summary: 'One company',
    request: { params: idParams },
    responses: {
      200: { description: 'The company', content: { 'application/json': { schema: companyItem } } },
      404: problem('Not found, or not one of your companies'),
    },
  });
  registerRoute(registry, {
    method: 'patch',
    path: '/companies/{id}',
    tags: ['Companies'],
    summary: 'Change company settings (the base currency cannot be changed)',
    request: {
      params: idParams,
      headers: z.object({ 'If-Match': z.string() }),
      body: { content: { 'application/json': { schema: companyUpdate } } },
    },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: companyItem } } },
      404: problem('Not found, or not one of your companies'),
      409: problem('Version conflict'),
      428: problem('If-Match header missing'),
    },
  });

  return router;
}
