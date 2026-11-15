/**
 * Lookups API (phase 2 plan row 2.3): configurable dropdown lists.
 *
 *   /lookup-types                CRUD (kernel CRUD factory): the lists
 *   /lookup-values               CRUD: the values; filter by lookupTypeId, active
 *   GET /lookups/{key}           the active values of one list, for dropdowns (any signed-in
 *                                user); `includeInactive=true` needs platform.lookup_value.read
 *
 * The plan names the values route `/lookup-types/:key/values`; values are served flat
 * (`/lookup-values?lookupTypeId=`) so the one CRUD factory gives them the same behaviour as
 * every other resource (recorded in docs/DECISIONS.md).
 *
 * Caching: `GET /lookups/{key}` sends an ETag over its content and answers 304 when the
 * browser already has it, with `Cache-Control: private, no-cache`. The list is one indexed
 * query, so there is no server-side copy that could go stale between several API instances.
 *
 * Rules on top of the plain permissions, and why:
 *   1. A value's code and list never change: records store the code, so changing it would
 *      silently re-label history. Retire a value with `active = false` instead. A list's key
 *      never changes either, because modules look lists up by key.
 *   2. Every value needs an English label (the fallback of every other language).
 *   3. A parent is allowed only when the list `allowHierarchy`, must be in the same list,
 *      and may not be the value itself or one of its descendants (no cycles).
 *   4. A system list cannot be deleted, and a list or a value with live children or values
 *      is not deleted until they are (nothing is left pointing at a hidden row).
 *   5. Turning `allowHierarchy` off is refused while a value still has a parent.
 *
 * Depends on: express, zod, @fibrex/shared lookups, kernel/db, kernel/http, kernel/permissions,
 * ./lookup-service. Used by: src/main.ts, the recycle bin (both repositories).
 */
import { createHash } from 'node:crypto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  labelsProblem,
  lookupCodePattern,
  lookupKeyPattern,
  type LookupLabels,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { LookupService } from './lookup-service.js';

export type LookupTypeRow = NonNullable<Awaited<ReturnType<Db['lookupType']['findFirst']>>>;
export type LookupValueRow = NonNullable<Awaited<ReturnType<Db['lookupValue']['findFirst']>>>;

const typeCreate = z.strictObject({
  key: z.string().trim().regex(lookupKeyPattern, 'lower-case letters, digits and _'),
  name: z.string().trim().min(1).max(200),
  allowHierarchy: z.boolean().default(false),
});
const typeUpdate = z
  .strictObject({ name: z.string().trim().min(1).max(200), allowHierarchy: z.boolean() })
  .partial();
const typeItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    isSystem: z.boolean(),
    allowHierarchy: z.boolean(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'LookupType' });

const labelsSchema = z.record(z.string().min(2).max(10), z.string().trim().max(200));
const metaSchema = z.record(z.string(), z.unknown());
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);
const valueCreate = z.strictObject({
  lookupTypeId: z.uuid(),
  code: z.string().trim().regex(lookupCodePattern, 'letters, digits, _ . - (up to 60)'),
  labels: labelsSchema,
  parentId: z.uuid().nullable().default(null),
  sortOrder: sortOrder.default(0),
  active: z.boolean().default(true),
  meta: metaSchema.default({}),
});
const valueUpdate = z
  .strictObject({
    labels: labelsSchema,
    parentId: z.uuid().nullable(),
    sortOrder,
    active: z.boolean(),
    meta: metaSchema,
  })
  .partial();
const valueItem = z
  .object({
    id: z.uuid(),
    lookupTypeId: z.uuid(),
    code: z.string(),
    labels: labelsSchema,
    parentId: z.uuid().nullable(),
    sortOrder: z.number().int(),
    active: z.boolean(),
    meta: metaSchema,
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'LookupValue' });
const valueFilter = z.object({
  lookupTypeId: z.uuid().optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const listResult = z
  .object({
    key: z.string(),
    name: z.string(),
    allowHierarchy: z.boolean(),
    items: z.array(
      z.object({
        id: z.uuid(),
        code: z.string(),
        labels: labelsSchema,
        parentId: z.uuid().nullable(),
        sortOrder: z.number().int(),
        active: z.boolean(),
        meta: metaSchema,
      }),
    ),
  })
  .meta({ id: 'LookupList' });

export function toTypeItem(row: LookupTypeRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    isSystem: row.isSystem,
    allowHierarchy: row.allowHierarchy,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toValueItem(row: LookupValueRow) {
  return {
    id: row.id,
    lookupTypeId: row.lookupTypeId,
    code: row.code,
    labels: row.labels as LookupLabels,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    active: row.active,
    meta: row.meta as Record<string, unknown>,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

/** Rule 3: the parent of a value (`selfId` is undefined while creating). */
async function checkParent(
  type: LookupTypeRow,
  parentId: string | null,
  selfId: string | undefined,
): Promise<void> {
  if (parentId === null) return;
  if (!type.allowHierarchy) {
    throw invalid('parentId', 'This list does not allow a hierarchy.', 'hierarchy_not_allowed');
  }
  const { db } = currentUnit();
  const parent = await db.lookupValue.findFirst({
    where: { id: parentId, lookupTypeId: type.id, deletedAt: null },
  });
  if (parent === null) {
    throw invalid('parentId', 'The parent must be a value of the same list.', 'unknown_parent');
  }
  // Walk up from the parent; meeting the value itself would close a loop. The bound stops a
  // damaged chain from looping forever.
  let cursor: string | null = parent.id;
  for (let step = 0; cursor !== null && step < 100; step += 1) {
    if (cursor === selfId) {
      throw invalid('parentId', 'A value cannot sit under itself.', 'parent_cycle');
    }
    const up: { parentId: string | null } | null = await db.lookupValue.findFirst({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = up?.parentId ?? null;
  }
}

/** The repository behind `/lookup-types` and the recycle bin; adds rules 4 and 5. */
export function createLookupTypeRepository(): Repository<LookupTypeRow> {
  const base = createRepository<LookupTypeRow>({ model: 'lookupType', scope: 'tenant' });
  return {
    ...base,
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof typeUpdate>;
      if (body.allowHierarchy === false) {
        const { db } = currentUnit();
        const nested = await db.lookupValue.count({
          where: { lookupTypeId: id, deletedAt: null, parentId: { not: null } },
        });
        if (nested > 0) {
          throw new UnprocessableError(
            'hierarchy_in_use',
            'Some values still have a parent; move them to the top level first.',
          );
        }
      }
      return base.update(id, version, changes);
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.isSystem) {
        throw new UnprocessableError(
          'system_lookup_type',
          'A built-in list cannot be deleted; retire its values instead.',
        );
      }
      const { db } = currentUnit();
      const values = await db.lookupValue.count({ where: { lookupTypeId: id, deletedAt: null } });
      if (values > 0) {
        throw new ConflictError('lookup_type_in_use', 'Delete the values of this list first.', {
          values,
        });
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/lookup-values` and the recycle bin; adds rules 1 to 4. */
export function createLookupValueRepository(): Repository<LookupValueRow> {
  const base = createRepository<LookupValueRow>({ model: 'lookupValue', scope: 'tenant' });
  const checkLabels = (labels: LookupLabels) => {
    const problem = labelsProblem(labels);
    if (problem !== null) throw invalid('labels', problem, 'english_label_required');
  };
  return {
    ...base,
    create: async (data) => {
      const body = data as z.infer<typeof valueCreate>;
      checkLabels(body.labels);
      const { db } = currentUnit();
      const type = await db.lookupType.findFirst({
        where: { id: body.lookupTypeId, deletedAt: null },
      });
      if (type === null) {
        throw invalid('lookupTypeId', 'This list does not exist.', 'unknown_lookup_type');
      }
      await checkParent(type, body.parentId, undefined);
      return base.create(data);
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof valueUpdate>;
      if (body.labels !== undefined) checkLabels(body.labels);
      if (body.parentId !== undefined) {
        const current = await base.get(id);
        const { db } = currentUnit();
        const type = await db.lookupType.findFirst({ where: { id: current.lookupTypeId } });
        if (type !== null) await checkParent(type, body.parentId, id);
      }
      return base.update(id, version, changes);
    },
    softDelete: async (id, version, reason) => {
      const { db } = currentUnit();
      const children = await db.lookupValue.count({ where: { parentId: id, deletedAt: null } });
      if (children > 0) {
        throw new ConflictError(
          'lookup_value_has_children',
          'Delete or move the child values first.',
          { children },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

export interface LookupRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  lookups: LookupService;
}

export function createLookupRouter(deps: LookupRouterDeps): Router {
  const { uow, registry, permissions, lookups } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  const keyParams = z.object({ key: z.string().regex(lookupKeyPattern) });
  const listQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional() });

  router.get('/lookups/:key', async (req, res) => {
    const { key } = keyParams.parse(req.params);
    const query = listQuery.parse(req.query);
    const includeInactive = query.includeInactive === 'true';
    const list = await uow.run(async () => {
      // Dropdowns need only a signed-in user; the hidden values need the read permission.
      if (includeInactive) await permissions.require('platform.lookup_value.read');
      return lookups.values(key, { includeInactive });
    });
    const etag = `W/"${createHash('sha1').update(JSON.stringify(list)).digest('hex')}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.json(list);
  });

  router.use(
    createCrudRouter<LookupTypeRow>(crud, {
      path: '/lookup-types',
      resource: 'platform.lookup_type',
      tag: 'Lookups',
      repository: createLookupTypeRepository(),
      schemas: { create: typeCreate, update: typeUpdate, item: typeItem },
      toItem: toTypeItem,
    }),
  );
  router.use(
    createCrudRouter<LookupValueRow>(crud, {
      path: '/lookup-values',
      resource: 'platform.lookup_value',
      tag: 'Lookups',
      repository: createLookupValueRepository(),
      schemas: { create: valueCreate, update: valueUpdate, item: valueItem, filter: valueFilter },
      toItem: toValueItem,
      toWhere: (filter) => filter,
    }),
  );

  registerRoute(registry, {
    method: 'get',
    path: '/lookups/{key}',
    tags: ['Lookups'],
    summary: 'The active values of one list, for dropdowns (ETag, 304 when unchanged)',
    request: { params: keyParams, query: listQuery },
    responses: {
      200: { description: 'The list', content: { 'application/json': { schema: listResult } } },
      304: { description: 'Unchanged since the ETag in If-None-Match' },
      404: {
        description: 'No such list',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
    },
  });

  return router;
}
