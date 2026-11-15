/**
 * Rate tables API (phase 2 plan row 2.9b; PLAN 5.9 "Rate tables").
 *
 *   /rate-tables                         CRUD: key, name, dimensions (most important first)
 *   /rate-table-rows                     CRUD: dims, value, currency, dates; filter rateTableId
 *   GET /rate-tables/{key}/resolve       the rate for ?dims={json}&date=YYYY-MM-DD
 *
 * The plan names the rows route `/rate-tables/:id/rows`; rows are served flat
 * (`/rate-table-rows?rateTableId=`), as formula and template versions are, so the one CRUD
 * factory gives them the same paging, If-Match, audit and recycle bin.
 *
 * Rules on top of the plain permissions, and why (SPEC 2.10: any past month can be
 * recomputed exactly as it was):
 *   1. A table's key never changes (formulas name it). Dimensions may only be added at the
 *      end: their order decides which row wins, so moving or removing one would change past
 *      results.
 *   2. A row may name only the table's dimensions.
 *   3. "Today" is the UTC date. A row that has started (valid_from <= today) is frozen
 *      except for its end date, and the end date may only move within days that have not
 *      passed (old and new valid_to >= yesterday). A row that has not started can be
 *      changed or deleted freely.
 *   4. Two live rows with the same dims may not cover the same day (database exclusion
 *      constraint). Adding a row whose dims have an open-ended row that started earlier
 *      closes that row the day before, as long as rule 3 allows it, so a new price is one
 *      step: add the row with its start date.
 *   5. A table with live rows is not deleted.
 *
 * Depends on: express, zod, @fibrex/shared (rate schemas), kernel/db, kernel/http,
 * kernel/permissions, ./rate-service.
 * Used by: src/main.ts, the recycle bin.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  rateCurrencySchema,
  rateDimensionsSchema,
  rateDimsSchema,
  rateTableKeySchema,
  rateValueSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import {
  rateValueText,
  type RateRowRecord,
  type RateService,
  type RateTableRecord,
} from './rate-service.js';

const day = z.iso.date();
const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const today = () => toDay(isoDay(new Date()));

const tableCreate = z.strictObject({
  key: rateTableKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  dimensions: rateDimensionsSchema.default([]),
});
const tableUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    dimensions: rateDimensionsSchema,
  })
  .partial();
const tableItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    dimensions: z.array(z.string()),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RateTable' });

const rowCreate = z
  .strictObject({
    rateTableId: z.uuid(),
    dims: rateDimsSchema.default({}),
    value: rateValueSchema,
    currency: rateCurrencySchema,
    validFrom: day,
    validTo: day.nullable().default(null),
  })
  .refine((b) => b.validTo === null || b.validTo >= b.validFrom, {
    path: ['validTo'],
    message: 'The end date cannot be before the start date.',
  });
const rowUpdate = z
  .strictObject({
    dims: rateDimsSchema,
    value: rateValueSchema,
    currency: rateCurrencySchema,
    validFrom: day,
    validTo: day.nullable(),
  })
  .partial();
const rowItem = z
  .object({
    id: z.uuid(),
    rateTableId: z.uuid(),
    dims: z.record(z.string(), z.string()),
    value: z.string(),
    currency: z.string(),
    validFrom: day,
    validTo: day.nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RateTableRow' });
const rowFilter = z.object({ rateTableId: z.uuid().optional() });

const resolveParams = z.object({ key: rateTableKeySchema });
const resolveQuery = z.object({
  dims: z
    .string()
    .max(2000)
    .default('{}')
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'dims must be a JSON object' });
        return z.NEVER;
      }
    })
    .pipe(rateDimsSchema),
  date: day.optional(),
});
/** The same query as the OpenAPI document shows it (JSON text in, no transform). */
const resolveQueryDoc = z.object({
  dims: z
    .string()
    .optional()
    .meta({ description: 'JSON object, for example {"profession":"driver"}' }),
  date: day.optional().meta({ description: 'Day to resolve for (default today, UTC)' }),
});
const resolveResult = z
  .object({
    table: z.string(),
    dims: z.record(z.string(), z.string()),
    date: day,
    value: z.string(),
    currency: z.string(),
    rowId: z.uuid(),
    row: rowItem,
  })
  .meta({ id: 'RateResolution' });

export function toRateTableItem(row: RateTableRecord) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    dimensions: row.dimensions,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toRateRowItem(row: RateRowRecord) {
  return {
    id: row.id,
    rateTableId: row.rateTableId,
    dims: row.dims as Record<string, string>,
    value: rateValueText(row),
    currency: row.currency,
    validFrom: isoDay(row.validFrom),
    validTo: row.validTo === null ? null : isoDay(row.validTo),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

/** Rule 4 backstop: the exclusion constraint as a 409 the screen can show. */
async function guardOverlap<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
    if (text.includes('rate_table_row_no_overlap')) {
      throw new ConflictError(
        'rate_row_overlap',
        'Another row with the same dimension values covers some of these days.',
      );
    }
    throw err;
  }
}

/** Rule 3: an end date may move only within days that have not passed. */
function endDateMayMove(from: Date | null, to: Date | null): boolean {
  const yesterday = today().getTime() - DAY_MS;
  return [from, to].every((d) => d === null || d.getTime() >= yesterday);
}

async function liveTable(id: string): Promise<RateTableRecord> {
  const table = await currentUnit().db.rateTable.findFirst({ where: { id, deletedAt: null } });
  if (table === null) {
    throw invalid('rateTableId', 'This rate table does not exist.', 'unknown_rate_table');
  }
  return table;
}

/** Rule 2. */
function checkDims(table: RateTableRecord, dims: Record<string, string>): void {
  const unknown = Object.keys(dims).filter((name) => !table.dimensions.includes(name));
  if (unknown.length > 0) {
    throw invalid(
      'dims',
      `"${unknown.join('", "')}" is not a dimension of this table (${table.dimensions.join(', ') || 'none'}).`,
      'rate_unknown_dimension',
    );
  }
}

/** The repository behind `/rate-tables` and the recycle bin; adds rules 1 and 5. */
export function createRateTableRepository(): Repository<RateTableRecord> {
  const base = createRepository<RateTableRecord>({ model: 'rateTable', scope: 'tenant' });
  return {
    ...base,
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof tableUpdate>;
      if (body.dimensions !== undefined) {
        const current = await base.get(id);
        const kept = body.dimensions.slice(0, current.dimensions.length);
        if (kept.join('\n') !== current.dimensions.join('\n')) {
          throw invalid(
            'dimensions',
            `Dimensions can only be added at the end; keep ${current.dimensions.join(', ')} first and in this order.`,
            'rate_dimensions_fixed',
          );
        }
      }
      return base.update(id, version, body);
    },
    softDelete: async (id, version, reason) => {
      const rows = await currentUnit().db.rateTableRow.count({
        where: { rateTableId: id, deletedAt: null },
      });
      if (rows > 0) {
        throw new ConflictError('rate_table_has_rows', 'Delete the rows of this table first.', {
          rows,
        });
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/rate-table-rows` and the recycle bin; adds rules 2 to 4. */
export function createRateRowRepository(): Repository<RateRowRecord> {
  const base = createRepository<RateRowRecord>({ model: 'rateTableRow', scope: 'tenant' });
  const started = (row: RateRowRecord) => row.validFrom.getTime() <= today().getTime();
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof rowCreate>;
      const table = await liveTable(body.rateTableId);
      checkDims(table, body.dims);
      const validFrom = toDay(body.validFrom);
      const validTo = body.validTo === null ? null : toDay(body.validTo);
      const { db } = currentUnit();
      // Rule 4: a new price for the same dims closes the open-ended row that started earlier.
      const open = await db.rateTableRow.findFirst({
        where: {
          rateTableId: table.id,
          deletedAt: null,
          dims: { equals: body.dims },
          validTo: null,
          validFrom: { lt: validFrom },
        },
      });
      if (open !== null) {
        const closeOn = new Date(validFrom.getTime() - DAY_MS);
        if (!endDateMayMove(null, closeOn)) {
          throw new UnprocessableError(
            'rate_row_closes_past',
            `The row from ${isoDay(open.validFrom)} is still open; a new rate from ${body.validFrom} would change days that have passed. Start the new rate today or later.`,
          );
        }
        await base.update(open.id, open.version, { validTo: closeOn });
      }
      return guardOverlap(() =>
        base.create({
          rateTableId: table.id,
          dims: body.dims,
          value: body.value,
          currency: body.currency,
          validFrom,
          validTo,
        }),
      );
    },
    update: async (id, version, changes) => {
      const current = await base.get(id);
      const body = changes as z.infer<typeof rowUpdate>;
      if (started(current)) {
        // Rule 3: only the end date of a row that has started, within days still to come.
        const others = Object.keys(body).filter((k) => k !== 'validTo');
        if (others.length > 0) {
          throw new UnprocessableError(
            'rate_row_frozen',
            'This rate has started; only its end date can change. Add a new row for a new rate.',
          );
        }
      }
      const validTo =
        body.validTo === undefined
          ? current.validTo
          : body.validTo === null
            ? null
            : toDay(body.validTo);
      if (started(current) && !endDateMayMove(current.validTo, validTo)) {
        throw new UnprocessableError(
          'rate_row_frozen',
          'The end date can only move within days that have not passed.',
        );
      }
      const validFrom = body.validFrom === undefined ? current.validFrom : toDay(body.validFrom);
      if (validTo !== null && validTo < validFrom) {
        throw invalid('validTo', 'The end date cannot be before the start date.', 'invalid_dates');
      }
      if (body.dims !== undefined) checkDims(await liveTable(current.rateTableId), body.dims);
      return guardOverlap(() =>
        base.update(id, version, {
          ...body,
          ...(body.validFrom === undefined ? {} : { validFrom }),
          ...(body.validTo === undefined ? {} : { validTo }),
        }),
      );
    },
    softDelete: async (id, version, reason) => {
      if (started(await base.get(id))) {
        throw new UnprocessableError(
          'rate_row_frozen',
          'This rate has started and cannot be deleted; give it an end date instead.',
        );
      }
      return base.softDelete(id, version, reason);
    },
    restore: (id, version) => guardOverlap(() => base.restore(id, version)),
  };
}

export interface RateRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  rates: RateService;
}

export function createRateRouter(deps: RateRouterDeps): Router {
  const { uow, registry, permissions, rates } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };

  router.get('/rate-tables/:key/resolve', async (req, res) => {
    const { key } = resolveParams.parse(req.params);
    const query = resolveQuery.parse(req.query);
    const date = query.date ?? isoDay(new Date());
    const found = await uow.run(async () => {
      await permissions.require('platform.rate_table.read');
      return rates.resolve(key, query.dims, toDay(date));
    });
    res.json({
      table: key,
      dims: query.dims,
      date,
      value: found.value,
      currency: found.row.currency,
      rowId: found.row.id,
      row: toRateRowItem(found.row),
    });
  });

  router.use(
    createCrudRouter<RateTableRecord>(crud, {
      path: '/rate-tables',
      resource: 'platform.rate_table',
      tag: 'Rate tables',
      repository: createRateTableRepository(),
      schemas: { create: tableCreate, update: tableUpdate, item: tableItem },
      toItem: toRateTableItem,
    }),
  );
  router.use(
    createCrudRouter<RateRowRecord>(crud, {
      path: '/rate-table-rows',
      resource: 'platform.rate_table_row',
      tag: 'Rate tables',
      repository: createRateRowRepository(),
      schemas: { create: rowCreate, update: rowUpdate, item: rowItem, filter: rowFilter },
      toItem: toRateRowItem,
      toWhere: (filter) => filter,
    }),
  );

  registerRoute(registry, {
    method: 'get',
    path: '/rate-tables/{key}/resolve',
    tags: ['Rate tables'],
    summary: 'The rate in force on a day for dimension values (most specific row wins)',
    request: { params: resolveParams, query: resolveQueryDoc },
    responses: {
      200: {
        description: 'The rate and the row it came from',
        content: { 'application/json': { schema: resolveResult } },
      },
      400: {
        description: 'Unknown dimension or bad query',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
      404: {
        description: 'No such table or no rate in force',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
    },
  });

  return router;
}
