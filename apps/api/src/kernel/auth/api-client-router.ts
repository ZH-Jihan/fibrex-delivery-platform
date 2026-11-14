/**
 * API client administration (PLAN 5.3, SPEC 2.11 "API keys ... per integration").
 *
 *   /api-clients                           CRUD (kernel CRUD factory), current company
 *   GET    /api-clients/{id}/keys          the client's keys (prefix and dates, never the key)
 *   POST   /api-clients/{id}/keys          issue a key; the full key is in this answer only
 *   DELETE /api-clients/{id}/keys/{keyId}  revoke a key (works from the next request on)
 *
 * Rules enforced here on top of the plain permission, and why:
 *   1. A client's `scopes` are permission keys. Each must be in the catalogue and active,
 *      and must not be an `iam.*` key: an integration never administers identity or
 *      access (PermissionService drops such keys too, as a second line).
 *   2. You can only give a client permissions you hold yourself, so creating an
 *      integration is never a way to get more access than you have (the same idea as the
 *      7c rule for roles).
 *   3. Issuing a key needs recent re-authentication: a key is a long-lived credential.
 *      Revoking needs only the permission; stopping access should never be harder than
 *      granting it.
 *   4. Only clients of kind `api_key` are created here. OAuth client credentials
 *      (`POST /oauth/token`, kind `oauth_client`) are not built yet.
 *   5. Deleting or disabling a client stops all its keys at once (iam.resolve_api_key
 *      checks the client on every request).
 *
 * Depends on: express, zod, @fibrex/shared (can), kernel/db (repository, unit of work),
 * kernel/http (CRUD factory, errors, OpenAPI), kernel/permissions/permission-service.ts,
 * ./api-keys.ts (generateApiKey), ./auth-service.ts (re-authentication).
 * Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { can } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit } from '../db/unit-of-work.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import { generateApiKey } from './api-keys.js';
import type { AuthService } from './auth-service.js';

export interface ApiClientRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  auth: Pick<AuthService, 'assertRecentReauth'>;
}

export type ApiClientRow = NonNullable<Awaited<ReturnType<Db['apiClient']['findFirst']>>>;
type ApiKeyRow = NonNullable<Awaited<ReturnType<Db['apiKey']['findFirst']>>>;

const scopes = z.array(z.string().trim().min(1).max(128)).max(500);
const fields = {
  name: z.string().trim().min(1).max(200),
  scopes,
  rateLimitPerMinute: z.number().int().min(1).max(100_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
};
const clientCreate = z.strictObject(fields);
const clientUpdate = z.strictObject(fields).partial();
const clientFilter = z.object({ status: z.enum(['active', 'disabled']).optional() });
const clientItem = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind: z.string(),
    scopes: z.array(z.string()),
    rateLimitPerMinute: z.number().int(),
    status: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ApiClient' });

const keyItem = z
  .object({
    id: z.uuid(),
    keyPrefix: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ApiKey' });
const issuedKey = keyItem.extend({ key: z.string() }).meta({ id: 'IssuedApiKey' });
const keyCreate = z.strictObject({
  expiresAt: z.iso
    .datetime()
    .refine((v) => Date.parse(v) > Date.now(), { message: 'Must be in the future' })
    .optional(),
});

const idParams = z.object({ id: z.uuid() });
const keyParams = z.object({ id: z.uuid(), keyId: z.uuid() });

function toClientItem(row: ApiClientRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scopes: [...row.scopes].sort(),
    rateLimitPerMinute: row.rateLimitPerMinute,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

function toKeyItem(row: ApiKeyRow) {
  return {
    id: row.id,
    keyPrefix: row.keyPrefix,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The repository behind `/api-clients` and the recycle bin. Adds rules 1, 2 and 4 to every
 * write, so no route to a client's row can skip them.
 */
export function createApiClientRepository(deps: {
  permissions: PermissionService;
}): Repository<ApiClientRow> {
  const base = createRepository<ApiClientRow>({ model: 'apiClient', scope: 'company' });

  const checkScopes = async (wanted: unknown): Promise<string[] | undefined> => {
    if (wanted === undefined) return undefined;
    const keys = [...new Set(wanted as string[])].sort();
    // Rule 1: known, active, not identity administration.
    const known = await currentUnit().db.permission.findMany({
      where: { key: { in: keys }, isActive: true },
      select: { key: true },
    });
    const knownKeys = new Set(known.map((p) => p.key));
    const bad = keys.filter((k) => !knownKeys.has(k) || k.startsWith('iam.'));
    if (bad.length > 0) {
      throw new ValidationError(
        bad.map((k) => ({
          path: 'scopes',
          code: k.startsWith('iam.') ? 'not_allowed' : 'unknown_permission',
          message: k.startsWith('iam.')
            ? `${k}: integrations cannot be given identity or access permissions`
            : `${k}: no such permission`,
        })),
      );
    }
    // Rule 2: only what the caller holds.
    const access = await deps.permissions.current();
    const notHeld = keys.filter((k) => !can(access, k));
    if (notHeld.length > 0) {
      throw new ForbiddenError(
        `You cannot give permissions you do not hold: ${notHeld.join(', ')}`,
      );
    }
    return keys;
  };

  return {
    ...base,
    create: async (data) => {
      const checked = await checkScopes(data.scopes);
      // Rule 4.
      return base.create({ ...data, scopes: checked ?? [], kind: 'api_key' });
    },
    update: async (id, version, changes) => {
      const checked = await checkScopes(changes.scopes);
      return base.update(id, version, {
        ...changes,
        ...(checked === undefined ? {} : { scopes: checked }),
      });
    },
  };
}

export function createApiClientRouter(deps: ApiClientRouterDeps): Router {
  const { uow, registry, permissions, auth } = deps;
  const router = Router();
  const repository = createApiClientRepository({ permissions });

  /** 404 unless the client exists (and is visible: same company, not deleted). */
  const assertClient = async (db: Db, id: string): Promise<void> => {
    const client = await db.apiClient.findFirst({ where: { id }, select: { id: true } });
    if (client === null) throw new NotFoundError();
  };

  router.get('/api-clients/:id/keys', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const items = await uow.run(async (db) => {
      await permissions.require('iam.api_client.read');
      await assertClient(db, id);
      const rows = await db.apiKey.findMany({
        where: { apiClientId: id },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toKeyItem);
    });
    res.json({ items });
  });

  router.post('/api-clients/:id/keys', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = keyCreate.parse(req.body ?? {});
    const issued = await uow.run(async (db) => {
      await permissions.require('iam.api_client.manage_keys');
      await auth.assertRecentReauth(); // Rule 3.
      await assertClient(db, id);
      const fresh = generateApiKey();
      const { tenantId, companyIds } = currentUnit().context;
      const companyId = companyIds[0];
      if (companyId === undefined) throw new ForbiddenError();
      const row = await db.apiKey.create({
        data: {
          tenantId,
          companyId,
          apiClientId: id,
          keyPrefix: fresh.keyPrefix,
          keyHash: fresh.keyHash,
          expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt),
        },
      });
      return { ...toKeyItem(row), key: fresh.key };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(issued);
  });

  router.delete('/api-clients/:id/keys/:keyId', async (req, res) => {
    const { id, keyId } = keyParams.parse(req.params);
    await uow.run(async (db) => {
      await permissions.require('iam.api_client.manage_keys');
      const key = await db.apiKey.findFirst({ where: { id: keyId, apiClientId: id } });
      if (key === null) throw new NotFoundError();
      // Revoking twice is fine: the first time counts.
      await db.apiKey.updateMany({
        where: { id: keyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    res.status(204).end();
  });

  router.use(
    createCrudRouter<ApiClientRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/api-clients',
        resource: 'iam.api_client',
        tag: 'API clients',
        repository,
        schemas: {
          create: clientCreate,
          update: clientUpdate,
          item: clientItem,
          filter: clientFilter,
        },
        toItem: toClientItem,
        toWhere: (filter) => (typeof filter.status === 'string' ? { status: filter.status } : {}),
      },
    ),
  );

  // ---- OpenAPI ------------------------------------------------------------------------
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/api-clients/{id}/keys',
    tags: ['API clients'],
    summary: "A client's keys (never the key itself)",
    request: { params: idParams },
    responses: {
      200: json('Keys', z.object({ items: z.array(keyItem) })),
      404: problem('No such client'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/api-clients/{id}/keys',
    tags: ['API clients'],
    summary:
      'Issue a key (needs recent re-authentication). The key is shown in this answer only; ' +
      'send it as "Authorization: Bearer <key>".',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: keyCreate } } },
    },
    responses: {
      201: json('Issued', issuedKey),
      403: problem('Missing permission or re-authentication'),
      404: problem('No such client'),
    },
  });
  registerRoute(registry, {
    method: 'delete',
    path: '/api-clients/{id}/keys/{keyId}',
    tags: ['API clients'],
    summary: 'Revoke a key; it stops working on the next request',
    request: { params: keyParams },
    responses: { 204: { description: 'Revoked' }, 404: problem('No such key') },
  });

  return router;
}
