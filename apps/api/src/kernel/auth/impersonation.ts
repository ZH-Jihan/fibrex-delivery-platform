/**
 * Impersonation (SPEC 1: "Super Admin can impersonate a user for support; impersonated
 * actions are logged with both identities"; PLAN 5.3).
 *
 *   POST   /impersonations           start acting as a user; returns a separate access token
 *   DELETE /impersonations/current   stop (called with that token)
 *
 * How it works, and why:
 *   1. Starting needs `iam.user.impersonate`, a recent re-authentication, and the right to
 *      manage the target (the 7c rule: every role they hold must be one you may give out,
 *      and never yourself). So nobody can borrow an account more powerful than their own.
 *   2. The target must be an active user and an active member of the administrator's
 *      current company; the impersonation happens in that company only.
 *   3. A row in iam.impersonation records who, whom, why and when, and a new session of
 *      the target is opened pointing at it. The administrator's own session is not touched:
 *      the web app keeps its token and returns to it when the impersonation ends.
 *   4. The token says `sub` = target and `imp` = administrator. Authentication puts the
 *      administrator into `impersonatorId`, the unit of work sets `app.impersonator_id`, and
 *      the audit trigger stamps both on every change made meanwhile.
 *   5. The token cannot be refreshed and lives AUTH_IMPERSONATION_TTL_SECONDS at most.
 *      Ending it (or locking or signing out the administrator, see
 *      AuthService.revokeAllSessionsOf) revokes its session at once.
 *   6. What the token may not reach is decided in ./authenticate.ts (step 7).
 *
 * Depends on: express, zod, kernel/db, kernel/http (errors, OpenAPI), kernel/context,
 * kernel/permissions (PermissionService, AccessAdminService), ./access-token.ts,
 * ./auth-service.ts (re-authentication, ending a session).
 * Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { requireContext } from '../context/request-context.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { AccessAdminService } from '../permissions/access-admin-service.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { AccessTokens } from './access-token.js';
import type { AuthService } from './auth-service.js';

export interface ImpersonationDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  admin: AccessAdminService;
  auth: Pick<AuthService, 'assertRecentReauth' | 'revokeSession'>;
  tokens: AccessTokens;
  env: Pick<Env, 'AUTH_IMPERSONATION_TTL_SECONDS'>;
}

const startBody = z.strictObject({
  userId: z.uuid(),
  reason: z.string().trim().min(5).max(500),
});

const started = z
  .object({
    impersonationId: z.uuid(),
    accessToken: z.string(),
    expiresIn: z.number().int(),
    user: z.object({ id: z.uuid(), username: z.string(), displayName: z.string() }),
    companyId: z.uuid(),
    roles: z.array(z.string()),
  })
  .meta({ id: 'ImpersonationStarted' });

/** The signed-in administrator, refused when already impersonating. */
function realUser() {
  const ctx = requireContext();
  const principal = ctx.principal;
  if (principal?.kind !== 'user' || ctx.sessionId === undefined) {
    throw new ForbiddenError('Only a signed-in user can do this');
  }
  if (principal.impersonatorId !== undefined) {
    throw new ForbiddenError('You are already acting as another user');
  }
  return { userId: principal.userId, tenantId: principal.tenantId, ip: ctx.ip };
}

export function createImpersonationRouter(deps: ImpersonationDeps): Router {
  const { uow, registry, permissions, admin, auth, tokens, env } = deps;
  const router = Router();

  router.post('/impersonations', async (req, res) => {
    const input = startBody.parse(req.body);
    const actor = realUser();
    const companyId = requireContext().companyIds[0];
    if (companyId === undefined) throw new ForbiddenError('Choose a company first');
    const ttlSeconds = env.AUTH_IMPERSONATION_TTL_SECONDS;

    const result = await uow.run(async (db) => {
      // Rule 1, cheapest checks first; each throws 403.
      const access = await permissions.require('iam.user.impersonate');
      await admin.assertCanManageUser(access, input.userId);
      await auth.assertRecentReauth();

      // Rule 2.
      const target = await db.userAccount.findFirst({
        where: { id: input.userId, status: 'active' },
      });
      if (target === null) throw new NotFoundError();
      const membership = await db.companyMembership.findFirst({
        where: { userId: target.id, companyId, status: 'active' },
        include: {
          roles: { where: { deletedAt: null, role: { deletedAt: null } }, include: { role: true } },
        },
      });
      if (membership === null) {
        throw new ForbiddenError('This user does not work in your current company');
      }
      const roleKeys = membership.roles.map((r) => r.role.key).sort();

      // Rule 3: the record, then the target's session that points at it.
      const impersonation = await db.impersonation.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          targetUserId: target.id,
          reason: input.reason,
        },
      });
      const session = await db.session.create({
        data: {
          tenantId: actor.tenantId,
          userId: target.id,
          companyId,
          impersonationId: impersonation.id,
          ip: actor.ip ?? null,
          userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
        },
      });

      // Rules 4 and 5.
      const accessToken = tokens.issue({
        userId: target.id,
        tenantId: actor.tenantId,
        sessionId: session.id,
        companyId,
        roleKeys,
        mustChangePassword: false,
        impersonatorId: actor.userId,
        ttlSeconds,
      });
      return {
        impersonationId: impersonation.id,
        accessToken,
        expiresIn: ttlSeconds,
        user: { id: target.id, username: target.username, displayName: target.displayName },
        companyId,
        roles: roleKeys,
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  });

  router.delete('/impersonations/current', async (_req, res) => {
    const ctx = requireContext();
    const principal = ctx.principal;
    const sessionId = ctx.sessionId;
    if (
      principal?.kind !== 'user' ||
      principal.impersonatorId === undefined ||
      sessionId === undefined
    ) {
      throw new ConflictError('not_impersonating', 'You are not acting as another user');
    }
    const actorId = principal.impersonatorId;
    // Runs as the target with the administrator as impersonator, so the audit rows of
    // ending it carry both identities like everything else done in it.
    await uow.run(async (db) => {
      const session = await db.session.findFirst({
        where: { id: sessionId },
        select: { impersonationId: true },
      });
      if (session?.impersonationId != null) {
        await db.impersonation.updateMany({
          where: { id: session.impersonationId, endedAt: null },
          data: { endedAt: new Date() },
        });
      }
      await auth.revokeSession(db, sessionId, actorId, 'impersonation_ended');
    });
    res.status(204).end();
  });

  // ---- OpenAPI ------------------------------------------------------------------------
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/impersonations',
    tags: ['Users'],
    summary:
      'Act as a user of your current company (needs recent re-authentication). Returns a ' +
      'separate access token; your own session is unchanged.',
    request: { body: { content: { 'application/json': { schema: startBody } } } },
    responses: {
      201: { description: 'Started', content: { 'application/json': { schema: started } } },
      403: problem('Not allowed: permission, re-authentication, or a user you may not manage'),
      404: problem('No such active user'),
    },
  });
  registerRoute(registry, {
    method: 'delete',
    path: '/impersonations/current',
    tags: ['Users'],
    summary: 'Stop acting as another user (call with the impersonation token)',
    responses: {
      204: { description: 'Ended; the impersonation token no longer works' },
      409: problem('This token is not an impersonation'),
    },
  });

  return router;
}
