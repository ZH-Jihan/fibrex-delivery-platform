/**
 * Entity builder API (phase 2 plan row 2.4): record types and their fields.
 *
 *   /entity-definitions                     CRUD (kernel CRUD factory): the record types
 *   POST /entity-definitions/{id}/publish   make the drafted changes the next version
 *   GET  /entity-definitions/{id}/versions  the published versions, newest first
 *   /field-definitions                      CRUD: the fields; filter by entityDefinitionId
 *   GET  /entities/{key}                    the published definition (any signed-in user:
 *                                           forms and lists are drawn from it)
 *   POST /entities/{key}/validate           check data against the published definition
 *
 * The plan names the fields route `/entity-definitions/:id/fields`; fields are served flat
 * (`/field-definitions?entityDefinitionId=`), as lookup values are, so the one CRUD factory
 * gives them the same behaviour as every other resource.
 *
 * Rules on top of the plain permissions, and why:
 *   1. A record type's key, and a field's key, type, list and referenced type, never change:
 *      stored records are keyed by the field key and typed by the field type. (They are not
 *      in the update bodies, so sending one is a 400.)
 *   2. Every name and label needs English (the fallback of every other language).
 *   3. A dropdown or multi-select must name a live lookup list and no other type may; an
 *      `entity_ref` must name a record type and no other type may.
 *   4. Validations must fit the field type (shared `parseFieldValidations`).
 *   5. Any change marks the record type as having unpublished changes; nothing reaches
 *      users until it is published (see entity-definition-service.ts).
 *   6. A field that was ever published is retired, never deleted: records still hold its
 *      values. Only a draft field can be deleted. `status` can only move between published
 *      and retired.
 *   7. A built-in ("system") record type is created by its module: it cannot be created,
 *      renamed or deleted here. A custom type cannot be deleted while a field of another
 *      type refers to it, or while it has records (they would become unreachable).
 *
 * Depends on: express, zod, @fibrex/shared entities and lookups, kernel/db, kernel/http,
 * kernel/permissions, ./entity-definition-service.
 * Used by: src/main.ts, the recycle bin (both repositories).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  FIELD_STATUSES,
  FIELD_TYPES,
  entityKeyPattern,
  fieldKeyPattern,
  labelsProblem,
  labelsSchema,
  layoutSchema,
  listConfigSchema,
  parseFieldValidations,
  sequenceKeyPattern,
  systemEntityKeyPattern,
  type FieldType,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { VersionConflictError } from '../db/optimistic-lock.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../http/crud-router.js';
import { ConflictError, UnprocessableError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type {
  EntityDefinitionRow,
  EntityDefinitionService,
  FieldDefinitionRow,
} from './entity-definition-service.js';

const jsonObject = z.record(z.string(), z.unknown());
const numberingKey = z.string().trim().regex(sequenceKeyPattern).nullable();

const entityCreate = z.strictObject({
  key: z.string().trim().regex(entityKeyPattern, 'lower-case letters, digits and _'),
  name: labelsSchema,
  listConfig: listConfigSchema.default({ columns: [] }),
  formLayout: layoutSchema.default({ sections: [] }),
  detailLayout: layoutSchema.default({ sections: [] }),
  numberingKey: numberingKey.default(null),
});
const entityUpdate = z
  .strictObject({
    name: labelsSchema,
    listConfig: listConfigSchema,
    formLayout: layoutSchema,
    detailLayout: layoutSchema,
    numberingKey,
  })
  .partial();
const entityItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: labelsSchema,
    kind: z.enum(['system', 'custom']),
    jsonSchema: jsonObject,
    listConfig: jsonObject,
    formLayout: jsonObject,
    detailLayout: jsonObject,
    numberingKey: z.string().nullable(),
    stateMachineId: z.uuid().nullable(),
    permissionModuleKey: z.string(),
    status: z.enum(['draft', 'published']),
    publishedVersion: z.number().int(),
    publishedAt: z.iso.datetime().nullable(),
    hasUnpublishedChanges: z.boolean(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'EntityDefinition' });
const entityFilter = z.object({
  kind: z.enum(['system', 'custom']).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);
const fieldCreate = z.strictObject({
  entityDefinitionId: z.uuid(),
  key: z.string().trim().regex(fieldKeyPattern, 'lower-case letters, digits and _'),
  label: labelsSchema,
  type: z.enum(FIELD_TYPES),
  validations: jsonObject.default({}),
  lookupTypeId: z.uuid().nullable().default(null),
  refEntityKey: z.string().trim().nullable().default(null),
  required: z.boolean().default(false),
  sortOrder: sortOrder.default(0),
});
const fieldUpdate = z
  .strictObject({
    label: labelsSchema,
    validations: jsonObject,
    required: z.boolean(),
    sortOrder,
    status: z.enum(['published', 'retired']),
  })
  .partial();
const fieldItem = z
  .object({
    id: z.uuid(),
    entityDefinitionId: z.uuid(),
    key: z.string(),
    label: labelsSchema,
    type: z.enum(FIELD_TYPES),
    validations: jsonObject,
    lookupTypeId: z.uuid().nullable(),
    refEntityKey: z.string().nullable(),
    required: z.boolean(),
    sortOrder: z.number().int(),
    promotedColumn: z.string().nullable(),
    status: z.enum(FIELD_STATUSES),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'FieldDefinition' });
const fieldFilter = z.object({
  entityDefinitionId: z.uuid().optional(),
  status: z.enum(FIELD_STATUSES).optional(),
});

const versionList = z
  .object({
    items: z.array(
      z.object({
        versionNo: z.number().int(),
        publishedAt: z.iso.datetime(),
        publishedBy: z.uuid().nullable(),
        definition: jsonObject,
        jsonSchema: jsonObject,
      }),
    ),
  })
  .meta({ id: 'EntityDefinitionVersionList' });
const publishedItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    kind: z.string(),
    permissionModuleKey: z.string(),
    version: z.number().int(),
    publishedAt: z.iso.datetime().nullable(),
    name: labelsSchema,
    listConfig: jsonObject,
    formLayout: jsonObject,
    detailLayout: jsonObject,
    numberingKey: z.string().nullable(),
    fields: z.array(jsonObject),
    jsonSchema: jsonObject,
  })
  .meta({ id: 'PublishedEntity' });
const validateBody = z.strictObject({ data: z.unknown(), previous: jsonObject.optional() });
const validateResult = z
  .object({
    valid: z.boolean(),
    issues: z.array(z.object({ path: z.string(), message: z.string(), code: z.string() })),
  })
  .meta({ id: 'RecordValidation' });

export function toEntityItem(row: EntityDefinitionRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name as Record<string, string>,
    kind: row.kind,
    jsonSchema: row.jsonSchema as Record<string, unknown>,
    listConfig: row.listConfig as Record<string, unknown>,
    formLayout: row.formLayout as Record<string, unknown>,
    detailLayout: row.detailLayout as Record<string, unknown>,
    numberingKey: row.numberingKey,
    stateMachineId: row.stateMachineId,
    permissionModuleKey: row.permissionModuleKey,
    status: row.status,
    publishedVersion: row.publishedVersion,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toFieldItem(row: FieldDefinitionRow) {
  return {
    id: row.id,
    entityDefinitionId: row.entityDefinitionId,
    key: row.key,
    label: row.label as Record<string, string>,
    type: row.type,
    validations: row.validations as Record<string, unknown>,
    lookupTypeId: row.lookupTypeId,
    refEntityKey: row.refEntityKey,
    required: row.required,
    sortOrder: row.sortOrder,
    promotedColumn: row.promotedColumn,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const invalid = (path: string, message: string, code: string) =>
  new ValidationError([{ path, message, code }]);

/** Rule 2. */
function checkLabels(path: string, labels: Record<string, string>): void {
  const problem = labelsProblem(labels);
  if (problem !== null) throw invalid(path, problem, 'english_label_required');
}

/** Rule 4: the validations as stored (unknown keys and wrong limits are refused). */
function checkedValidations(type: FieldType, raw: unknown): Record<string, unknown> {
  const parsed = parseFieldValidations(type, raw);
  if (!parsed.ok) throw invalid('validations', parsed.message, 'invalid_validations');
  return parsed.value;
}

/**
 * Rule 5: flags the record type as changed since its last publish. Only a row not yet
 * flagged is written, so a run of field edits touches the definition once.
 */
async function markChanged(entityDefinitionId: string): Promise<void> {
  const { db } = currentUnit();
  await db.entityDefinition.updateMany({
    where: { id: entityDefinitionId, hasUnpublishedChanges: false },
    data: { hasUnpublishedChanges: true },
  });
}

/** The repository behind `/entity-definitions` and the recycle bin; adds rules 2, 5 and 7. */
export function createEntityDefinitionRepository(
  entities: EntityDefinitionService,
): Repository<EntityDefinitionRow> {
  const base = createRepository<EntityDefinitionRow>({
    model: 'entityDefinition',
    scope: 'tenant',
  });
  return {
    ...base,
    list: async (options) => {
      // Built-in record types appear for a tenant the first time anyone lists them.
      await entities.ensureSystemEntities();
      return base.list({ ...options, orderBy: options.orderBy ?? [{ key: 'asc' }] });
    },
    create: (data) => {
      const body = data as z.infer<typeof entityCreate>;
      checkLabels('name', body.name);
      // Permissions of custom record types are `custom.<key>.<action>` (row 2.5).
      return base.create({
        ...body,
        kind: 'custom',
        permissionModuleKey: 'custom',
        hasUnpublishedChanges: true,
      });
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof entityUpdate>;
      if (body.name !== undefined) {
        checkLabels('name', body.name);
        const current = await base.get(id);
        if (current.kind === 'system') {
          throw new UnprocessableError(
            'system_entity',
            'A built-in record type is named by its module and cannot be renamed.',
          );
        }
      }
      const changed = Object.keys(body).length > 0;
      return base.update(id, version, changed ? { ...body, hasUnpublishedChanges: true } : body);
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.kind === 'system') {
        throw new UnprocessableError(
          'system_entity',
          'A built-in record type cannot be deleted; retire its custom fields instead.',
        );
      }
      const { db } = currentUnit();
      const referring = await db.fieldDefinition.count({
        where: {
          refEntityKey: current.key,
          deletedAt: null,
          entityDefinitionId: { not: id },
          entity: { deletedAt: null },
        },
      });
      if (referring > 0) {
        throw new ConflictError(
          'entity_definition_in_use',
          'Fields of other record types refer to this one; remove or retire them first.',
          { fields: referring },
        );
      }
      const records = await db.customRecord.count({ where: { entityDefinitionId: id } });
      if (records > 0) {
        throw new ConflictError(
          'entity_definition_in_use',
          'This record type has records; delete them first.',
          { records },
        );
      }
      return base.softDelete(id, version, reason);
    },
  };
}

/** The repository behind `/field-definitions` and the recycle bin; adds rules 2 to 6. */
export function createFieldDefinitionRepository(): Repository<FieldDefinitionRow> {
  const base = createRepository<FieldDefinitionRow>({ model: 'fieldDefinition', scope: 'tenant' });
  return {
    ...base,
    list: (options) =>
      base.list({ ...options, orderBy: options.orderBy ?? [{ sortOrder: 'asc' }, { key: 'asc' }] }),
    create: async (data) => {
      const body = data as z.infer<typeof fieldCreate>;
      checkLabels('label', body.label);
      const { db } = currentUnit();
      const entity = await db.entityDefinition.findFirst({
        where: { id: body.entityDefinitionId, deletedAt: null },
        select: { id: true },
      });
      if (entity === null) {
        throw invalid('entityDefinitionId', 'This record type does not exist.', 'unknown_entity');
      }
      // Rule 3, lists.
      const needsList = body.type === 'dropdown' || body.type === 'multi';
      if (needsList !== (body.lookupTypeId !== null)) {
        throw invalid(
          'lookupTypeId',
          needsList
            ? 'Choose the list of this field.'
            : 'Only dropdown and multi fields have a list.',
          needsList ? 'lookup_type_required' : 'lookup_type_not_allowed',
        );
      }
      if (body.lookupTypeId !== null) {
        const list = await db.lookupType.findFirst({
          where: { id: body.lookupTypeId, deletedAt: null },
          select: { id: true },
        });
        if (list === null) {
          throw invalid('lookupTypeId', 'This list does not exist.', 'unknown_lookup_type');
        }
      }
      // Rule 3, references. The target may be created later; publish checks that it exists.
      const isRef = body.type === 'entity_ref';
      if (isRef !== (body.refEntityKey !== null)) {
        throw invalid(
          'refEntityKey',
          isRef
            ? 'Choose the record type this field refers to.'
            : 'Only reference fields name a record type.',
          isRef ? 'ref_entity_required' : 'ref_entity_not_allowed',
        );
      }
      if (
        body.refEntityKey !== null &&
        !entityKeyPattern.test(body.refEntityKey) &&
        !systemEntityKeyPattern.test(body.refEntityKey)
      ) {
        throw invalid('refEntityKey', 'This is not a record type key.', 'invalid_ref_entity');
      }
      const validations = checkedValidations(body.type, body.validations);
      const row = await base.create({ ...body, validations, status: 'draft' });
      await markChanged(row.entityDefinitionId);
      return row;
    },
    update: async (id, version, changes) => {
      const body = changes as z.infer<typeof fieldUpdate>;
      const current = await base.get(id);
      if (body.label !== undefined) checkLabels('label', body.label);
      const next: Record<string, unknown> = { ...body };
      if (body.validations !== undefined) {
        next.validations = checkedValidations(current.type as FieldType, body.validations);
      }
      // Rule 6: a draft field has no status to choose; it becomes published by publishing.
      if (
        body.status !== undefined &&
        body.status !== current.status &&
        current.status === 'draft'
      ) {
        throw new UnprocessableError(
          'field_not_published',
          'A draft field is published with its record type; delete it if it is not wanted.',
        );
      }
      const row = await base.update(id, version, next);
      await markChanged(row.entityDefinitionId);
      return row;
    },
    softDelete: async (id, version, reason) => {
      const current = await base.get(id);
      if (current.status !== 'draft') {
        throw new UnprocessableError(
          'field_in_use',
          'Records may hold values of this field; retire it instead of deleting it.',
        );
      }
      const row = await base.softDelete(id, version, reason);
      await markChanged(row.entityDefinitionId);
      return row;
    },
    restore: async (id, version) => {
      const row = await base.restore(id, version);
      await markChanged(row.entityDefinitionId);
      return row;
    },
  };
}

export interface EntityDefinitionRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  entities: EntityDefinitionService;
}

export function createEntityDefinitionRouter(deps: EntityDefinitionRouterDeps): Router {
  const { uow, registry, permissions, entities } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };
  const repository = createEntityDefinitionRepository(entities);
  const idParams = z.object({ id: z.uuid() });
  const keyParams = z.object({
    key: z.string().refine((k) => entityKeyPattern.test(k) || systemEntityKeyPattern.test(k)),
  });

  router.post('/entity-definitions/:id/publish', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    try {
      const row = await uow.run(async () => {
        await permissions.require('platform.entity_definition.publish');
        return entities.publish(id, version);
      });
      res
        .status(200)
        .setHeader('ETag', `"${String(row.version)}"`)
        .json(toEntityItem(row));
    } catch (err) {
      if (err instanceof VersionConflictError) {
        throw err.presentedWith((row) => toEntityItem(row as unknown as EntityDefinitionRow));
      }
      throw err;
    }
  });

  router.get('/entity-definitions/:id/versions', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const rows = await uow.run(async () => {
      await permissions.require('platform.entity_definition.read');
      await repository.get(id);
      return currentUnit().db.entityDefinitionVersion.findMany({
        where: { entityDefinitionId: id },
        orderBy: [{ versionNo: 'desc' }],
      });
    });
    res.json({
      items: rows.map((row) => ({
        versionNo: row.versionNo,
        publishedAt: row.createdAt.toISOString(),
        publishedBy: row.createdBy,
        definition: row.definition,
        jsonSchema: row.jsonSchema,
      })),
    });
  });

  router.get('/entities/:key', async (req, res) => {
    const { key } = keyParams.parse(req.params);
    res.json(await uow.run(() => entities.published(key)));
  });

  router.post('/entities/:key/validate', async (req, res) => {
    const { key } = keyParams.parse(req.params);
    const body = validateBody.parse(req.body);
    const issues = await uow.run(() =>
      entities.validate(
        key,
        body.data,
        body.previous === undefined ? {} : { previous: body.previous },
      ),
    );
    res.json({ valid: issues.length === 0, issues });
  });

  router.use(
    createCrudRouter<EntityDefinitionRow>(crud, {
      path: '/entity-definitions',
      resource: 'platform.entity_definition',
      tag: 'Entity builder',
      repository,
      schemas: {
        create: entityCreate,
        update: entityUpdate,
        item: entityItem,
        filter: entityFilter,
      },
      toItem: toEntityItem,
      toWhere: (filter) => filter,
    }),
  );
  router.use(
    createCrudRouter<FieldDefinitionRow>(crud, {
      path: '/field-definitions',
      resource: 'platform.field_definition',
      tag: 'Entity builder',
      repository: createFieldDefinitionRepository(),
      schemas: { create: fieldCreate, update: fieldUpdate, item: fieldItem, filter: fieldFilter },
      toItem: toFieldItem,
      toWhere: (filter) => filter,
    }),
  );

  const tags = ['Entity builder'];
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const ok = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/entity-definitions/{id}/publish',
    tags,
    summary: 'Publish the drafted changes as the next version (If-Match required)',
    request: { params: idParams },
    responses: {
      200: ok('The published record type', entityItem),
      404: problem('No such record type'),
      409: problem('Version conflict'),
      422: problem('Nothing to publish, no fields, or a field points to something deleted'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/entity-definitions/{id}/versions',
    tags,
    summary: 'The published versions of a record type, newest first',
    request: { params: idParams },
    responses: { 200: ok('The versions', versionList), 404: problem('No such record type') },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/entities/{key}',
    tags,
    summary: 'The published definition of a record type (fields, layouts, JSON Schema)',
    request: { params: keyParams },
    responses: {
      200: ok('The definition', publishedItem),
      404: problem('No such record type, or never published'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/entities/{key}/validate',
    tags,
    summary: 'Check record data against the published definition without saving it',
    request: {
      params: keyParams,
      body: { content: { 'application/json': { schema: validateBody } } },
    },
    responses: {
      200: ok('Whether the data is valid, with every problem found', validateResult),
      404: problem('No such record type, or never published'),
    },
  });

  return router;
}
