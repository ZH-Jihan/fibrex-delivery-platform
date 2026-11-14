/**
 * Access administration endpoints (PLAN 5.3).
 *
 *   GET  /me/permissions                      what I may do here (drives the web can())
 *   /roles                                    CRUD (kernel CRUD factory)
 *   GET/PUT /roles/{id}/grantable-roles       which roles holders of this role may give out
 *   GET/PUT /roles/{id}/scopes                data scope of a role in the current company
 *   GET  /permissions                         the permission catalogue
 *   GET/PUT /permission-matrix                tick boxes per role
 *   GET/PUT /users/{id}/memberships           companies and roles of a user
 *   GET/PUT /users/{id}/permission-overrides  per-user grant or deny, current company
 *   GET/PUT /users/{id}/scopes                data scope of a user, current company
 *
 * Every handler runs, in this order, inside one unit of work: the permission check; for
 * changes, a recent re-authentication (SPEC 6: sensitive actions require it); then the
 * rules and the write in ./access-admin-service.ts. If any step throws, nothing is saved.
 *
 * Depends on: express, zod, kernel/http (CRUD factory, OpenAPI), kernel/db/unit-of-work.ts,
 * ./permission-service.ts, ./access-admin-service.ts, kernel/auth/auth-service.ts
 * (re-authentication check, signing a user out after their roles change).
 * Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Access } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import { dbContextFromRequest, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { AccessAdminService, RoleRow } from './access-admin-service.js';
import type { PermissionService } from './permission-service.js';

export interface AccessAdminRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  admin: AccessAdminService;
  auth: Pick<AuthService, 'assertRecentReauth' | 'revokeAllSessionsOf'>;
}

const idParams = z.object({ id: z.uuid() });
const permissionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  .max(200);
const scopeKind = z.enum(['own', 'platform', 'zone', 'branch', 'all']);

const roleItem = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isBuiltin: z.boolean(),
    mfaRequired: z.boolean(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Role' });
const roleCreate = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  mfaRequired: z.boolean().optional(),
});
// The key is left out on purpose: it never changes after the role is created.
const roleUpdate = roleCreate.omit({ key: true }).partial();

const scopeSet = z.object({
  all: z.boolean(),
  own: z.boolean(),
  platform: z.array(z.uuid()),
  zone: z.array(z.uuid()),
  branch: z.array(z.uuid()),
});
const accessSchema = z
  .object({
    userId: z.uuid(),
    partyId: z.uuid().nullable(),
    companyId: z.uuid().nullable(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    scopes: z.array(scopeSet),
  })
  .meta({ id: 'Access' });

const roleIdsBody = z.strictObject({ roleIds: z.array(z.uuid()).max(200) });
const scopesBody = z
  .strictObject({
    scopes: z.array(z.strictObject({ scopeKind, values: z.array(z.uuid()).max(500) })).max(5),
  })
  .meta({ id: 'DataScopes' });
const permissionItem = z
  .object({
    key: z.string(),
    moduleKey: z.string(),
    resource: z.string(),
    action: z.string(),
    description: z.string(),
  })
  .meta({ id: 'Permission' });
const grant = z.object({ roleId: z.uuid(), permissionKey });
const matrixSchema = z
  .object({
    roles: z.array(
      z.object({ id: z.uuid(), key: z.string(), name: z.string(), isBuiltin: z.boolean() }),
    ),
    permissions: z.array(permissionItem),
    grants: z.array(grant),
  })
  .meta({ id: 'PermissionMatrix' });
const matrixBody = z
  .strictObject({
    changes: z
      .array(grant.extend({ granted: z.boolean() }))
      .min(1)
      .max(5000),
  })
  .meta({ id: 'PermissionMatrixChanges' });
const membership = z.strictObject({
  companyId: z.uuid(),
  roleIds: z.array(z.uuid()).max(50),
  isDefault: z.boolean(),
  status: z.enum(['active', 'suspended']),
});
const membershipsBody = z
  .strictObject({ memberships: z.array(membership).max(100) })
  .meta({ id: 'Memberships' });
const overridesBody = z
  .strictObject({
    overrides: z
      .array(
        z.strictObject({
          permissionKey,
          effect: z.enum(['grant', 'deny']),
          reason: z.string().trim().min(1).max(500).optional(),
        }),
      )
      .max(1000),
  })
  .meta({ id: 'PermissionOverrides' });

function toRoleItem(row: RoleRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isBuiltin: row.isBuiltin,
    mfaRequired: row.mfaRequired,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function createAccessAdminRouter(deps: AccessAdminRouterDeps): Router {
  const { uow, registry, permissions, admin, auth } = deps;
  const router = Router();

  /** Permission check, then (for changes) re-authentication, then the work: one transaction. */
  const perform = <T>(
    permission: string,
    work: (access: Access) => Promise<T>,
    sensitive = false,
  ): Promise<T> =>
    uow.run(async () => {
      const access = await permissions.require(permission);
      if (sensitive) await auth.assertRecentReauth();
      return work(access);
    });
  const read = perform;
  const change = <T>(permission: string, work: (access: Access) => Promise<T>) =>
    perform(permission, work, true);

  router.get('/me/permissions', async (_req, res) => {
    res.json(await permissions.current());
  });

  // ---- Roles --------------------------------------------------------------------------
  router.get('/roles/:id/grantable-roles', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ roleIds: await read('iam.role.read', () => admin.grantableRoles(id)) });
  });
  router.put('/roles/:id/grantable-roles', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { roleIds } = roleIdsBody.parse(req.body);
    res.json({
      roleIds: await change('iam.role.assign_any', (a) => admin.saveGrantableRoles(a, id, roleIds)),
    });
  });
  router.get('/roles/:id/scopes', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ scopes: await read('iam.role.read', (a) => admin.scopes(a, 'role', id)) });
  });
  router.put('/roles/:id/scopes', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { scopes } = scopesBody.parse(req.body);
    res.json({
      scopes: await change('iam.role.update', (a) => admin.saveScopes(a, 'role', id, scopes)),
    });
  });
  router.use(
    createCrudRouter<RoleRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/roles',
        resource: 'iam.role',
        tag: 'Roles',
        repository: admin.roleRepository(),
        schemas: { create: roleCreate, update: roleUpdate, item: roleItem },
        toItem: toRoleItem,
      },
    ),
  );

  // ---- Catalogue and matrix -----------------------------------------------------------
  router.get('/permissions', async (_req, res) => {
    res.json({ items: await read('iam.permission_matrix.read', () => admin.catalogue()) });
  });
  router.get('/permission-matrix', async (_req, res) => {
    res.json(await read('iam.permission_matrix.read', () => admin.matrix()));
  });
  router.put('/permission-matrix', async (req, res) => {
    const { changes } = matrixBody.parse(req.body);
    res.json(await change('iam.permission_matrix.update', (a) => admin.saveMatrix(a, changes)));
  });

  // ---- A user's access ----------------------------------------------------------------
  router.get('/users/:id/memberships', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ memberships: await read('iam.user.read', () => admin.memberships(id)) });
  });
  router.put('/users/:id/memberships', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { memberships } = membershipsBody.parse(req.body);
    // Two steps. First, in the session's own scope: permission, re-authentication, and
    // which companies this save has to write in (see membershipCompanies for why that can
    // be more than the session's company, and for whom). Then the save itself, in a
    // transaction opened for exactly those companies, with the permission and every rule
    // checked again inside it.
    const companyIds = await change('iam.user.manage_access', (a) =>
      admin.membershipCompanies(a, id, memberships),
    );
    const saved = await uow.runAs({ ...dbContextFromRequest(), companyIds }, async () =>
      admin.saveMemberships(await permissions.require('iam.user.manage_access'), id, memberships),
    );
    // Their tokens name the old company and roles (and may predate a role that demands
    // two-step verification), so they sign in again. Done after the change has committed,
    // because each session is ended in its own company's scope.
    if (saved.changed) await auth.revokeAllSessionsOf(id, 'access_changed');
    res.json({ memberships: saved.memberships });
  });
  router.get('/users/:id/permission-overrides', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ overrides: await read('iam.user.read', (a) => admin.overrides(a, id)) });
  });
  router.put('/users/:id/permission-overrides', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { overrides } = overridesBody.parse(req.body);
    res.json({
      overrides: await change('iam.user.manage_access', (a) =>
        admin.saveOverrides(a, id, overrides),
      ),
    });
  });
  router.get('/users/:id/scopes', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ scopes: await read('iam.user.read', (a) => admin.scopes(a, 'user', id)) });
  });
  router.put('/users/:id/scopes', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { scopes } = scopesBody.parse(req.body);
    res.json({
      scopes: await change('iam.user.manage_access', (a) =>
        admin.saveScopes(a, 'user', id, scopes),
      ),
    });
  });

  // ---- OpenAPI ------------------------------------------------------------------------
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const denied = problem('Not allowed, or re-authentication is required (code reauth_required)');
  /** Documents a GET and, when a body schema is given, the PUT that replaces the same thing. */
  const document = (
    path: string,
    tag: string,
    what: string,
    result: z.ZodType,
    body?: z.ZodType,
  ): void => {
    const params = path.includes('{id}') ? { params: idParams } : {};
    registerRoute(registry, {
      method: 'get',
      path,
      tags: [tag],
      summary: `Read ${what}`,
      request: params,
      responses: { 200: json(what, result), 403: denied },
    });
    if (body === undefined) return;
    registerRoute(registry, {
      method: 'put',
      path,
      tags: [tag],
      summary: `Replace ${what}`,
      request: { ...params, body: { content: { 'application/json': { schema: body } } } },
      responses: {
        200: json('Saved', result),
        403: denied,
        422: problem('A rule refused the change'),
      },
    });
  };
  document(
    '/me/permissions',
    'Auth',
    'my permissions and data scope in the current company',
    accessSchema,
  );
  document(
    '/roles/{id}/grantable-roles',
    'Roles',
    'the roles this role may give out',
    roleIdsBody,
    roleIdsBody,
  );
  document('/roles/{id}/scopes', 'Roles', 'the data scope of a role', scopesBody, scopesBody);
  document(
    '/permissions',
    'Permissions',
    'the permission catalogue',
    z.object({ items: z.array(permissionItem) }),
  );
  document('/permission-matrix', 'Permissions', 'the permission matrix', matrixSchema);
  registerRoute(registry, {
    method: 'put',
    path: '/permission-matrix',
    tags: ['Permissions'],
    summary: 'Tick or untick boxes of the permission matrix (only the boxes sent are changed)',
    request: { body: { content: { 'application/json': { schema: matrixBody } } } },
    responses: {
      200: json('Saved', z.object({ granted: z.number().int(), revoked: z.number().int() })),
      403: denied,
      422: problem('The change would lock you out of the matrix (code would_lock_out)'),
    },
  });
  document(
    '/users/{id}/memberships',
    'Users',
    "a user's companies and roles",
    membershipsBody,
    membershipsBody,
  );
  document(
    '/users/{id}/permission-overrides',
    'Users',
    "a user's permission overrides in the current company",
    overridesBody,
    overridesBody,
  );
  document(
    '/users/{id}/scopes',
    'Users',
    "a user's data scope in the current company",
    scopesBody,
    scopesBody,
  );

  return router;
}
