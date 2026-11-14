/**
 * User administration endpoints (PLAN 5.3).
 *
 *   /users                              CRUD (kernel CRUD factory)
 *   POST /users/{id}/lock               disable the account and end its sessions
 *   POST /users/{id}/unlock             enable it again and clear failed attempts
 *   POST /users/{id}/reset-password     send the user a reset link (re-authentication needed)
 *   POST /users/{id}/force-logout       end every session of the user
 *   GET  /users/{id}/sessions           the user's active sessions
 *   GET  /users/{id}/login-history      the user's recent sign-in attempts
 *
 * A user's companies, roles, overrides and scope are in kernel/permissions/
 * access-admin-router.ts.
 *
 * Rules enforced here on top of the plain permission (see access-admin-service.ts R2, R3):
 *   - changing, deleting, restoring, locking, signing out or resetting a user needs the
 *     right to manage every role that user holds, and is never allowed on yourself;
 *   - an administrator never sets or sees a password: a new account has none, and the
 *     person chooses one through the reset link (or signs in with a phone code);
 *   - deleting or locking an account ends its sessions at once.
 * Sessions are ended after the change has committed, each in its own company's scope
 * (AuthService.revokeAllSessionsOf), which is why delete has its own handler here
 * instead of the factory's.
 *
 * Depends on: express, zod, kernel/http (CRUD factory, OpenAPI), kernel/db,
 * kernel/permissions (PermissionService, AccessAdminService), ./auth-service.ts.
 * Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Access } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter, deleteBody, parseIfMatch } from '../http/crud-router.js';
import { NotFoundError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { AccessAdminService } from '../permissions/access-admin-service.js';
import type { PermissionService } from '../permissions/permission-service.js';
import { loginEvent, sessionItem } from './auth-router.js';
import type { AuthService } from './auth-service.js';

export interface UserAdminRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  admin: AccessAdminService;
  auth: Pick<
    AuthService,
    | 'assertRecentReauth'
    | 'revokeAllSessionsOf'
    | 'adminSendPasswordReset'
    | 'listSessions'
    | 'loginHistory'
  >;
}

export type UserRow = NonNullable<Awaited<ReturnType<Db['userAccount']['findFirst']>>>;

const idParams = z.object({ id: z.uuid() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const profile = {
  displayName: z.string().trim().min(1).max(200),
  email: z.email().max(254).toLowerCase().nullable().optional(),
  phone: z
    .string()
    .regex(/^\+[1-9][0-9]{6,14}$/, { message: 'Use the international format, e.g. +97455512345' })
    .nullable()
    .optional(),
  preferredLanguage: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
};
const userCreate = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  ...profile,
});
// The username is left out on purpose: it identifies the account in the audit trail.
const userUpdate = z.strictObject(profile).partial();
const userFilter = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
const userItem = z
  .object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    partyId: z.uuid().nullable(),
    status: z.string(),
    mustChangePassword: z.boolean(),
    lockedUntil: z.iso.datetime().nullable(),
    lastLoginAt: z.iso.datetime().nullable(),
    preferredLanguage: z.string(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'User' });

function toUserItem(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    phone: row.phone,
    partyId: row.partyId,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    lockedUntil: row.lockedUntil?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    preferredLanguage: row.preferredLanguage,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/**
 * The repository behind `/users` and the recycle bin. The callers check the plain
 * permission (`iam.user.<action>`, `recycle_bin.restore`); this adds who may be touched
 * (R2/R3), so no route to a user's row can skip it.
 */
export function createUserRepository(deps: {
  permissions: PermissionService;
  admin: AccessAdminService;
}): Repository<UserRow> {
  const base = createRepository<UserRow>({ model: 'userAccount', scope: 'tenant' });
  // Joins the unit of work the caller has open.
  const assertManageable = async (userId: string): Promise<void> => {
    await deps.admin.assertCanManageUser(await deps.permissions.current(), userId);
  };
  return {
    ...base,
    update: async (id, version, changes) => {
      await assertManageable(id);
      return base.update(id, version, changes);
    },
    softDelete: async (id, version, reason) => {
      await assertManageable(id);
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      await assertManageable(id);
      return base.restore(id, version);
    },
  };
}

export function createUserAdminRouter(deps: UserAdminRouterDeps): Router {
  const { uow, registry, permissions, admin, auth } = deps;
  const router = Router();
  const repository = createUserRepository({ permissions, admin });

  /** Permission, the manage rule, optionally re-authentication, then the work. */
  const onUser = <T>(
    permission: string,
    userId: string,
    work: (db: Db, access: Access) => Promise<T>,
    sensitive = false,
  ): Promise<T> =>
    uow.run(async (db) => {
      const access = await permissions.require(permission);
      await admin.assertCanManageUser(access, userId);
      if (sensitive) await auth.assertRecentReauth();
      return work(db, access);
    });

  const setStatus = async (db: Db, id: string, data: Record<string, unknown>): Promise<UserRow> => {
    const rows = await db.userAccount.updateManyAndReturn({ where: { id }, data });
    if (rows[0] === undefined) throw new NotFoundError();
    return rows[0];
  };

  // Registered before the factory's routes, so this handler answers DELETE /users/{id}.
  router.delete('/users/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.get('If-Match'));
    const { reason } = deleteBody.parse(req.body ?? {});
    await uow.run(async () => {
      await permissions.require('iam.user.delete');
      await repository.softDelete(id, version, reason);
    });
    await auth.revokeAllSessionsOf(id, 'account_deleted');
    res.status(204).end();
  });

  router.post('/users/:id/lock', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const user = await onUser('iam.user.lock', id, (db) =>
      setStatus(db, id, { status: 'disabled' }),
    );
    await auth.revokeAllSessionsOf(id, 'account_locked');
    res.json(toUserItem(user));
  });
  router.post('/users/:id/unlock', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const user = await onUser('iam.user.lock', id, (db) =>
      setStatus(db, id, { status: 'active', lockedUntil: null, failedAttempts: 0 }),
    );
    res.json(toUserItem(user));
  });
  router.post('/users/:id/force-logout', async (req, res) => {
    const { id } = idParams.parse(req.params);
    await onUser('iam.user.lock', id, () => Promise.resolve());
    res.json({ sessionsEnded: await auth.revokeAllSessionsOf(id, 'signed_out_by_admin') });
  });
  router.post('/users/:id/reset-password', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(
      await onUser('iam.user.reset_password', id, () => auth.adminSendPasswordReset(id), true),
    );
  });
  router.get('/users/:id/sessions', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const items = await uow.run(async () => {
      await permissions.require('iam.user.read');
      return auth.listSessions(id);
    });
    res.json({ items });
  });
  router.get('/users/:id/login-history', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { limit } = historyQuery.parse(req.query);
    const items = await uow.run(async () => {
      await permissions.require('iam.user.read');
      return auth.loginHistory(limit, id);
    });
    res.json({ items });
  });

  router.use(
    createCrudRouter<UserRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/users',
        resource: 'iam.user',
        tag: 'Users',
        repository,
        schemas: { create: userCreate, update: userUpdate, item: userItem, filter: userFilter },
        toItem: toUserItem,
        toWhere: (filter) => ({
          ...(typeof filter.status === 'string' ? { status: filter.status } : {}),
          ...(typeof filter.q === 'string'
            ? {
                OR: [
                  { username: { contains: filter.q, mode: 'insensitive' } },
                  { displayName: { contains: filter.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        }),
      },
    ),
  );

  // ---- OpenAPI ------------------------------------------------------------------------
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const denied = {
    description: 'Not allowed: missing permission, your own account, or a role you may not manage',
    content: { 'application/problem+json': { schema: problemSchema } },
  };
  const action = (name: string, summary: string, result: z.ZodType) => {
    registerRoute(registry, {
      method: 'post',
      path: `/users/{id}/${name}`,
      tags: ['Users'],
      summary,
      request: { params: idParams },
      responses: { 200: json('Done', result), 403: denied },
    });
  };
  action('lock', 'Disable an account and end its sessions', userItem);
  action('unlock', 'Enable an account and clear its failed sign-in attempts', userItem);
  action(
    'force-logout',
    'End every session of a user',
    z.object({ sessionsEnded: z.number().int() }),
  );
  action(
    'reset-password',
    'Send the user a password-reset link (needs recent re-authentication)',
    z.object({ channel: z.enum(['email', 'sms']) }),
  );
  registerRoute(registry, {
    method: 'get',
    path: '/users/{id}/sessions',
    tags: ['Users'],
    summary: "A user's active sessions",
    request: { params: idParams },
    responses: { 200: json('Sessions', z.object({ items: z.array(sessionItem) })), 403: denied },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/users/{id}/login-history',
    tags: ['Users'],
    summary: "A user's recent sign-in attempts, newest first",
    request: { params: idParams, query: historyQuery },
    responses: {
      200: json('Sign-in attempts', z.object({ items: z.array(loginEvent) })),
      403: denied,
    },
  });

  return router;
}
