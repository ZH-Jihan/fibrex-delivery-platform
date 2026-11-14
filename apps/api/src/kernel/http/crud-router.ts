/**
 * Generic CRUD controller factory.
 *
 * Purpose: gives a module the standard REST endpoints for one resource from a few lines of
 * configuration, so list, read, create, update, delete and restore behave the same
 * everywhere and the shared rules cannot be skipped:
 *
 *   GET    /things               list (page, pageSize, deleted=true for the recycle bin)
 *   GET    /things/{id}          read one              -> ETag: "<version>"
 *   POST   /things               create                -> 201, ETag
 *   PATCH  /things/{id}          update, If-Match      -> ETag
 *   DELETE /things/{id}          soft delete, If-Match (optional body { reason })
 *   POST   /things/{id}/restore  restore, If-Match
 *
 * Every handler, in this order:
 *   1. validates the input with the module's Zod schemas (the same schemas are published in
 *      the OpenAPI document, so documentation and behaviour cannot drift);
 *   2. opens a unit of work, which sets the row-level security context;
 *   3. asks the permission layer for `<resource>.<action>` inside that transaction;
 *   4. calls the repository, which enforces tenancy, optimistic locking and soft delete.
 *
 * Optimistic locking over HTTP: responses carry the row version as an ETag; a change must
 * send it back in `If-Match`. Missing header -> 428. Stale version -> 409 version_conflict
 * with the current record and the conflicting fields.
 *
 * Depends on: express, zod, ./openapi.ts, ./errors.ts, ../db/unit-of-work.ts,
 * ../db/repository.ts, ../db/optimistic-lock.ts. Used by: module routers (from commit 8).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { VersionConflictError } from '../db/optimistic-lock.js';
import { MAX_PAGE_SIZE, type BaseRow, type Repository } from '../db/repository.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { AppError, BadRequestError } from './errors.js';
import { problemSchema, registerRoute } from './openapi.js';

export type CrudAction = 'read' | 'create' | 'update' | 'delete' | 'restore';

/**
 * Permission check, supplied by IAM (commit 7). Called inside the unit of work with a key
 * such as "platform.branch.update"; throws ForbiddenError when the caller lacks it.
 */
export type Authorize = (permission: string) => Promise<void> | void;

export interface CrudDeps {
  uow: UnitOfWork;
  authorize: Authorize;
  registry: OpenAPIRegistry;
}

export interface CrudOptions<TRow extends BaseRow> {
  /** Route path under /api/v1, for example "/branches". */
  path: string;
  /** Permission prefix, for example "platform.branch". */
  resource: string;
  /** OpenAPI tag, for example "Branches". */
  tag: string;
  repository: Repository<TRow>;
  schemas: {
    /** Body of POST. */
    create: z.ZodType<Record<string, unknown>>;
    /** Body of PATCH (normally every field optional). */
    update: z.ZodType<Record<string, unknown>>;
    /** Shape of one item in responses; must carry `.meta({ id })`. */
    item: z.ZodType;
    /** Extra query parameters of the list endpoint. */
    filter?: z.ZodType<Record<string, unknown>>;
  };
  /** Maps a database row to the response item (hide internal columns here). */
  toItem: (row: TRow) => unknown;
  /** Maps validated filter parameters to a Prisma `where`. Required when `filter` is set. */
  toWhere?: (filter: Record<string, unknown>) => Record<string, unknown>;
}

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  deleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const deleteBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });

const ifMatchHeader = z.object({
  'If-Match': z.string().meta({ description: 'The record version you last read, e.g. "3"' }),
});

/** Reads the expected row version from If-Match (`"3"`, `W/"3"` or `3`). */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new AppError(
      428,
      'precondition_required',
      'Precondition required',
      'Send the version of the record you are changing in the If-Match header.',
    );
  }
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (match?.[1] === undefined) {
    throw new BadRequestError('invalid_if_match', 'If-Match must be a record version, e.g. "3".');
  }
  return Number(match[1]);
}

export function createCrudRouter<TRow extends BaseRow>(
  deps: CrudDeps,
  options: CrudOptions<TRow>,
): Router {
  const { uow, authorize, registry } = deps;
  const { path, resource, tag, repository, schemas, toItem } = options;
  const router = Router();

  /** Runs one action inside a unit of work, after the permission check. */
  async function perform<T>(action: CrudAction, work: () => Promise<T>): Promise<T> {
    try {
      return await uow.run(async () => {
        await authorize(`${resource}.${action}`);
        return work();
      });
    } catch (err) {
      // Show the current record through the module's mapping, not as a raw database row.
      if (err instanceof VersionConflictError) {
        throw err.presentedWith((row) => toItem(row as unknown as TRow));
      }
      throw err;
    }
  }

  function sendItem(res: Response, status: number, row: TRow): void {
    res
      .status(status)
      .setHeader('ETag', `"${String(row.version)}"`)
      .json(toItem(row));
  }

  const idOf = (req: Request): string => idParams.parse(req.params).id;

  router.get(path, async (req, res) => {
    const query = listQuery.parse(req.query);
    const filter = schemas.filter?.parse(req.query);
    const where = filter === undefined ? {} : (options.toWhere?.(filter) ?? {});
    const result = await perform('read', () => repository.list({ ...query, where }));
    res.json({ ...result, items: result.items.map(toItem) });
  });

  router.get(`${path}/:id`, async (req, res) => {
    const id = idOf(req);
    sendItem(res, 200, await perform('read', () => repository.get(id)));
  });

  router.post(path, async (req, res) => {
    const body = schemas.create.parse(req.body);
    sendItem(res, 201, await perform('create', () => repository.create(body)));
  });

  router.patch(`${path}/:id`, async (req, res) => {
    const id = idOf(req);
    const version = parseIfMatch(req.get('If-Match'));
    const body = schemas.update.parse(req.body);
    sendItem(res, 200, await perform('update', () => repository.update(id, version, body)));
  });

  router.delete(`${path}/:id`, async (req, res) => {
    const id = idOf(req);
    const version = parseIfMatch(req.get('If-Match'));
    const { reason } = deleteBody.parse(req.body ?? {});
    await perform('delete', () => repository.softDelete(id, version, reason));
    res.status(204).end();
  });

  router.post(`${path}/:id/restore`, async (req, res) => {
    const id = idOf(req);
    const version = parseIfMatch(req.get('If-Match'));
    sendItem(res, 200, await perform('restore', () => repository.restore(id, version)));
  });

  // ---- OpenAPI ------------------------------------------------------------------------
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const item = (description: string) => ({
    description,
    content: { 'application/json': { schema: schemas.item } },
  });
  const notFound = problem('Not found, deleted, or not visible to you');
  const conflict = problem('Version conflict (code version_conflict) or duplicate value');
  const noVersion = problem('If-Match header missing');
  const jsonBody = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
  const tags = [tag];
  const one = `${path}/{id}`;

  registerRoute(registry, {
    method: 'get',
    path,
    tags,
    summary: `List ${tag}`,
    request: {
      query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        deleted: z.enum(['true', 'false']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'One page of results',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(schemas.item),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
            }),
          },
        },
      },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: one,
    tags,
    summary: `Read one of ${tag}`,
    request: { params: idParams },
    responses: { 200: item('The record'), 404: notFound },
  });
  registerRoute(registry, {
    method: 'post',
    path,
    tags,
    summary: `Create in ${tag}`,
    request: { body: jsonBody(schemas.create) },
    responses: { 201: item('Created'), 409: conflict },
  });
  registerRoute(registry, {
    method: 'patch',
    path: one,
    tags,
    summary: `Update one of ${tag}`,
    request: { params: idParams, headers: ifMatchHeader, body: jsonBody(schemas.update) },
    responses: { 200: item('Updated'), 404: notFound, 409: conflict, 428: noVersion },
  });
  registerRoute(registry, {
    method: 'delete',
    path: one,
    tags,
    summary: `Delete one of ${tag} (soft delete; can be restored)`,
    request: { params: idParams, headers: ifMatchHeader, body: jsonBody(deleteBody) },
    responses: {
      204: { description: 'Deleted' },
      404: notFound,
      409: conflict,
      428: noVersion,
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: `${one}/restore`,
    tags,
    summary: `Restore a deleted one of ${tag}`,
    request: { params: idParams, headers: ifMatchHeader },
    responses: { 200: item('Restored'), 404: notFound, 409: conflict, 428: noVersion },
  });

  return router;
}
