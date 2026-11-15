/**
 * Custom records API (phase 2 plan row 2.5; PLAN 5.9 "Custom records").
 *
 *   /records/{entityKey}                        CRUD (kernel CRUD factory) for one record type
 *   GET    /records/{entityKey}/{id}/links      relations of a record, both directions
 *   POST   /records/{entityKey}/{id}/links      relate the record to another record
 *   DELETE /records/{entityKey}/{id}/links/{linkId}   remove a relation (If-Match, reason)
 *
 * One router serves every custom record type: the type is the path parameter, and the CRUD
 * factory takes the permission prefix and the repository per request.
 *
 * Permissions: `custom.<entityKey>.<action>` with the five standard actions. Reading links
 * needs `read`; adding or removing one changes the record's relations, so it needs `update`.
 * The check runs before the type is looked up, so a caller without the permission cannot
 * tell which record types exist (403 either way).
 *
 * List filters (all exact matches, combined with AND):
 *   number, partyId, branchId, stateCode    columns of the record
 *   f.<fieldKey>=<value>                    a field value; see `buildDataFilter` in
 *                                           @fibrex/shared for what each field type accepts
 *
 * Not here: `POST /records/{entityKey}/{id}/transition` arrives with state machines
 * (row 2.10); import and export with rows 2.8 and 2.9.
 *
 * Depends on: express, zod, @fibrex/shared records and entities, kernel/db, kernel/http,
 * kernel/permissions, ./record-service.
 * Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  entityKeyPattern,
  RECORD_FILTER_PREFIX,
  recordCreateSchema,
  recordLinkCreateSchema,
  recordUpdateSchema,
} from '@fibrex/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter, deleteBody, parseIfMatch } from '../http/crud-router.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type {
  CustomRecordRow,
  RecordLinkRow,
  RecordListFilter,
  RecordService,
} from './record-service.js';

const keyParams = z.object({
  entityKey: z.string().regex(entityKeyPattern, 'This is not a record type key.'),
});
const recordParams = keyParams.extend({ id: z.uuid() });
const linkParams = recordParams.extend({ linkId: z.uuid() });

const recordItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    branchId: z.uuid().nullable(),
    entityDefinitionId: z.uuid(),
    definitionVersion: z.number().int(),
    number: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    stateCode: z.string().nullable(),
    partyId: z.uuid().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    createdBy: z.uuid().nullable(),
    updatedAt: z.iso.datetime(),
    updatedBy: z.uuid().nullable(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'CustomRecord' });

// Loose: the field filters (`f.<fieldKey>`) are not known until the type is read.
const recordFilter = z.looseObject({
  number: z.string().min(1).max(100).optional(),
  partyId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  stateCode: z.string().min(1).max(50).optional(),
});

const linkItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    fromEntityType: z.string(),
    fromId: z.uuid(),
    toEntityType: z.string(),
    toId: z.uuid(),
    relationKey: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    createdBy: z.uuid().nullable(),
  })
  .meta({ id: 'RecordLink' });
const linkList = z.object({ items: z.array(linkItem) }).meta({ id: 'RecordLinkList' });

export function toRecordItem(row: CustomRecordRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    branchId: row.branchId,
    entityDefinitionId: row.entityDefinitionId,
    definitionVersion: row.definitionVersion,
    number: row.number,
    data: row.data as Record<string, unknown>,
    stateCode: row.stateCode,
    partyId: row.partyId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toLinkItem(row: RecordLinkRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    fromEntityType: row.fromEntityType,
    fromId: row.fromId,
    toEntityType: row.toEntityType,
    toId: row.toId,
    relationKey: row.relationKey,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

/** Splits the validated query into column filters and field filters (`f.<fieldKey>`). */
function toListFilter(query: Record<string, unknown>): RecordListFilter {
  const known = recordFilter.parse(query);
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(query)) {
    if (name.startsWith(RECORD_FILTER_PREFIX)) {
      fields[name.slice(RECORD_FILTER_PREFIX.length)] = value;
    }
  }
  return {
    ...(known.number === undefined ? {} : { number: known.number }),
    ...(known.partyId === undefined ? {} : { partyId: known.partyId }),
    ...(known.branchId === undefined ? {} : { branchId: known.branchId }),
    ...(known.stateCode === undefined ? {} : { stateCode: known.stateCode }),
    fields,
  };
}

export interface RecordRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  records: RecordService;
}

export function createRecordRouter(deps: RecordRouterDeps): Router {
  const { uow, registry, permissions, records } = deps;
  const router = Router();
  const keyOf = (req: Request): string => keyParams.parse(req.params).entityKey;
  const resourceOf = (key: string): string => `custom.${key}`;

  router.get('/records/:entityKey/:id/links', async (req, res) => {
    const { entityKey, id } = recordParams.parse(req.params);
    const rows = await uow.run(async () => {
      await permissions.require(`${resourceOf(entityKey)}.read`);
      return records.links(entityKey, id);
    });
    res.json({ items: rows.map(toLinkItem) });
  });

  router.post('/records/:entityKey/:id/links', async (req, res) => {
    const { entityKey, id } = recordParams.parse(req.params);
    const body = recordLinkCreateSchema.parse(req.body);
    const row = await uow.run(async () => {
      await permissions.require(`${resourceOf(entityKey)}.update`);
      return records.addLink(entityKey, id, body);
    });
    res
      .status(201)
      .setHeader('ETag', `"${String(row.version)}"`)
      .json(toLinkItem(row));
  });

  router.delete('/records/:entityKey/:id/links/:linkId', async (req, res) => {
    const { entityKey, id, linkId } = linkParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    const { reason } = deleteBody.parse(req.body ?? {});
    await uow.run(async () => {
      await permissions.require(`${resourceOf(entityKey)}.update`);
      await records.removeLink(entityKey, id, linkId, version, reason);
    });
    res.status(204).end();
  });

  router.use(
    createCrudRouter<CustomRecordRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/records/:entityKey',
        resource: (req) => resourceOf(keyOf(req)),
        tag: 'Custom records',
        repository: (req) => records.repository(keyOf(req)),
        pathParams: keyParams,
        schemas: {
          create: recordCreateSchema,
          update: recordUpdateSchema,
          item: recordItem,
          filter: recordFilter,
        },
        toItem: toRecordItem,
        toWhere: (query) => ({ ...toListFilter(query) }),
      },
    ),
  );

  const tags = ['Custom records'];
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/records/{entityKey}/{id}/links',
    tags,
    summary: 'Relations of a record, in both directions',
    request: { params: recordParams },
    responses: {
      200: { description: 'The relations', content: { 'application/json': { schema: linkList } } },
      404: problem('No such record type or record'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/records/{entityKey}/{id}/links',
    tags,
    summary: 'Relate the record to another record',
    request: {
      params: recordParams,
      body: { content: { 'application/json': { schema: recordLinkCreateSchema } } },
    },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: linkItem } } },
      400: problem('The target does not exist or is the record itself'),
      404: problem('No such record type or record'),
      409: problem('This relation already exists'),
    },
  });
  registerRoute(registry, {
    method: 'delete',
    path: '/records/{entityKey}/{id}/links/{linkId}',
    tags,
    summary: 'Remove a relation (soft delete; If-Match and a reason required)',
    request: {
      params: linkParams,
      body: { content: { 'application/json': { schema: deleteBody } } },
    },
    responses: {
      204: { description: 'Removed' },
      404: problem('No such record or relation'),
      409: problem('Version conflict'),
      428: problem('If-Match header missing'),
    },
  });

  return router;
}
